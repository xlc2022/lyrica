# lyricad

`lyricad` is the one long-running process. It unlocks, logs users in, hosts
their threads as in-process Pi sessions, and serves the HTTP and SSE API the
web UI is built on. Code: `daemon/src/`. Every request, response and event
type is in `daemon/src/api.ts`, with its route beside it.

## Starting and unlocking

`lyrica serve [--runtime <dir>] [--port <port>]` starts it. It listens on
`127.0.0.1` only (default port 7340) and on a Unix socket,
`<runtime>/lyricad.sock`, mode `0600`. The socket serves the same API to local
clients; they still log in.

- It starts **locked**. Until `self.db` is unlocked, only `GET /api/state`
  and `POST /api/unlock` answer (and the web UI's static files, so the unlock
  page loads); everything else is `503`.
- Run by hand in a terminal, it asks for the passphrase at a hidden prompt.
- With a saved passphrase (below), it starts unlocked.
- When unlocked it builds `Workspace` with its own port as `excludePorts`, and
  runs `selfTest()`. If network is refused, the reason is logged and shown to
  administrators (`GET …/admin/status`).
- On SIGTERM it stops every turn, disposes sessions, unmounts home
  workspaces, drops keys, closes `self.db` and exits.

## Saving credentials

"Save credentials" uses systemd credentials. `lyricad` seals a secret with
`systemd-creds encrypt` (to the TPM where there is one, else the host key),
reading it on stdin, into `<runtime>/credentials/<name>`. The unit loads that
directory with `LoadCredentialEncrypted=lyrica:…`, and systemd unseals each file
at start into `$CREDENTIALS_DIRECTORY/lyrica_<name>`, readable only by the
service.

- `self`: the `self.db` passphrase. An administrator saves it with
  `PUT …/admin/passphrase` (typing the passphrase, which is checked first).
- `user-<id>`: a user's data key, saved by that user with
  `PUT …/me/credentials` (`Keyring.saveUserKey`). At start `lyricad` takes
  every saved key and mounts those users' home workspaces, so sleep can run.
- Turning either off deletes the sealed file. The unsealed copy lasts until
  the service stops.
- As a non-root service user it seals with `--user`, which needs systemd 256
  or later. No root step is needed.

## Logging in

- `POST /api/login` checks the password, unlocks the user's key and mounts
  their home workspace. It sets `__Host-lyrica`, a random 256-bit session ID,
  `Secure; HttpOnly; SameSite=Strict`, for 30 days. Sessions live in memory
  only; a restart logs everyone out.
- **Several users per browser.** A session holds a set of users. Everything a
  user owns is under `/api/u/:userId/…`, and the session must hold that user.
  Logging in as another persona adds them; switching is just using the other
  path.
- `POST /api/logout` ends the session, or with `userId` removes one user from
  it. The key stays in memory, so sleep can run.
- **Lock** (`POST /api/u/:userId/lock`) at once removes the user from every
  session and drops their key, then stops their threads and unmounts their
  home. Event streams check the session with every event and every few
  seconds, so logout and Lock end them.
- Login, unlock and password changes are rate-limited per login name and per
  address: three failures are free, then each attempt waits twice as long as
  the last, up to 15 minutes (`429` with `Retry-After`). Behind Caddy, the
  address is the last `X-Forwarded-For` entry.
- One attempt per login name and per address runs at a time; others get
  `429` at once, so parallel guesses get no free tries. An unknown login
  still runs Argon2 (against a dummy key), so the time taken doesn't reveal
  which names exist.
- Every POST, PUT, PATCH and DELETE needs an `Origin` whose host matches the
  `Host` header; user routes also need the cookie. There are no CORS headers.
- Every response carries `Content-Security-Policy: default-src 'self'`,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `nosniff`.

## Threads

Each active thread is one Pi session from `openThreadSession`, with
`createLyricaExtension` and the workspace tools, through the thread's own
`openThreadView` and `CallContext`.

- A session opens on the first message and is disposed after 15 idle
  minutes. Entries are stored as turns end, so reopening loses nothing. With
  no stream open, the thread's whole record (with its event buffer) goes too.
- One turn runs at a time. A message sent during a turn waits; queued messages
  go together as the next turn. **Stop** aborts the turn, denies waiting
  permission requests and drops the queue.
- Changing a thread's models or local-only switch reopens its session after
  the current turn. Workspace settings are read on every tool call, so they
  apply at once.
- After the first exchange, an untitled thread gets a title from the `title`
  task model, through the thread's own model runtime.
