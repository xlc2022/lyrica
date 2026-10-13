# Brief: Folders narrow at once

**Status:** Built; on main (`narrowGrants` in `core/src/workspace/settings.ts`). Handoff notes below are history.

**Thread:** Folder narrowing. **Branch:** `feature/folder-narrowing`.
**Model:** Opus. **Depends on:** nothing; can run alongside Project
workspace ([project-workspace.md](project-workspace.md)).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Machines" and
"Projects", docs/workspace.md "Subagents", docs/contracts.md
`core/workspace`, and `core/src/workspace/settings.ts` (`effective`,
`checkNarrower`, `checkInherited`).

## Goal

Taking a folder off a parent thread takes it off its children at once, the
way a machine already does (decided 2026-10-11). Today `effective()`
narrows a child's mode, switches and machines by its ancestors', but not its
grants: a child that still holds a removed folder fails on its next call
with "isn't in the parent thread's folders" until its own folders are
narrowed by hand. Principle 2: a boundary enforced by structure, in one
place.

## In scope

1. **`effective()` narrows grants too:** a child's grant is kept only where
   an ancestor has a grant that contains it; a child's read-write grant
   becomes read-only where the ancestor's is read-only. Read on every call,
   as the rest of `effective()` is. Every grant read for a running thread
   then goes through `effective()`, not `thread()`: in
   `core/src/workspace/index.ts`, `files()` (the Files panel's sandbox and
   `ThreadFiles` roots), `grantsFor`, `folders`, and `targetFor`'s sandbox;
   and in `daemon/src/routes.ts`, the settings route's `tw` where it feeds
   the facts line. The settings drawer's editable list stays the thread's
   own grants, as it does for machines.
2. **`checkInherited` stops throwing for this case.** With grants narrowed
   in `effective()`, a child whose parent lost a folder simply no longer has
   it: its sandbox mounts fewer folders, and `read` on the old path is
   refused as outside its grants, with the usual reason.
3. **The UI follows:** a child thread's facts line and Files panel show the
   effective folders, so a removed folder disappears from running threads
   without a reload, as a removed machine does. Nothing new to design: the
   thread already shows `effective(thread)` for its mode and machines, and
   the reads in item 1 bring its folders along.
4. **Docs:** docs/workspace.md "Subagents" (folders join the list of what an
   ancestor narrows at once), docs/contracts.md (`effective`), and the
   sentence in docs/web.md "Project settings page" that describes the old
   failure, once Project workspace has written it.

## Out of scope

- Any change to what a child may be given at start (`inheritSettings`).
- Widening: a child never gains a folder its parent gained later.

## Done when

- `npm run typecheck` and `npm test` pass in CI, including the sandbox
  suites.
- Tests show that: removing a folder from a parent removes it from a
  running child's `effective()` grants, its Files panel roots and its next
  sandbox run; making a parent's grant read-only makes the child's
  read-only; a parent gaining a folder gives the child nothing; a child's
  own narrower grants are kept.
- docs/workspace.md describes what exists and the PR lists its contract
  changes.

## After merging

Tell the standing Operator docs thread by cross-session message if anything
an operator does by hand changed (nothing is expected to), in addition to
the merge notice to the project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
