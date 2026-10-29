# Brief: Threads sharing a local model

**Status:** Merged as #379 (1d2f3ba) and #380 (1866d8d); #471 later limited requests to the server's slots (docs/models.md). Handoff notes below are history. **Built by:** the
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
4. **Model hosts serve by the same limit** (host/API.md, "Placement and
   serving settings"). A chat model's llama.cpp `parallel` or vLLM
   `--max-num-seqs` defaults to the tiers above, with one cache shared by
   its requests (llama.cpp's `kv-unified`), and the host's model list
   reports it as `parallel`, read into the offering. Image jobs already
   take turns with chat models in the host's queue for GPU memory, which
   counts each chat model's whole cache, so they need no change.

## Out of scope

- Slots of a llama-server or vLLM run outside a model host aren't read:
  the tiers apply by the window alone.
- Showing the waiting thread in the interface. The checklist and the turn
  stay as they are while a request waits.
