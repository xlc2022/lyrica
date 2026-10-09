# core

Keys, users and the persona store. No Pi dependency.

- **`db.ts`** opens SQLCipher databases (`better-sqlite3-multiple-ciphers`,
  `cipher=sqlcipher`, `legacy=4`) and holds the schemas. A wrong key throws.
- **`keyring.ts`** (`Keyring`) keeps unlocked keys in process memory only.
  - `self.db` is keyed by the operator's passphrase (SQLCipher's own KDF).
  - Each user has a random 256-bit data key, wrapped with AES-256-GCM under
    Argon2id of their password. The wrapped key sits in `self.db`'s `users`
    table, because it's needed before `user.db` can open. A wrong password
    fails the GCM tag check.
  - `saveUserKey` and `forgetSavedKey` throw "not implemented".
- **`users.ts`** (`Users`): `createUser` (the first must be an administrator),
  `authenticate` (also unlocks the key), `changePassword` (rewraps the same
  key, so data isn't re-encrypted), `setAdmin` (administrators only; the last
  administrator can't be demoted), `listUsers`, and `openUserDb`.
- **`persona.ts`** (`PersonaStore`): `importSeed` copies `persona/` into
  `self.db` on first run. Every version of every file is a row in
  `persona_revisions`; the latest per path is current. `apply` (administrators
  only) adds a revision, and `read` returns the core files plus the topics
  parsed from the matrix's front matter.
- **`types.ts`**: `Pool`, `Interface`, `CallContext` and a placeholder
  `PoolView` for the Memory and Models threads.

On disk, under `LYRICA_HOME`:

```text
self.db                 users (index + wrapped keys), persona_revisions
users/<id>/user.db      settings (display name for now)
```
