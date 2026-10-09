# Lyrica

A continuous personal companion built on [Pi](https://github.com/badlogic/pi-mono).

This repository is being rebuilt from scratch. Contributors (human or model)
start with [AGENTS.md](AGENTS.md). The design lives in
[PRINCIPLES.md](PRINCIPLES.md) and [DESIGN.md](DESIGN.md). The memory
design is in [docs/memory.md](docs/memory.md).

Lyrica runs for one person, Li, on one server. Each of Li's personas is a separate
user whose memory is encrypted with that user's own key. Encryption protects
data at rest: anyone with root access while a user is unlocked can read that
user's data, and anything sent to a cloud model is outside our control.

## Plan

Each milestone leaves her usable:

1. **She is herself.** A Pi extension with persona, topic routing, spaces and
   context assembly. The CLI is Pi's TUI with the extension loaded.
2. **She remembers.** Notes, the index, `remember`/`recall`/`read`, and
   automatic recall.
3. **Web chat.** `lyricad` hosts Pi SDK sessions. A web UI with threads per
   space, streaming replies, and visible tool calls.
4. **She wakes up oriented.** `/sleep` writes notes, pages, WAKE and the
   journal. The memory browser goes into the web UI.
5. **Calendar.**
6. **Live with it** for a few weeks, keeping the evals and a friction log.

Later, when real use calls for them: Matrix, the forum, thread export between
interfaces, sorting data, local-model spaces, and system administration.

## Layout (planned)

```text
extension/     the Pi extension: persona, spaces, context, memory, sleep
daemon/        lyricad: hosts sessions for web chat and later adapters
web/           web chat and memory browser
persona/       seed copied into the self repository on first run
evals/         continuity scenarios
bin/lyrica     launcher (TUI) and small admin commands
```
