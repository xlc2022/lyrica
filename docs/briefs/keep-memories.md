# Brief: Keep memories when deleting a thread

**Thread:** Keep memories. **Branch:** `feature/preserve-memories`, on top of
`feature/forget-cleanup` (#273) until that merges. **Model:** Codex builds,
Opus reviews; the dialog goes to UI review.

**Read first:** AGENTS.md; docs/memory.md "Deleting" and the tombstone
paragraph; docs/contracts.md "Forget a thread"; docs/ux.md (dialogs, the
thread menu). The code: `PoolStore.forgetThread` and `remove` in
`core/src/store/pool.ts`, the forget route and `linkFor` in
`daemon/src/routes.ts`, `ConfirmDialog` in `web/src/ui.tsx`, the delete
dialog in `web/src/ThreadMenu.tsx`, `wordFor` in `web/src/memory.ts`.

## Goal (principle 1: experience before infrastructure; principle 5: memory is reconstruction)

Deleting a thread now always takes the notes that came only from it. The user
sometimes wants the conversation gone but what Lyrica learned from it kept.
The Delete dialog gets a **Keep memories** checkbox. Ticked, the thread and its
messages go, and its notes and pages stay, searchable as before. A citation
of the deleted thread or one of its messages leads to a tombstone: the
thread's title and when it was deleted, nothing else.

## In scope

1. **Store.** `forgetThread(id, author, { children, keepMemories })`. With
   `keepMemories` it removes no notes and, for a project with `children`,
   skips `forgetProjectMemory`; its subagents' and child threads are
   forgotten the same way. Entries, their search rows, wake-ups and the
   thread row go as now. Without it, nothing changes.
2. **Tombstone.** Every forgotten thread with `keepMemories` leaves a
   tombstone in `tombstones` with id `t:<thread>`, kind `thread`, sources
   `[]`, and its title. Pool migration 7 adds a nullable `title` column
   (expand only); a test opens a version 6 database. The title is the only
   text a tombstone ever holds, and only a thread's; docs/memory.md says so.
   `getThreadTombstone(id) → { title?, deletedAt } | undefined`.
3. **API.** `Api.ForgetThread` gains `keepMemories?: boolean`. `linkFor`
   returns, for a missing thread with a tombstone, a link of kind `thread`
   with its title, an empty snippet, `updatedAt` its deletion time and
   `deleted: true` (a new optional field on `MemoryLink`); without a
   tombstone it returns nothing, as now. `GET
   /api/u/:userId/threads/:pool/:threadId/tombstone → Api.ThreadTombstone`,
   404 when there is none.
4. **Dialog.** `ConfirmDialog` takes a list of options, each with its own
   default (the child-threads option stays ticked by default). Delete this
   thread? shows **Keep memories**, unticked by default, and the sentence
   follows it: unticked, "Its messages are deleted, and so is what <her name>
   learned only from it. This can't be undone."; ticked, "Its messages are
   deleted. What <her name> learned from it stays in memory. This can't be
   undone." The child-thread option keeps its place below. The Settings
   "Forget this thread?" confirm gets the same checkbox.
5. **Tombstone view.** A citation whose link is `deleted` reads as its title
   (or "a deleted thread") with a "deleted" cap, and opens the thread route. The
   thread route, on a 404, asks for the tombstone and shows it in the thread
   pane: the title as the heading, "Deleted <date>." and a link back to
   Home. No composer, no menu. With no tombstone it behaves as now.
6. **Tests** (the memory round trip): forget with `keepMemories` keeps a
   note cited only from the thread, the note is still found by search, its
   detail's link to the thread is `deleted` with the title; forget without it
   behaves as before; the migration test.
7. **Docs:** docs/memory.md (Forget a thread, tombstones), docs/contracts.md
   (`forgetThread`, the route, `MemoryLink`), docs/daemon.md (the route),
   docs/ux.md (the Delete dialog's checkbox, the tombstone view), DESIGN.md if
   it describes deletion.

## Out of scope

Undoing a delete. Keeping messages. Tombstones for rewinds (Remove turns).
Sleep: a kept note's sources point at entries that no longer exist, which
sleep already tolerates for branches.

## Decisions taken

- Unticked by default, so Delete behaves as before.
- A kept memory keeps its pool: a private note stays private.
- The tombstone keeps the title so the user can tell which thread it was;
  it lives in the encrypted pool database like every other title.

## Handoff note

Brief written. Next: build on Codex through the lunasa job queue, then PR.
