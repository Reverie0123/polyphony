# Polyphony

Pull several AI roles into one group chat, WeChat style: @mention who should answer, reply to a specific message, and see the price on every reply. **One API key is enough**: the same model with different personas makes different members (writer, reviewer, judge…); keys from several vendors can be mixed in too. Optional "free discussion for N rounds" lets them review each other; add [DeskDock](https://github.com/Reverie0123/deskdock) to the group and one member can operate your Windows desktop.

[中文说明](README.zh.md)

> 0.1.0 in progress: contacts, direct and group chat, attachments and vision, rolling summary, free discussion, the DeskDock member, updater and installer are all implemented; release follows real-key testing.

## What it is

- **A contact is one role**: account + model + persona. One model can play several roles (generated from a template when you create a group), or every role can use a different vendor. Supports DeepSeek, any OpenAI-compatible endpoint, Anthropic, local Ollama, or the `claude` / `codex` CLI already logged in on your machine (uses your subscription; both vendors reserve subscriptions for their own products and Anthropic has blocked third-party tools from using subscription tokens since 2026-04-04, so this type only runs the official command, never touches tokens, and is off by default).
- **Groups**: a description ("review my paper", "play Werewolf"), a role card per member, a budget per round.
- **@ to speak**: nobody answers unless mentioned. Reply to a message and the mentioned model receives that original text.
- **Cost, clearly**: every reply shows the price, input/output/cached tokens and latency; the side panel shows session, daily and per-provider totals.
- **Privacy, visibly**: a line above the composer always says "this will be sent to: DeepSeek, Claude"; local Ollama is marked as never leaving the machine; "whisper" messages go only to the mentioned members.
- **Context under control**: each call sends system prompt + rolling summary + the last N messages + the quoted message, so a long chat does not get more expensive every turn.

## Install (pick one)

1. **Installer**: download `Polyphony-Setup-x.y.z.exe` from Releases; per-user install, no admin rights, bundles a portable Node.
2. **One script**: `powershell -ExecutionPolicy Bypass -File install.ps1` downloads a portable Node if needed, installs into `%LOCALAPPDATA%\polyphony` and adds a Start Menu entry.
3. **Node 22+ already installed (24 recommended)**: `npx polyphony-chat`.

It starts a local server on port 7331 and opens an Edge app window. Data lives in `%APPDATA%\Polyphony\` (override with `POLYPHONY_HOME`); API keys are stored only on this machine and sent only to the endpoint you configured. Settings can check for updates and enable LAN access (a QR code with the token, for a phone on the same Wi-Fi).

Flags: `--no-open`, `--port`, `--data-dir`, `--reset-token`, `--stop`, `--force`, `--no-exit`, `--no-update-check`.

## DeskDock

Add [DeskDock](https://github.com/Reverie0123/deskdock) to a group and it becomes a member that operates your computer: pick a tool-capable driver model, then "@DeskDock open Notepad and type hello". Every step shows as an expandable card; the permission table and audit log stay in DeskDock. Settings can detect, install and restart it.

## Develop

```bash
npm install
npm run build
npm test
node dist/index.js --no-open
```

## License

MIT
