# core

Keys, users and the persona store. No Pi dependency.

- **`db.ts`** opens SQLCipher databases (`better-sqlite3-multiple-ciphers`,
  `cipher=sqlcipher`, `legacy=4`), optionally read-only, and holds the
  schemas. A wrong key throws.
- **`keyring.ts`** (`Keyring`) keeps unlocked keys in process memory only.
  - `self.db` is keyed by the operator's passphrase (SQLCipher's own KDF).
  - Each user has a random 256-bit data key, wrapped with AES-256-GCM under
    Argon2id of their password. The wrapped key sits in `self.db`'s `users`
    table, because it's needed before `user.db` can open. A wrong password
    fails the GCM tag check.
  - `subkey(userId, purpose)` derives a separate 256-bit key (HKDF-SHA256)
    for each purpose (`pool:general`, `pool:private`, `home`) from the user's
    data key. Purposes never share a key.
  - "Save credentials": `saveUserKey`, `forgetSavedKey`, `loadSavedKey`,
    `saveSelfPassphrase` and `unlockSaved` go through a `CredentialStore`
    that lyricad sets. **`credentials.ts`** (`SystemdCredentials`) seals with
    `systemd-creds encrypt` and reads what systemd unsealed at start from
    `$CREDENTIALS_DIRECTORY`. See [docs/daemon.md](../docs/daemon.md#saving-credentials).
- **`users.ts`** (`Users`): `createUser` (the first must be an administrator),
  `authenticate` (also unlocks the key; Argon2 runs for unknown logins too),
  `changePassword` (rewraps the same key, so data isn't re-encrypted),
  `setPassword` (an administrator sets another user's password, using the
  recovery copy of that user's key in `self.db`),
  `setAdmin` (administrators only; the last administrator can't be demoted),
  `updateProfile` (the user or an administrator), `listUsers`, and
  `openUserDb`.
  - `link` joins two users of the same person (it checks both passwords),
    `unlink` undoes it, and `linked` lists them; links live in `self.db`'s
    `user_links`. `stayUnlocked` / `setStayUnlocked` keep the user's choice
    about logout in their `user.db`.
  - A user signs in with a **login** name. The **profile** (display name,
    five pronoun forms, and previous names with the date each ended) is
    separate and kept in `self.db`, so it can be edited and rendered while the
    user is locked.
- **`profile.ts`**: the `Profile` type (with the web UI's accent colour and
  monogram) and the she/he/they pronoun presets.
- **`mentions.ts`**, pure functions:
  - `toStored(text, speaker)` turns `{user}`, `{user:obj}`, `{user:poss}`,
    `{user:poss-pro}` and `{user:refl}` into `[[u:ID]]`, `[[u:ID:obj]]` and
    so on. There is no subject pronoun form: `{user:subj}` throws, and the
    name token goes in the subject position.
  - `render(text, profiles)` turns tokens into the current name and pronouns.
    A pronoun that starts a sentence is capitalised. Tokens for unknown users
    are left as they are.
  - `queryTokens(query, profiles)` returns the users' names (current or
    previous) found in a search query, as `{ name, userId }`. It doesn't
    change the query: the caller searches for the word OR the token, so
    "Li-ion" still matches. A current name wins over someone else's previous
    name.
- **`persona.ts`** (`PersonaStore`): `importSeed` copies `persona/` into
  `self.db` on first run. Every version of every file is a row in
  `persona_revisions`; the latest per path is current. `apply` (administrators
  only) adds a revision, and `read` returns the core files plus the topics
  parsed from the matrix's front matter. Administrators approve (applying it)
  or reject a sent proposal with `decide`; a proposal whose file changed
  since it was drafted needs `overwrite`. `PersonaProposals` is the only way
  in: `propose` takes the thread's own view (the owner comes from it), and a
  proposal starts as a draft in that user's `user.db` (`persona_drafts`),
  which they can edit, drop or `send` on, recorded with who sent it and
  whether they edited it; an administrator's own is sent at once.
- **`store/`**: the pool databases and the privacy boundary (`Memory`,
  `openThreadView`, `openOwnerView`, `PoolStore`). See
  [docs/memory.md](../docs/memory.md#in-code).
- **`workspace/`**: where her file and command tools run. See
  [docs/workspace.md](../docs/workspace.md).
  - `Workspace` mounts each user's gocryptfs home (`mountHome`,
    `unmountHome`), gives a thread its target (`targetFor`), folders,
    `inheritSettings` for subagents, and `saveUpload`.
  - `AllowedPaths` keeps the folders each user may grant in `self.db`; only
    an administrator changes them. `WorkspaceSettings` keeps thread settings,
    network defaults and SSH targets in the user's `user.db`.
  - `net.ts` builds the `pasta` options and the nftables rules for a
    sandbox's network.
  - `Sandbox` (bubblewrap) and `SshTarget` implement Pi's tool operations
    without depending on Pi. `SshTarget`'s client (ssh2) runs in
    `ssh-helper.ts`, a sandboxed child per connection, over the frames in
    `ssh-frames.ts`.
- **`models/`**: endpoints, profiles and the model router. See
  [docs/models.md](../docs/models.md).
- **`types.ts`**: `Pool`, `Interface`, `Task`, `ModelRef` and `CallContext`.

On disk, under `LYRICA_HOME`:

```text
self.db                 users (login, admin, profile, wrapped key, recovery copy), persona_revisions, workspace_paths,
                        user_links, shared endpoints
users/<id>/user.db      settings (incl. network defaults), endpoints, model profiles and thread models,
                        thread workspaces, machines (SSH and Proxmox), Git accounts
users/<id>/general.db   general pool: threads, entries, notes, pages, WAKE, journal, index
users/<id>/private.db   private pool, same tables
users/<id>/home.crypt/  the encrypted home workspace (gocryptfs)
users/<id>/home/        where it is mounted while the user is unlocked
```

## Sandbox tests

`test/sandbox.test.ts` and `bin/test/bench.test.ts` need bubblewrap,
gocryptfs, FUSE (`/dev/fuse`), pasta and nft (with `/dev/net/tun`), and must run as an unprivileged user,
because root hides permission bugs. As root they are skipped. CI runs them as
its normal user, with `LYRICA_SANDBOX_TESTS=require` so they can't be skipped. In a root cloud
session, create a user and run them as that user from a copy of the checkout:

```sh
apt-get install -y bubblewrap gocryptfs fuse3 openssh-server passt nftables imagemagick
chmod 666 /dev/fuse /dev/net/tun   # some containers ship them 0600
useradd -m lyricatest
rsync -a --exclude .git ./ /home/lyricatest/lyrica/ && chown -R lyricatest: /home/lyricatest/lyrica
su lyricatest -c 'cd ~/lyrica && LYRICA_SANDBOX_TESTS=require npx vitest --run'
```
