# Deleting users

**Status:** Merged as #581 (ec1192a).

Principles 2 and 7: users are protected from each other, and a deleted
user's data is gone from this server, except backups. Decided by the owner
on 2026-10-26, with no administrator export.

## What it does

An administrator deletes another user from Administration → Users
(**Delete user…**) or with `lyrica admin user remove <login>` while
lyricad is stopped. The rules, the order on the server and what stays are
in DESIGN.md ("Deleting a user"), docs/daemon.md ("Deleting a user"),
docs/contracts.md (core/users) and docs/ux.md ("Deleting a user").

- No self-delete, so an administrator always remains.
- The administrator's own password and an unticked box, as with Wipe memory.
- The user's running work is stopped first; the dialog waits for it.
- Their self.db row (the only copies of their key) and every self.db row
  naming them go in one transaction, then `users/<id>/`. A folder that
  couldn't go is removed at the next unlock.
- No export. A user exports their own notes, pages and skills first.

## Out of scope

- A user deleting their own account.
- A user's own **Download my data**, an encrypted archive of everything
  they have; a separate brief if the owner wants it.
- Backups, update snapshots, remote accounts made on SSH machines, and
  anything already sent to a model provider.

## Handoff

Done: core (`Users.checkDelete`, `deleteUser`, `pendingDeletes`,
`removeUserFiles`, `Keyring.dropSavedKey`), the route and
`lyricad.deleteUser` with `finishDeletes` at unlock, the CLI, the web
dialog (`web/src/DeleteUser.tsx`), daemon tests
(`daemon/test/delete-user.test.ts`) and the web e2e in web-admin.spec.ts.
Merged as #581. Open questions: none.
