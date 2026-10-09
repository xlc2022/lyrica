# Brief: Memory (milestone 2, "She remembers")

**Thread:** Memory. **Branch:** `feature/memory`. **Depends on:** Core
(merged). **Runs alongside:** Workspace. The two meet only through the
contracts listed under "Seams" below.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md, docs/contracts.md,
docs/memory.md.

## Goal

Lyrica saves what matters as she goes, and recalls it when it's relevant,
without being asked. Everything is encrypted, split into general and private
pools, and traceable to where it came from. The privacy boundary between pools
is the main failure to test against.

## In scope

1. **Pool databases and `openThreadView`.**
   - Each user has `general.db` and `private.db`, keyed with
     `keyring.subkey(userId, "pool:general" | "pool:private")`.
   - `openThreadView(userId, pool)` is the only way to get handles. A general
     view holds only the general database. A private view writes to private
     and reads general.
   - Replace Core's placeholder `PoolView`.
2. **Threads and entries.**
   - `create({ parent?, unlogged? })`, with "Do not log" inherited by every
     daughter thread and enforced in the store. `setUnlogged` changes only
     what comes after, and each entry records whether it was written
     unlogged.
   - Hidden flag, `appendEntry`, `loadEntries`.
   - Exported copies keep their original entry IDs.
   - Provide a small `recordEntries(session, view, threadId)` helper that
     appends each finished Pi message. The developer bench uses it now and
     `lyricad` later.
3. **Notes.**
   - `remember` takes a list of notes. Mentions are stored with `toStored`,
     and the source is the current entry.
   - Also: `supersedes`, `archive`, `delete` (removes text and revisions,
     leaves a text-free tombstone), and `revisions` with authors.
   - Every read goes through `render`.
4. **Pages, WAKE and journal storage.**
   - Tables and store methods, including page `folders` and `forFolders`.
   - Sleep writes them later. This thread only needs `index()`, `get`, WAKE
     reads and `forFolders` working, plus test fixtures.
5. **Search.**
   - FTS5 inside the encrypted databases, over notes, pages and entries. Tool
     outputs are indexed in truncated form.
   - Entries written unlogged are never indexed.
   - A private view searches both pools. A general view searches general only.
   - Names in a query use `queryTokens`, searched as word OR token.
6. **Lineage.** The `citations` table is derived from inline citations.
   Provide `cameFrom`, `usedIn`, and `isTombstoned(entryId)` for sleep.
7. **Deletion levels:** archive, delete a memory, forget a thread (with notes
   whose only sources were in it, tombstones, and flagged pages), and forget
   by search (the bulk helper).
8. **Extension.**
   - Fill in `memorySections`. WAKE, the page index and pages for the
     thread's `folders()` go in the system-prompt sections. Recall hits for
     the current message go in the per-turn message.
   - Register `remember`, `recall` and `read_memory`, each with a prompt
     snippet and guidelines: save liberally, one fact per note, write
     `{user}` for the person you're talking with, no subject pronoun form.
   - In an unlogged thread, `remember` isn't offered, and the prompt says the
     thread isn't being remembered.
9. **Developer bench.** `lyrica dev` opens a real general-pool view in the
   development runtime and records entries, so `remember` and `recall`
   work across bench sessions.

## Seams with Workspace

- **Keys:** use `keyring.subkey`, which is already in Core. Don't derive keys
  any other way.
- **Folder pages:** read the thread's folders only through the `folders()`
  option. Never import from `core/workspace`.
- **Storage:** the pool databases are yours alone. Workspace keeps its
  settings in `user.db`.
- **Tools:** register yours in your own extension module. Workspace does the
  same.

## Out of scope

- Sleep (writing pages, WAKE and journal; catch-up).
- The memory browser UI (Web thread).
- `lyrica mem`, which is a client of `lyricad`.
- Embeddings.
- The daemon. Only the `recordEntries` helper is in scope.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that:
  - a general view can never read, search or cite private memory, and that
    private reads general but writes only private;
  - unlogged threads and their daughters are never indexed and can't write
    notes, and turning "Do not log" off later doesn't expose earlier entries;
  - mentions round-trip through the store, and a rename changes search
    results and rendered text with no rewrite;
  - deletion removes text and revisions, leaves a text-free tombstone, and
    flags citing pages;
  - "Li-ion" and name searches both work;
  - nothing in memory appears as plaintext on disk.
- On the bench, a fact she `remember`s in one session comes back through
  automatic recall in a new session. Use pi-ai's fake model if no real model
  is available, and say which was used.
- `docs/memory.md` describes what exists, and any contract change is listed
  in the pull request description.

## Handoff notes

(The Memory thread fills this in if it stops before it's done.)
