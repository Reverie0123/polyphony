# Changelog

## 0.1.0 (unreleased)

- Phase 1 skeleton: local server with token / Host / Origin checks, JSON store, accounts and contacts, model discovery, direct and group chat with @mentions and quotes, streaming replies over SSE, usage normalisation (input / output / cache read / cache write / reasoning), cost per message with built-in and online price tables, cost ledger, cancel and regenerate, privacy line, two-column UI with a resizable side panel, Chinese and English UI.
- Providers: OpenAI-compatible (DeepSeek default), Anthropic, Ollama, local `claude` and `codex` CLIs.
- Phase 2: rolling summary by a secretary model, image and text-file attachments (vision contact or Windows OCR, cached by hash), edit & resend, forward, star, pin, Markdown export, global search, @nickname parsing in text.
