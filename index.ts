import { spawn } from "node:child_process";

// --- Telegram API shapes (only the fields this bot reads) ------------------
interface TgApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TgMessage {
  text?: string;
  chat: { id: number };
  from: { id: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

// --- result of one `claude -p` subprocess run ------------------------------
interface ClaudeResult {
  ok: boolean;
  result?: string;
  sessionId?: string;
  error?: string | null;
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = (process.env.ALLOWED_USER_ID || "").trim();
const WORK_DIR = (process.env.WORK_DIR || "").trim() || __dirname;
const PERMISSION_MODE = (process.env.PERMISSION_MODE || "acceptEdits").trim();

if (!BOT_TOKEN) {
  console.error("[fatal] BOT_TOKEN missing. Set it in .env");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// chatId -> claude session id, so each chat keeps one ongoing conversation
const sessions = new Map<number, string>();
// chatIds currently running a claude process (one at a time per chat)
const busy = new Set<number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tg<T = unknown>(
  method: string,
  body?: Record<string, unknown>,
): Promise<TgApiResponse<T>> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<TgApiResponse<T>>;
}

// Telegram caps a message at 4096 chars — chunk long replies.
async function sendMessage(chatId: number, text: string) {
  const chunks = String(text || "(empty)").match(/[\s\S]{1,4000}/g) || ["(empty)"];
  for (const chunk of chunks) {
    await tg("sendMessage", { chat_id: chatId, text: chunk });
  }
}

function runClaude(prompt: string, sessionId?: string): Promise<ClaudeResult> {
  return new Promise<ClaudeResult>((resolve) => {
    const args = ["-p", prompt, "--output-format", "json", "--permission-mode", PERMISSION_MODE];
    if (sessionId) args.push("--resume", sessionId);

    const child = spawn("claude", args, { cwd: WORK_DIR, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    child.on("error", (e) => resolve({ ok: false, error: `spawn failed: ${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: err.trim() || `claude exited with code ${code}` });
        return;
      }
      try {
        const json = JSON.parse(out);
        resolve({
          ok: !json.is_error,
          result: json.result,
          sessionId: json.session_id,
          error: json.is_error ? json.result : null,
        });
      } catch (e) {
        resolve({
          ok: false,
          error: `could not parse claude output: ${
            e instanceof Error ? e.message : String(e)
          }\n${out.slice(0, 500)}`,
        });
      }
    });
  });
}

async function handleUpdate(update: TgUpdate) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const fromId = String(msg.from.id);
  const text = msg.text.trim();

  // --- allowlist gate (before anything can touch the machine) --------------
  if (!ALLOWED_USER_ID) {
    await sendMessage(
      chatId,
      `👋 Your Telegram user ID is: ${fromId}\n\n` +
        "Add it to .env as ALLOWED_USER_ID and restart the bot to unlock.",
    );
    console.log(`[setup] observed user id ${fromId} — put this in ALLOWED_USER_ID`);
    return;
  }
  if (fromId !== ALLOWED_USER_ID) {
    await sendMessage(chatId, "⛔ Not authorized.");
    console.warn(`[blocked] unauthorized user ${fromId}`);
    return;
  }

  // --- built-in commands ---------------------------------------------------
  if (text === "/start") {
    await sendMessage(
      chatId,
      "free-rider ready 🚀\nSend a message and Claude Code will act on it in:\n" + WORK_DIR,
    );
    return;
  }
  if (text === "/reset") {
    sessions.delete(chatId);
    await sendMessage(chatId, "🧹 Conversation reset — next message starts fresh.");
    return;
  }
  if (text === "/whoami") {
    await sendMessage(
      chatId,
      `user id: ${fromId}\nwork dir: ${WORK_DIR}\npermission: ${PERMISSION_MODE}`,
    );
    return;
  }

  // --- forward to Claude Code ----------------------------------------------
  if (busy.has(chatId)) {
    await sendMessage(chatId, "⏳ Still working on your previous message…");
    return;
  }
  busy.add(chatId);
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  const r = await runClaude(text, sessions.get(chatId));
  busy.delete(chatId);

  if (r.ok) {
    if (r.sessionId) sessions.set(chatId, r.sessionId);
    await sendMessage(chatId, r.result || "(no output)");
  } else {
    await sendMessage(chatId, `⚠️ ${r.error || "unknown error"}`);
  }
}

async function main() {
  console.log(`[start] free-rider — cwd=${WORK_DIR} permission=${PERMISSION_MODE}`);

  const me = await tg<{ username: string }>("getMe");
  if (!me.ok) {
    console.error("[fatal] getMe failed — check BOT_TOKEN", me);
    process.exit(1);
  }
  console.log(`[ok] connected as @${me.result?.username}`);
  if (!ALLOWED_USER_ID) {
    console.log("[setup] ALLOWED_USER_ID not set — message the bot once to print your id.");
  }

  // ensure no webhook is set so long polling receives updates
  await tg("deleteWebhook", { drop_pending_updates: false });

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, {
        signal: AbortSignal.timeout(60000),
      });
      const data = (await res.json()) as TgApiResponse<TgUpdate[]>;
      if (!data.ok) {
        console.error("[poll] getUpdates error", data);
        await sleep(3000);
        continue;
      }
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((e) => console.error("[handler] error", e));
      }
    } catch (e) {
      console.error("[poll] error", e instanceof Error ? e.message : e);
      await sleep(3000);
    }
  }
}

main();
