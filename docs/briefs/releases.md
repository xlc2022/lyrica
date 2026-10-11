# Brief: Releases and rollback

**Thread:** Releases. **Branch:** `feature/releases`. **Model:** Opus.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Updates and
self-editing" and "Runtime", docs/contracts.md `daemon` (the planned Updates
entry), docs/daemon.md "Starting and unlocking" and "Deployment",
`daemon/deploy/`, and Monika's `docs/autodeploy.md` and
`docs/redeployment.md` (github.com/irrigationreal/monika) for the drain and
backup rules this borrows.

## Goal

Any update, Claude's or hers, can be undone without her, and a bad one
undoes itself (principle 2: one operator, simple boundaries; principle 1:
Li notices the first update that goes wrong).

## In scope

1. **Release layout.** `/opt/lyrica/releases/<commit>/` (built: `npm ci
   --omit=dev`, the web UI built), root-owned and read-only;
   `/opt/lyrica/current` and `previous` symlinks; `lyricad.service` runs
   `/opt/lyrica/current/bin/lyrica serve`. A release has no git checkout,
   so the build writes its commit where `lyricad` reads its build id
   (`LYRICA_BUILD`, for the header's "Lyrica (ver. …, build …)"), for
   example a drop-in setting `LYRICA_BUILD=<commit>` on each switch. Keep the last 5 plus `previous`.
   `install.sh` builds a release from its checkout the same way and moves
   today's flat `/opt/lyrica` into the first release. It also installs what
   it was missing (build-essential, building the web UI).
2. **`lyrica-update`** (`/usr/local/sbin`, bash, installed only by
   `install.sh`), run by `lyrica-update.service` (oneshot, root), started by
   `lyrica-update.path` on a request file. It fetches into
   `/opt/lyrica/repo.git` with a read-only deploy key (root-owned), takes an
   annotated tag `update/*`, refuses a tag whose commit isn't on `main`,
   and then: builds as an unprivileged build user with no access to
   `/var/lib/lyrica`; smoke-tests the release on a spare port with a scratch
   home and a test user (start, unlock, `/health` checks, the web UI's
   index), never real data; drains over `update.sock` (scheduled sleep and
   child-thread starts wait too; gives up after 10 minutes and undrains,
   changing nothing); stops `lyricad`; runs `lyrica-snapshot` with the
   tag's message; switches `current`; starts `lyricad`; runs probation.
   A `flock`
   keeps runs from overlapping. It logs commits, tags and check names,
   never message text.
3. **Probation.** Pass when `/health` reports every check ok after unlock
   and `lyricad` has stayed up 10 minutes; with no saved credentials, wait
   for the first unlock. `lyricad.service` gets `StartLimitBurst=3`,
   `StartLimitIntervalSec=120` and `OnFailure=lyrica-rollback.service`,
   which acts only while a release is on probation. A failed check or crash
   loop rolls back and leaves a status file `lyricad` turns into a
   Notification for administrators (commit, check, time).
4. **`lyrica-snapshot` and `lyrica-restore <dir>`** (`/usr/local/sbin`,
   from `install.sh` only, or the NixOS module's system package, so a
   broken release can't break them; root or
   the service user, `lyricad` stopped). `lyrica-snapshot` copies the
   databases and settings into `/var/lib/lyrica-snapshots/<time>-<commit>/`
   (not the users' homes) with the commit and schema versions beside them.
   It runs only after a clean stop, checkpoints each database's WAL first
   (`journal_mode = WAL`, core/src/db.ts) and refuses if a `-wal` is still
   there, and refuses before copying when the disk lacks room for one more
   snapshot,
   plus an update note when given one, and checks each copy against its
   source (size and SHA-256) before returning; keeps the last 3, plus the
   newest snapshot taken before a contract until a later contract has
   passed probation and for at least 30 days.
   `lyrica-restore` first moves the databases it replaces into
   `/var/lib/lyrica-snapshots/<time>-set-aside/` (encrypted, kept like a
   pre-contract snapshot, with their `-wal` and `-shm`), never deleting
   them, then copies the snapshot back with no `-wal` or `-shm` beside it,
   so SQLite never applies a stale log to it. The updater, the rollback and the NixOS module all use these two,
   so there is one snapshot tool.
5. **`lyrica-rollback`** (`/usr/local/sbin`, also from `install.sh` only):
   point `current` at `previous` (or a named kept release), run `lyrica-restore`
   on the pre-update snapshot only if the release it goes back to can't
   read the databases (their oldest reader is above its schema); start `lyricad`. Works with `lyricad` dead. Asks on a terminal before
   restoring a snapshot, saying from when data will be lost. Refuses a
   release that can't read the databases and has no kept snapshot it can, naming the oldest
   release it can go back to. An automatic rollback that restored a
   snapshot says from when in its Notification.
6. **In `lyricad`:** `update.sock` with `/health`, `/drain`, `/undrain`;
   `409 { updating: true }` on send while draining; in every encrypted
   database its schema version (`PRAGMA user_version`) and the oldest
   schema that can read it (a `meta` row, `min_reader`; an expand leaves it,
   a contract raises it), and `SchemaTooNew` when `min_reader` is above the
   release's own schema, set by the existing `migrate` functions, each database's migration in one
   transaction that runs `integrity_check` and `foreign_key_check` before
   committing (the pool upgrades don't share one yet); the Administration `updates` API
   that lists state and writes requests into a directory only `lyricad`
   writes, which is refused as a grant.
7. **NixOS** (Li, 2026-10-11: the same Update button). On a NixOS host
   `lyrica-update` builds the tagged release with Nix (`nix build
   <repo>?rev=<commit>#lyrica`) into a Lyrica-only profile,
   `/nix/var/nix/profiles/lyrica`, that the module's `lyricad` unit runs
   from, with the same drain, snapshot, probation and rollback (the
   previous profile generation instead of `previous`). A version change
   from `nixos-rebuild` instead goes through the module's `ExecStartPre`,
   which runs `lyrica-snapshot` when the package's commit differs from the
   one beside the databases; a database the starting package can't read
   is `SchemaTooNew`, and the module restores only on that. The NixOS thread's first PR ships the flake and module; this
   build adds the profile path.
8. **Docs in the same PR:** docs/daemon.md "Deployment" (the layout, the
   update, probation, rollback, the console command); contracts entry moved
   from planned to current.

## Out of scope

The web UI (web-updates brief), her checkout and account (self-edit
brief), model hosts, Proxmox snapshots.

## Tests

What Li would notice: a release that fails its checks is rolled back and
the old one serves again; a rollback across a contract restores the snapshot
and one across only an expand keeps the data; a drain with a turn running waits
and gives up cleanly; `SchemaTooNew` is thrown; a migration that fails halfway leaves the
database as it was; a restore sets the replaced databases aside; a
snapshot after a crash keeps every committed transaction. A
migration test builds each database at every released schema version (by
code, no real data), migrates it, and checks no rows were lost and the
previous release's schema version still opens it after an expand. The scripts get a test
that runs them against a temporary prefix as an unprivileged user where
they can be, as the sandbox tests do.

## After merging

Tell the standing Operator docs thread (Li's rule, 2026-10-11) by
cross-session message what changed that an operator does by hand: the
release layout, the deploy key, `sudo lyrica-rollback`, the snapshots
folder, and the scheduled Proxmox backup of the container the guide should
ask for. Plus the merge notice to the project chat.

## Handoff notes

(The thread fills this in if it stops before it's done.)
