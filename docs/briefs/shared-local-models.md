# Brief: Threads sharing a local model

**Status:** built on `claude/agent-loop-reliability-661bmo`. **Built by:** the
Agent loop thread, on Opus. **Asked by:** the owner, after Racing sim 6
(2026-10-19), on Roadmap's card ("Build both").

## Why

In Racing sim 6, three threads used Flash Next at the same time: the
renderer, the HUD and the project chat's reviewer. Flash Next was loaded at
262k with 4 parallel slots. Each thread fitted its window on its own, but
LM Studio's cache is shared, and all three failed together with "Context
size has been exceeded". Pi didn't recognise that text as an overflow, so it
retried three times unchanged. Neither thread committed its work.

The project chat then waited on a foreground reviewer for 16 minutes and
sent the person nothing. After the person pressed Stop, a look woke it again
a few seconds later.

Principles 1 and 2: runaway or colliding work stops structurally, and the
person always hears where things stand.

## What was built

1. **Shared local models** (docs/models.md, Local servers). Every request to
   a local model takes a share of it, across the whole daemon: its estimated
   tokens against the served window, and at most 1 request at once below
   200k, 2 from 200k and 4 from 500k (the owner's tiers). A request that
   doesn't fit waits. LM Studio's error is marked as an overflow, so Pi
   compacts and retries.
2. **Project chats don't wait on subagents** (docs/delegation.md). Their
   runs always go to the background. Elsewhere, a foreground run still
   working after 5 minutes moves to the background.
3. **Stop holds the project** (docs/delegation.md, Watching threads). Stop in
   a project chat stops its runs and holds looks until the person writes in
   the project again.

## Out of scope

- A host's own slots (llama.cpp's parallel, vLLM's `--max-num-seqs`), and
  ComfyUI image jobs queueing against chat work on the same GPU: a
  follow-up PR from this thread. LM Studio's `parallel` is read here.
- Showing the waiting thread in the interface. The checklist and the turn
  stay as they are while a request waits.
