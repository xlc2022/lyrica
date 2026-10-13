# Brief: Daemon

**Thread:** Daemon. **Branch:** `feature/daemon`. **Depends on:** Core,
Memory, Workspace (merged) and Models (#11). Start once Models is merged.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md ("Who Lyrica is for",
"Storage, encryption and unlocking", "Runtime"), docs/contracts.md (`daemon`,
`bin/lyrica`, `core/keyring`, `core/users`, `core/store`, `core/models`,
`core/workspace`, `extension`) and docs/workspace.md.

## Goal

`lyrica serve` starts `lyricad`, one process that:
- unlocks;
- logs users in;
- hosts their threads as in-process Pi sessions;
- serves a typed HTTP and SSE API that the web UI is built on.

Afterwards, Lyrica can be reached through that API, and from a browser once
the Web UI thread lands. This serves principle 1: until now she has existed
only on the developer bench.

## In scope

1. **`lyrica serve`** starts `lyricad`.
   - It listens on `127.0.0.1` only, on a configurable port.
   - It starts locked. Until `self.db` is unlocked, only the state and unlock
     endpoints answer. When run by hand in a terminal, it prompts for the
     passphrase instead, at a hidden prompt.
   - It builds `Workspace` with its own ports as `excludePorts`, and runs
     `selfTest()`. If network is refused, the reason goes to administrators
     through the API.
   - It serves the built web UI (`web/dist`) as static files when present,
     with a strict Content Security Policy (`default-src 'self'`), no
     framing, and no CORS.
   - On SIGTERM it stops sessions, closes databases and exits cleanly.
2. **Save credentials.**
   - Implement `Keyring.saveUserKey` and saving the `self.db` passphrase with
     systemd credentials, sealed to the TPM where one exists. With both
     saved, `lyricad` starts unlocked and unattended. Turning it off deletes
     the saved credential.
   - Find the simplest way that works for a non-root service user. If a root
     step is unavoidable, `lyrica admin` prints the exact command.