- Settings are checked when saved, and refused whole with the reason: a cloud
  model in a private or local-only thread, a private thread made not
  local-only, a subagent wider than its parent, a folder outside the allowed
  paths, a host that matches everything.
- Thread lists are per interface (`web` by default), filtered by the user's
  display settings, most recently active first, with subagents nested under
  their parent. Memory search honours the same pool filters; `?all=1` ignores
  them in both.

## The event stream

`GET …/threads/:pool/:threadId/events` is one SSE stream per thread. It
carries text and thinking deltas, tool calls (start with arguments; end with
the first lines of the result), recall and remember markers, permission
requests and their outcome, usage, errors in plain words (a model the router
refused, an endpoint that didn't answer), the queue, the title and turn end.
Delegation's events are forwarded as `delegation` once it lands
(`HostedThread.publish`).

Event IDs are `<epoch>-<n>`; the epoch changes with every start. A reconnect
with `Last-Event-ID` replays from a buffer of the last 500 events. If that's
impossible, the stream starts with `reset` and the client reloads messages
from `…/messages`, which pages through stored entries.

## Permission prompts

In "ask before commands" and "ask before changes", the workspace tools'
`tool_call` hook (`extension/src/workspace.ts`) calls the thread's `approve`.
`lyricad` sends a `permission` event to every open view and waits for
`POST …/permissions/:requestId` with `allow`. Nobody answering in 5 minutes,
or Stop, denies. A view that opens later sees waiting requests in `hello`.

## Uploads

`POST …/threads/:pool/:threadId/uploads?name=<file>` with the file's bytes
(up to 50 MB) saves it with `Workspace.saveUpload` into the thread's
`uploads/`, and answers with the path she sees (`/workspace/uploads/<file>`).
The name is cleaned (no path, no control characters), and a name already
taken gets a suffix (`image-2.jpg`) rather than overwriting.

## Memory browser and settings

The memory browser goes through `openOwnerView`, opened and closed per
request. Memories are sent in stored form, with mention tokens, plus a map of
users, so the UI renders current names and edits keep the tokens. It covers
search, lineage, edit, restore, the four deletion levels and user-introduced
notes and pages. The settings API covers profiles (with accent and monogram),
display settings (in `user.db`), passwords, endpoints and profiles, network
defaults, SSH targets, and for administrators users, allowed paths, shared
endpoints, the sleep time (`sleep.time` in `self.db`'s `settings`) and persona
proposals.

## Logs

One line per request: method, route pattern (never the path, which holds
IDs), status and time. Failures log the error's class and first line.
Message, memory and file text never reach the log.

## Deployment

`daemon/deploy/lyricad.service`, `daemon/deploy/Caddyfile.example` and
`daemon/deploy/caddy-override.conf` (a drop-in for Caddy's unit).

- Install the code at `/opt/lyrica`, create a `lyrica` system user, run
  `lyrica admin init` as that user with `LYRICA_HOME=/var/lib/lyrica`, then
  enable the unit.
- The unit runs `lyrica serve` as `lyrica`, with `StateDirectory` for the
  runtime and the credentials directory, and `LoadCredentialEncrypted` for
  saved credentials.
- Hardening: `NoNewPrivileges` breaks the setuid `fusermount3`, so homes
  never mount, and so does every option that makes systemd set it for a
  non-root service, because they install seccomp filters (listed in the unit;
  `ProtectHostname` is one of them). `RestrictNamespaces` and `PrivateUsers`
  also break bubblewrap and pasta. The unit keeps only `PrivateTmp` and
  `ProtectControlGroups`.
- **Deploy check:** `grep NoNewPrivs /proc/$(systemctl show -p MainPID --value lyricad)/status`
  must show `0`.
- Caddy serves HTTPS for a subdomain on the Tailscale and LAN addresses, with
  a DNS-01 certificate, and proxies to `127.0.0.1:7340`. There is no plain
  HTTP.
- Caddy's admin API listens on a Unix socket (`/run/caddy/admin.sock`), not
  `localhost:2019`: a thread with "this machine's services" on reaches
  loopback ports, and the admin API could replace the site with a fake login
  page.
- Caddy starts after `tailscaled` (the drop-in), and retries on failure,
  because `bind` to the Tailscale address fails until that address exists.
- Sandboxes never reach Caddy on this machine's own addresses: `lyricad`
  passes its front ports (`frontPorts`, default 443) to `Workspace`
  ([workspace.md](workspace.md#network-access-from-tools)).
