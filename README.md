# free-rider

Drive **Claude Code** on your Mac from a **Telegram** chat.

An OpenClaw-style "AI that does things", but powered by your local Claude Code
(seat login) instead of an LLM API key — so **no API key is required**.

```
[Telegram app]  ⇄  [Telegram servers]  ⇄  Mac bot (outbound long-poll)
                                              └─▶ claude -p  (seat auth)
```

## Why this design

- **No API key.** The bot shells out to a local `claude -p` session, which
  authenticates with your existing Claude Code login.
- **No exposed port.** The Mac connects *out* to Telegram; nothing inbound is
  opened, so there's no public attack surface to lock down.

## Security

- The bot **must** be locked to your own Telegram user ID (allowlist). Anyone
  who can message an unrestricted bot could run commands on this Mac.
- Claude Code runs real tools (shell, file edits). Keep it scoped to a working
  directory and start with conservative permissions.

## Status

Scaffolding. Bot source is added after Telegram setup.
