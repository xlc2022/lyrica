# Brief: Recall by meaning

**Status:** Merged as #739 (97fe827d). **Thread:** Make memory recall more relevant.
**Branch:** `feature/recall-meaning`. **Model:** Fable builds, PR review
reviews (core, migrations, daemon).

**Read first:** AGENTS.md; docs/memory.md "Retrieval"; docs/contracts.md
(Search, Models); docs/models.md "Tasks". The code: `search` and `hit` in
`core/src/store/pool.ts`, `ftsQuery` and `holdsEnough` in
`core/src/store/refs.ts`, `memorySections` in `extension/src/memory.ts`,
`transcribe` and `speechTarget` in `core/src/models/index.ts` (the shape of
a non-chat call), the pool steps in `core/src/migrations.ts`.

## Goal (principle 1: experience before infrastructure; principle 5: memory is reconstruction)

The user asked "What are some interesting recipes I should try?" and recall
brought up five memories that weren't about recipes. #715 fixed what
keyword search counted; what it can't do is bring up "doesn't like
cilantro" or "grows thyme on the balcony" for that question, because they
share no word with it. Recall should find what a message is *about*.

The owner's decisions (2026-11-01):

- A hybrid: FTS5 keyword search as now, plus vectors from an embedding
  model, merged by rank fusion.
- The **Embeddings** task in the model lists, which nothing used, is the
  setting. An external or GPU-hosted model first, a CPU-served copy after
  it, through the task's ordered list. With no embedding model reachable,
  recall works on keywords alone and catches up later.
- The model: Qwen3-Embedding-0.6B (GGUF, Q8_0) on both hosts, so the GPU
  and CPU copies share one index. The code doesn't assume it.
- Vectors live in the pool database, in the same encrypted file; no
  separate index server (no plaintext on disk) and no native extension.
  Nearest-neighbour search is a scan in the daemon: a few thousand
  memories of 1,024 floats compare in milliseconds. If a pool outgrows
  that, sqlite-vec is the next step, not a different design.

## In scope

1. **Store.** A `vectors` table (`id`, `kind`, `model`, `vec` BLOB of
   float32, `vec` NULL for an item the model skips) in each pool database,
   pool schema step 12, expand only. `PoolReader.nearest(model, vec, limit)`
   scans it by cosine; `search` accepts `vector: { model, values }` and,
   with it, fuses the keyword list and the nearest list by reciprocal rank
   (`RRF_K` 60), keeping `minWords`, `said`, `current`, `only` and the
   project boost on the keyword side and a cosine floor (`VECTOR_FLOOR`) on
   the vector side. `PoolStore.unembedded(model, limit)` lists what the
   index holds that has no vector for that model (a message by its spoken
   words, a note, page or journal entry by its text, a tool result marked
   skipped), `putVectors(model, rows)` stores them and drops vectors of
   any other model. Every place that deletes a search row deletes the
   vector too; a rewrite re-indexes, so the vector is made again.
2. **Models.** `embed(ctx, texts, { query })` → `{ model, vectors }`
   through `callWithFallback("embedding")`, POSTing `/embeddings` in
   OpenAI's shape to the resolved endpoint; `query` wraps each text in the
   retrieval instruction Qwen3 and Harrier expect (`Instruct: … Query: …`),
   which other models ignore. `model` is the offering's model ID.
   `embeddingModel(ctx)` names the model the list resolves to now, or
   nothing.
3. **Recall.** `memorySections` embeds the user's message (one call, a
   short timeout, any failure means keywords only) and passes the vector
   to `search`. The `recall` tool does the same with its query. Code-mode
   filters apply to both sides.
4. **The embedder** (lyricad): every 20 s tick, for each unlocked user and
   each pool, resolve the pool's embedding model, take up to 32 unembedded
   items, embed them in one call, store them. A pool whose model has
   changed is re-embedded from the start. Logs counts only.
5. **Docs:** docs/memory.md (Retrieval, Storage), docs/contracts.md
   (Search, PoolStore, Models), DESIGN.md (Memory, one bullet), docs/models.md
   (the Embeddings task is used; same model file on each host), docs/daemon.md
   (the embedder).

## Out of scope

- A UI for the embedding state (how many items are embedded). The Context
  popover's Recall part is unchanged.
- The memory browser's search stays keyword-only.
- Sleep doesn't use vectors.
- sqlite-vec, HNSW or any index structure.

## Done when

- `npm run typecheck` and `npm test` pass.
- Tests show: a search with a vector brings up an item that shares no
  word with the query and keeps the keyword rules for the rest; a message
  that holds only filler recalls nothing even with a vector; `putVectors`
  for a new model drops the old model's rows; deleting an item removes its
  vector; the pool migration from every released schema; `embed` sends the
  OpenAI shape and falls back to the next model when the first is away.

## Handoff

- Done (2026-11-01): everything in scope, on `feature/recall-meaning`.
  Core: `vectors` table (pool step 12), `nearest`, fusion in `search`,
  `unembedded`/`putVectors`/`vectorCount`; `Models.embed` and
  `embeddingModel` (`core/src/models/embed.ts`); the extension's `embed`
  option through `memorySections` and the `recall` tool; lyricad's
  `Embedder` on the tick. Tests: `core/test/embed.test.ts`,
  `core/test/store.test.ts` (recall by meaning), `daemon/test/embedder.test.ts`.
- Next: after the merge, the operator downloads Qwen3-Embedding-0.6B
  (GGUF, Q8_0) to each host through Download model and sets the Embeddings
  list (GPU copy first, CPU copy after) in the General and Private columns;
  then checks a question that shares no word with the memory it should
  find. The web UI shows nothing about embedding progress yet.
- Open questions: whether `VECTOR_FLOOR` (0.5) suits Qwen3's similarities
  in practice; whether the memory browser's search should fuse too.
