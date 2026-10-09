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
- On SIGTERM it stops every subagent run, sleep and turn, disposes sessions,
  unmounts home workspaces, drops keys, closes `self.db` and exits.

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
- **A session ID is never reused for someone new.** Every login gets a fresh
  session and cookie, and the old session ends; a session left with no users
  (after logout, Lock or an unlink) ends at once. A copied cookie can never
  come to hold a user who logs in later.
- **One browser, one person.** A session holds a set of users that are all
  linked: users of the same person, linked with both passwords
  (`…/links`; an unknown login costs the same Argon2 as a known one).
  Everything a user owns is under `/api/u/:userId/…`, and the session must
  hold that user. Logging in as a linked user brings the session's users
  along into the new session, and switching is just using the other path;
  logging in as anyone else leaves them behind (`replaced: true`, without
  naming them). Unlinking takes the other user out of every session that
  holds both.
- `POST /api/logout` ends the session, or with `userId` removes one user from
  it. The key stays in memory, so sleep can run, unless the user turned
  "stay unlocked" off (`…/me/stay-unlocked`, in their `user.db`): then it is
  dropped as with Lock, once no other live browser session holds them. The
  same happens when a session expires, or when an unlink takes the user out.
  The response lists who stays unlocked because another session holds them.
  `Me.warning` points out saved credentials with stay-unlocked off: the key
  then comes back at every start.
- **Lock** (`POST /api/u/:userId/lock`) at once removes the user from every
  session, stops their subagent runs and sleep (which record how they ended), drops
  their key, then stops their threads and unmounts their home. Event
  streams check the session with every event and every few seconds, so
  logout and Lock end them.
- Login, unlock, password changes and linking are rate-limited per login
  name and per address: three failures are free, then each attempt waits twice as long as
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
- Forgetting a thread forgets its subagents' threads with it, deepest first,
  stopping their runs and dropping their records (`Delegation.forget`).
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
A subagent run's events (started, output, tool calls, questions, usage,
finished, stopped, interrupted) go out as `delegation` to the parent thread's
stream and to the subagent's own thread's stream. A background run's result
or question, delivered into the thread, goes out as `notice`, and is stored:
the message list shows it as a `notice` message.

## Subagents

