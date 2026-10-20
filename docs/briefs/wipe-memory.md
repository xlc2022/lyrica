# Brief: Wiping memory

**Status:** Everyone wipe merged (#390); personal wipe in review.

**Read first:** AGENTS.md, PRINCIPLES.md (2, 6, 7), DESIGN.md (Memory,
"Wiping memory"; Storage), docs/contracts.md, docs/daemon.md ("Wiping
memory"), docs/ux.md §6 ("Wiping memory").

## Goal

The operator wants to start Lyrica's memory over on a server without
re-creating it: every user's threads and memories go, and logins, passwords
and endpoints stay, so she can make new memories from fresh threads. The
test machine's first reset waits for this page.

- Principle 6: an irreversible action asks first, with a box to tick and the
  administrator's own password.
- Principle 2: pools are deleted as files and user.db rows with
  `secure_delete`; nothing deleted is logged, and the waiting list shows no
  thread titles across users.
- Principle 7: DESIGN.md states the guarantee in one place.

## In scope (done)

- `core/src/wipe.ts`: `wipePools`, `finishWipe`, `wipePending`,
  `WIPED_USER_TABLES`, `KEPT_USER_TABLES` (a test fails when a user.db table is
  in neither).
- `lyricad.wipeMemory()`, `POST`/`GET …/admin/wipe`, and finishing at the next
  unlock for locked users.
- `lyrica admin wipe` while lyricad is stopped.
- Administration → **Reset** with the confirm dialog and the stopping state
  (spinner, collapsible list, polling).
- Settings → **Reset**: **Wipe my memory…**, the same dialog on
  `POST`/`GET …/me/wipe`, wiping only the user's own (`wipePools(…, userId)`).

## Out of scope

- Resetting Lyrica's persona to the seed, or her name.
- Branches her worktrees made in granted repositories (kept, as when a thread
  is forgotten), backups and update snapshots.
- An administrator wiping one other user only.

## Handoff

Done: everything above, with daemon tests (`daemon/test/wipe.test.ts`) and
e2e tests at both sizes. The everyone wipe merged as #390; the personal wipe
followed in its own PR.
