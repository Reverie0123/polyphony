# Polyphony

Pull several AI models into one group chat, WeChat style: @mention who should answer, reply to a specific message, and see the price on every reply. Optional "free discussion for N rounds" lets them review each other; add [DeskDock](https://github.com/Reverie0123/deskdock) to the group and one member can operate your Windows desktop.

[中文说明](README.zh.md)

> Work in progress. Phase 1 (contacts, direct and basic group chat, cost) works; free discussion and the DeskDock member come in later phases.

## What it is

- **A contact is one concrete model**: DeepSeek, any OpenAI-compatible endpoint, Anthropic, local Ollama, or the `claude` / `codex` CLI already logged in on your machine (uses your subscription).
- **Groups**: a description ("review my paper", "play Werewolf"), a role card per member, a budget per round.
- **@ to speak**: nobody answers unless mentioned. Reply to a message and the mentioned model receives that original text.
- **Cost, clearly**: every reply shows the price, input/output/cached tokens and latency; the side panel shows session, daily and per-provider totals.
- **Privacy, visibly**: a line above the composer always says "this will be sent to: DeepSeek, Claude"; local Ollama is marked as never leaving the machine; "whisper" messages go only to the mentioned members.
- **Context under control**: each call sends system prompt + rolling summary + the last N messages + the quoted message, so a long chat does not get more expensive every turn.

## Run

Needs Node 22 or newer.

```bash
npx polyphony-chat
```

Starts a local server on port 7331 and opens an Edge app window. Data lives in `%APPDATA%\Polyphony\` (override with `POLYPHONY_HOME`); API keys never leave the machine.

Flags: `--no-open`, `--port`, `--data-dir`, `--reset-token`.

## Develop

```bash
npm install
npm run build
npm test
node dist/index.js --no-open
```

Design notes and the competitor survey are in `docs/` (Chinese).

## License

MIT