`lyricad` builds one `Delegation` (Delegation's default limits). Every hosted
thread under the depth limit gets the `delegate` tool
(`createDelegateExtension`), which attaches the live session, so a
background run's result reaches her at once: appended if she is idle, as a
follow-up if she is busy. With no live session it goes into the stored
thread. `GET …/threads/:pool/:threadId/subagents` lists a thread's runs and
their total tokens. `…/roles` and `…/workflows` read and change the user's
custom roles and saved workflows (`DelegationStore`, in `user.db`).

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
display settings (in `user.db`), passwords, endpoints, offerings, Clean up
and the models notice, profiles, network
defaults, SSH targets, and for administrators users, allowed paths, shared
endpoints, the sleep time (`sleep.time` in `self.db`'s `settings`) and persona
proposals.

**Persona proposals** come from one user's conversation or dream, so they
may carry that user's details. They start as drafts in that user's `user.db`
(`PersonaProposals.propose`, which takes the thread's own view, so whose a
proposal is comes from the store, never from the caller), which only they
can read: `…/proposals` lists, edits, drops and sends them on. Sending puts
one in `self.db` for the administrators (`…/admin/proposals`), marked with
who sent it and whether they edited it. A proposal from an administrator's
own conversation goes there at once. Each keeps the file's revision it was
drafted against: if the file has changed since, approving it needs
`overwrite`, so newer changes aren't undone unseen.

## Sleep

`lyricad` builds one `Sleep` ([sleep.md](sleep.md)) and runs it three ways:

- **At night.** At `sleep.time` (local time, default 04:00) it sleeps every
  user's general pool, then private pool, one at a time
  (`Lyricad.sleepNight`). A user in manual mode is left out; a user without
  a key, or a pool with nothing new, is skipped with the reason.
  Before that, it prunes gone models nothing names (`Models.prune`,
  [models.md](models.md)).
- **`/sleep`.** `POST …/sleep/:pool`, or the text `/sleep` sent to a thread
  (which sleeps the thread's pool and starts no turn). In manual mode it
  answers `confirm` unless confirmed, and once the run ends a fresh thread
  opens in that pool (a `thread` event). Whatever would stop the run at once
  (no key, endpoint down, nothing new) is a `409` in plain words, and the
  skip is recorded.
- **The Sleep section.** `GET …/sleep` gives the mode (`sleep.mode` in
  `user.db`, set with `PUT …/sleep/mode`), the time, open items and recent
  runs of both pools. `GET …/sleep/:pool/runs/:runId` gives one run: notes she
  caught up on, pages with their text before and after, questions, the dream,
  WAKE and items. `POST …/sleep/:pool/items/:itemId/chat` starts a web thread
  from an item and has her speak first; `DELETE` dismisses one.
  `GET …/sleep/events` streams `started`, `phase`, `finished` and `thread`.

Lock and shutdown stop a running sleep before the key goes; the run is
recorded as partial and resumes next time.

## Logs

One line per request: method, route pattern (never the path, which holds
IDs), status and time. Failures log the error's class and first line. Sleep
logs the pool, the status or skip reason and the time taken. Message, memory
and file text never reach the log.

## Web access

How Lyrica is reached from other machines, set by an administrator
(`…/admin/web-access`, with `/status` and `/snippet`). Code:
`daemon/src/web/`. The mode, name and built-in settings live in `self.db`
under `web.access`, so the DNS credentials are encrypted with the rest of it.
Secret credentials are never sent back by the API (only whether they're set)
and never logged; a Caddy error that quotes one has it replaced with
`[hidden]`. Changes run one at a time.

- **Off** (the start): only `127.0.0.1` and the Unix socket.
- **Built-in Caddy.** The administrator picks the name, the Tailscale and/or
  LAN addresses to serve on (detected from the host's interfaces), the DNS
  provider and its credentials, an optional ACME email, and Let's Encrypt
  staging for testing. `lyricad` writes Caddy's whole JSON config through its
  admin socket (`POST /load`): HTTPS for the name on those addresses (no
  port 80), a DNS-01 certificate through the provider, and `reverse_proxy` to
  `127.0.0.1:<port>`. Caddy saves it (`--resume`), so it keeps serving while
  `lyricad` is locked; after unlock, `lyricad` loads it again only if Caddy's
  differs.
- **A new name never locks the administrator out.** While the name changes,
  Caddy serves the old and the new name together. `lyricad` waits up to 90
  seconds for a certificate for the new name that verifies (with staging, any
  certificate for the name), then drops the old one. If none comes (no DNS
  record yet, a token for the wrong zone), the old config goes back, nothing
  is saved, and the reason comes back with Caddy's TLS error.
- Caddy's TLS errors never reach the journal (a DNS plugin can quote its
  token in one): they go to `/run/lyrica-caddy/tls.log`, readable only by the
  `lyrica-caddy` group. The status shows the newest one since the last change,
  with credentials hidden; whether Caddy answers, has a site at all (it has
  none if its saved config had to be set aside at start), and runs the
  expected config; and the certificate's issuer and expiry, read by
  connecting to the name on the first address.
- **Providers** are one table, `daemon/src/web/providers.ts`: Cloudflare,
  Porkbun, Namecheap, Route 53, DigitalOcean, Hetzner, deSEC and Duck DNS,
  each with its pinned plugin, credential fields and how to make a token
  limited to one zone. Adding one is a row there and running `install.sh`
  again.
- **External proxy.** `lyricad` opens an extra listener on one of this
  machine's Tailscale or LAN addresses and a port. Only the listed proxy
  addresses may connect, and only their `X-Forwarded-For` is believed. On an
  address on Tailscale's own interface it is plain HTTP, since Tailscale
  encrypts (an address in `100.64.0.0/10` on another interface doesn't
  count); elsewhere it is HTTPS with a certificate `lyricad` makes for the
  address only (P-256, ten years), whose fingerprint and PEM the panel shows
  for the proxy to pin. It is made again only when the address changes, so a
  new name keeps the pin. `/snippet` is the proxy's Caddyfile site, with a
  reminder to get its certificate by DNS-01.
- The extra listener's settings (address, port, proxies, the proxy's own
  port) and its TLS key are kept in `<runtime>/web-external.json`, mode
  `0600`, not in `self.db`: `lyricad` opens the listener at start, before
  unlock, and there it answers only state, unlock and the web UI's files,
  like every other listener. A new listener opens before the old one closes;
  if it can't, the old one stays.
- **Sandboxes never reach the front door.** `Workspace` reads it at every
  sandbox start (`frontDoor`): the front port (443, or the external proxy's
  own port) on this machine's addresses, on every address the name has
  resolved to, and on the external proxy's addresses; and the extra
  listener's port on every address. If the name has never resolved, the
  sandbox gets no network for that run
  ([workspace.md](workspace.md#network-access-from-tools)).

## Deployment

`daemon/deploy/install.sh`, run as root on Debian or Ubuntu from a checkout,
installs or upgrades everything. Running it again upgrades in place.

- It installs the packages (bubblewrap, gocryptfs, FUSE, passt, nftables,
  openssl), checks for Node.js 22 or later, and creates two system users:
  `lyrica` runs `lyricad`, `lyrica-caddy` runs Caddy. The `lyrica-caddy`
  group shares Caddy's admin socket (mode `0660`) and TLS log; lyricad's unit
  joins it (`SupplementaryGroups`), and nobody else can use them. An allowed
  path that overlaps `/run/lyrica-caddy` is refused, since sandboxes run with
  lyricad's groups.
- It copies the code to `/opt/lyrica` and runs `npm ci --omit=dev`.
- It builds Caddy (`/usr/local/bin/lyrica-caddy`) with `xcaddy`, from pinned
  versions, in a clean environment (`env -i`, `GOENV=off`, `GOPROXY` and
  `GOSUMDB` set): Go from `proxy.golang.org`, checked against the sha256 in
  the script; xcaddy, Caddy and every plugin in the provider table at their
  pinned versions, checked by Go against `sum.golang.org`. It rebuilds only
  when a pin changes.
- It sets `net.ipv4.ip_nonlocal_bind=1` (in `/etc/sysctl.d`), so Caddy binds
  its addresses even before they're up: Tailscale at boot, a DHCP change.
- It installs `lyricad.service` and `lyrica-caddy.service` and starts them,
  or says how to run `lyrica admin init` first.
- **lyricad's unit** runs `lyrica serve` as `lyrica`, with `StateDirectory`
  for the runtime and the credentials directory, and `LoadCredentialEncrypted`
  for saved credentials. Hardening: `NoNewPrivileges` breaks the setuid
  `fusermount3`, so homes never mount, and so does every option that makes
  systemd set it for a non-root service, because they install seccomp filters
  (listed in the unit; `ProtectHostname` is one of them). `RestrictNamespaces`
  and `PrivateUsers` also break bubblewrap and pasta. The unit keeps only
  `PrivateTmp` and `ProtectControlGroups`.
- **Deploy check:** `grep NoNewPrivs /proc/$(systemctl show -p MainPID --value lyricad)/status`
  must show `0`.
- **Caddy's unit** runs `caddy run --resume`, starting from
  `/etc/lyrica/caddy.json`, which only puts the admin API on its Unix socket.
  It is never on `localhost:2019`: a thread with "this machine's services" on
  reaches loopback ports, and the admin API could replace the site with a
  fake login page. Caddy needs none of what lyricad's sandboxes need, so its
  unit is fully hardened. Before it starts, a saved config that no longer
  loads (`caddy validate`) is moved aside, so Caddy still comes up with its
  admin socket and `lyricad` can apply the setup again. Its saved config,
  which holds the DNS token, stays in its own state directory (`0700`).
