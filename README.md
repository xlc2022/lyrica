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

1. **She is herself.** Users and keys, persona, topic routing and context
   assembly, tried out on the developer bench (`lyrica dev`).
2. **She remembers.** Encrypted general and private pools, notes,
   `remember`/`recall`/`read`, and automatic recall.
3. **Web chat.** `lyricad` hosts every conversation. The web UI gets login,
   threads per pool, streaming replies, visible tool calls, the model badge
   and the control panel. `lyrica chat` connects to the same daemon.
4. **She wakes up oriented.** Sleep writes notes, pages, WAKE and the
   journal. The memory browser and the Sleep sidebar go into the web UI.
5. **Calendar and sorting.**
6. **Live with it** for a few weeks, keeping the evals and a friction log.

Later, when real use calls for them: Matrix, the forum, thread export between
interfaces, and system administration.

## Layout

```text
core/          keyring, users, mentions, stores, model router
extension/     the Lyrica Pi extension: persona, context, memory tools, sleep
daemon/        lyricad: sessions, HTTP/SSE and local-socket API, scheduler
web/           web chat, control panel, memory browser, sleep sidebar
persona/       seed, imported into self.db on first run
evals/         continuity scenarios
bin/lyrica     one command: serve, chat, admin, mem, dev
```
