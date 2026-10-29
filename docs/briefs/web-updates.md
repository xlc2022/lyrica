# Brief: Web: updates

**Status:** Merged as #144 (7abb27a).

**Thread:** Web: updates. **Branch:** `feature/web-updates`. **Model:**
Fable. **Depends on:** Releases merged (its API).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Updates and
self-editing", docs/ux.md (the Updates row in section 6), docs/web.md, and
the `updates` API the Releases PR added. Send the UI review thread
screenshots before the PR.

## Goal

The user sees what an update will change before pressing it, and can always
go back (principle 6: make review easy).

## In scope

1. **Updates**, a section of Administration, as docs/ux.md's row says: the
   running version in mono; the newest update note, its tag in mono and its
   text in a block; **Update** as the one primary, disabled while an update
   runs. Beneath it a status line, a dot and a word (Draining, Building,
   Testing, Probation in blue; Failed red); while draining it continues
   "waiting for 2 threads", the count in mono, with those threads linked
   beneath. The button's label never changes. Kept releases as rows (commit
   in mono, date, Running on one), **Roll back** in each row's ⋯ except the
   Running row's, disabled while an update runs.
2. **Roll back dialog:** "Roll back to the release from 9 October?" with
   the commit in mono after it, plus, when it restores a snapshot, "Messages
   since 14:02 will be lost." Roll back and Cancel.
3. **A failed probation** in Notifications: the commit, the failed check,
   that it rolled back.
4. **While draining**, a send that gets `409 { updating: true }` keeps the
   message in the box and says "Updating" where a failed send says why.
5. **Docs in the same PR:** docs/web.md.

## Out of scope

The updater, anything outside Administration, her own editing.

## After merging

Tell the standing Operator docs thread (the owner's rule, 2026-10-11) by
cross-session message that updates and rollbacks are now pressed in
Administration → Updates. Plus the merge notice to the project chat.

## Handoff notes

- 2026-10-12 (Web UI 2, the combined PR): built as `web/src/Updates.tsx`
  (Administration → Updates), the `rollback` notification in
  `daemon/src/notifications.ts`, and the Updating send error in
  `web/src/Thread.tsx`. Docs in docs/web.md and docs/daemon.md. The
  section is exercised by the setup e2e only where no updater is installed;
  the updater's states are covered by the daemon's tests of `readUpdates`.