3. **Login.**
   - A login name and password unlock the user's key. The session cookie is
     `Secure`, `HttpOnly` and `SameSite=Strict`, with a random 256-bit ID.
     Sessions live in memory only.
   - A browser can stay logged in as several users (a user's personas) at once,
     and switching between them needs no new password. How that's carried is
     your call.
   - Logging out ends the cookie session. The user's key stays in memory so
     sleep can run, until `lyricad` restarts or the user chooses **Lock**. Lock
     drops the key and every session of that user.
   - Login attempts are rate-limited per login name and per address.
   - Every state-changing request needs the cookie and a matching `Origin`.
4. **Threads and sessions.**
   - Each active thread is one Pi session from `openThreadSession`, with
     `createLyricaExtension` and that thread's workspace tools.
   - A session opens on first use and is disposed after it has been idle for
     a while. Entries are already stored, so reopening loses nothing.
   - One turn runs at a time per thread. A message sent during a turn waits
     as a follow-up. **Stop** aborts the turn.
   - Endpoints:
     - list threads, with subagents under their parents, honouring the
       display filters and hidden threads;
     - create a thread (pool, interface `web`);
     - rename, hide and unhide;
     - read and change a thread's settings: models per task, local-only,
       network switches and hosts, folders, target, permission mode, and
       "Do not log";
     - page through its messages.
   - Settings that the router or workspace would refuse are refused when
     saved, with the reason, not at the next turn. Examples: a cloud model in
     a private thread, a folder outside the allowed paths, a wider setting
     for a subagent.
   - After the first exchange, a thread is titled by the `titles` task model,
     through the thread's own `CallContext`.
5. **Streaming.** There is one SSE stream per thread. It carries:
   - text deltas;
   - tool calls (start, with arguments; end, with a short result);
   - recall and remember markers;
   - permission requests;
   - usage;
   - errors, including the model router's refusals in plain words;
   - turn end.

   Delegation's events join the stream when that thread lands. A reconnect
   with `Last-Event-ID` replays from a small in-memory buffer; anything older
   reloads from stored entries.
6. **Permission prompts.**
   - In the "ask" modes, a tool call waits until any open view of the thread
     answers: allow once, or deny.
   - A timeout denies.
   - Hook into Pi's tool-call event in the extension, not around the tools.
7. **Uploads.** A file is saved into the thread's `uploads/` with
   `workspace.saveUpload`, subject to a size limit. The reply gives the path
   she sees.
8. **Settings API.**
   - **Each user:**
     - profile: display name and pronouns, theme (device, light or dark),
       accent colour and monogram;
     - password change;
     - endpoints and model profiles, with probe status;
     - per-pool network defaults;
     - SSH targets.
   - **Administrators:**
     - users and the administrator flag (the last administrator can't be
       demoted);
     - allowed paths;
     - shared endpoints;
     - the sleep time;
     - persona proposals (list, approve, reject).
9. **Memory browser API**, through `openOwnerView`:
   - search, and show a memory with its lineage (what it cites and what cites
     it);
   - edit as a revision, and restore a revision;
   - the four deletion levels;
   - add a note or page, linked to threads, messages or memories, or free
     (User introduced).

   Text is sent with its mention tokens plus a map of users, so the UI shows
   current names and edits keep the tokens.
10. **Local socket.** The same API on a Unix socket (mode `0600`, owned by the
    service user), for the CLI later. Login is still required.
11. **API types.** Every request, response and event type is defined in
    `daemon/src/api.ts`. The web UI imports the types only. Push this file
    early: the Web UI thread starts from it.
12. **Logs** carry method, route, status and timing, and never message,
    memory or file text.
13. **Deployment.** Write a systemd unit and a Caddyfile example matching
    DESIGN.md ("Reaching the web UI": DNS-01, Tailscale and LAN addresses).
    - Test each unit hardening option against bubblewrap, pasta and gocryptfs
      before keeping it. For example, `NoNewPrivileges` breaks the setuid
      `fusermount`.

## Out of scope

- The web UI (Web UI thread).
- The `lyrica chat` and `lyrica mem` clients.
- The scheduler and sleep endpoints (Sleep thread).
- Delegation's own events, beyond forwarding them.
- Integrations.
- Exporting threads between interfaces.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, with a fake model server and a temporary runtime directory, show
  that:
  - a locked `lyricad` answers only the state and unlock endpoints;
  - a wrong password is refused and repeated attempts are slowed down;
  - the cookie has the required flags, and a cross-origin POST is refused;
  - one user's session can't reach another user's threads, settings or
    memory;
  - saving a cloud model for a private thread is refused;
  - a sent message streams back, is stored, and is still there after a
    restart;
  - a reconnect with `Last-Event-ID` replays the events it missed;
  - in an "ask" mode, `bash` waits for approval, and deny or a timeout
    stops it;
  - an upload lands in `uploads/` and her `read` can open it;
  - Lock drops the key, and that user's requests fail until they log in
    again;
  - logs contain no message text (test with a marker string);
  - with saved credentials (from a test credentials directory), it starts
    unlocked.
- `docs/daemon.md` describes what exists, including deployment, and any
  contract change is listed in the pull request description.

## Handoff notes

- **Done:** everything in scope, with the tests listed above. The upload test
  needs bubblewrap and gocryptfs as a non-root user, so it runs in CI only.
- **Not verified on a real host:** the systemd unit (no systemd in the build
  container). Check on the owner's LXC: the service starts and unlocks with saved
  credentials (lyricad decrypts sealed files itself through stdout with
  `systemd-creds decrypt --user`, systemd 256 or later), and `PrivateTmp`,
  `ProtectControlGroups` and `ProtectHostname` don't break bubblewrap, pasta
  or gocryptfs. Drop any that do.
- Delegation's events reach the stream through `HostedThread.publish`
  (`daemon/src/hosted.ts`).
