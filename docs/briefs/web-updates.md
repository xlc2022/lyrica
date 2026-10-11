# Brief: Web: updates

**Thread:** Web: updates. **Branch:** `feature/web-updates`. **Model:**
Fable. **Depends on:** Releases merged (its API).

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Updates and
self-editing", docs/ux.md (the Updates row in section 6), docs/web.md, and
the `updates` API the Releases PR added. Send the UI review thread
screenshots before the PR.

## Goal

Li sees what an update will change before pressing it, and can always
go back (principle 6: make review easy).

## In scope

1. **Updates**, a section of Administration, as docs/ux.md's row says: the
   running version in mono; the newest update note, its tag in mono and its
   text in a block; **Update** as the one primary. While draining it reads
   "Waiting for 2 threads", with those threads linked beneath; while
   building, smoke-testing or in probation, the step as one state word.
   Kept releases as rows (commit in mono, date, Running on one), **Roll
   back** behind ⋯.
2. **Roll back dialog:** "Roll back to 3f7a2c1?" plus, when the schema
   changed, "Messages since 14:02 will be lost." Roll back and Cancel.
3. **A failed probation** in Notifications: the commit, the failed check,
   that it rolled back.
4. **While draining**, a send that gets `409 { updating: true }` keeps the
   message in the box and says "Updating" where a failed send says why.
5. **Docs in the same PR:** docs/web.md.

## Out of scope

The updater, anything outside Administration, her own editing.

## After merging

Tell the standing Operator docs thread (Li's rule, 2026-10-11) by
cross-session message that updates and rollbacks are now pressed in
Administration → Updates. Plus the merge notice to the project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
