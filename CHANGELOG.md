# Changelog

## 0.1.0 (unreleased)

- Phase 1 skeleton: local server with token / Host / Origin checks, JSON store, accounts and contacts, model discovery, direct and group chat with @mentions and quotes, streaming replies over SSE, usage normalisation (input / output / cache read / cache write / reasoning), cost per message with built-in and online price tables, cost ledger, cancel and regenerate, privacy line, two-column UI with a resizable side panel, Chinese and English UI.
- Providers: OpenAI-compatible (DeepSeek default), Anthropic, Ollama, local `claude` and `codex` CLIs.
- Phase 2: rolling summary by a secretary model, image and text-file attachments (vision contact or Windows OCR, cached by hash), edit & resend, forward, star, pin, Markdown export, global search, @nickname parsing in text.
- Phase 3: free discussion (list / random / host / race order, round gap, no-objection / repetition / budget / end-marker / user stops, summariser, pause / resume / recover), model-to-model mention cards with an auto mode, role-card templates.
- Phase 4: DeskDock member: built-in MCP stdio client, driver model + tool loop with step cards, one-off driver override, confirmation card when a model mentions DeskDock, install / connect / restart from Settings; tool-call messages for OpenAI-compatible, Anthropic and Ollama.
- Phase 5: updater (npm registry check, in-place update for global installs, restart), LAN access QR code (own encoder), icon, Inno Setup installer with portable Node, install.ps1, fixture recorder.
- Fixes after the fourth review (2026-10-16): atomic writes retry the rename in the background instead of copying over the target, claude temp system file removed in finally, ledger rotation (entries older than 30 days folded into ledger-totals.json and archived).
- Fixes after the third review (2026-10-16): request bodies decoded as whole buffers, attachments of any extension retrievable, claude system prompt via file, bounded session cache, cached ledger, non-blocking atomic write fallback, delete rollback, optional parallel mentions, cross-table price prefix, vision timeout, edit marks summary dirty, member purge on contact/account delete, unknown @ feedback, discussion cost includes hand-offs, role cards skip DeskDock.
- Fixes after review (2026-10-16): first-byte timeout no longer cuts long replies, stream aborts classified (timeout / network / cancelled) and uncharged, relay JSON error bodies and plain JSON completions handled, stream_options 400 retry, empty replies flagged, unpriced calls shown in red and counted, dated model names normalised.
