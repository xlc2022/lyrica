# Brief: Bootstrap (the setup state, her name, the tailnet)

**Thread:** Bootstrap. **Branch:** `feature/bootstrap`. **Model:** Opus.
**Followed by:** Web: bootstrap ([web-bootstrap.md](web-bootstrap.md)),
which builds on this brief's API and can start once the interfaces in
`daemon/src/api.ts` are agreed. **Touches the same files as:** Releases
([releases.md](releases.md): `install.sh`'s layout and closing lines,
`lyricad.service`, the NixOS unit); whichever merges second merges main in
and keeps both.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Storage, encryption
and unlocking", "Persona" and "Runtime" (Deployment, Reaching the web UI),
docs/daemon.md, docs/contracts.md `core/keyring` and `daemon`, and
`/mnt/project-files/bootstrap/proposal.md` for the reasoning. Li agreed to
the proposal on 2026-10-11.

## Goal

A fresh install is `install.sh` (or `nixos-rebuild switch`), one page in
the browser, and a conversation from a phone a few minutes later
(principle 1: every install from now on is a first run). Nothing is typed
at a terminal prompt, and the tailnet is joined, left and changed from
Administration. No new model-facing tool, no new process of Lyrica's
(principle 8).

## In scope

1. **`bootstrap()` in core** (`core/src/keyring.ts` or a small
   `core/src/bootstrap.ts`): what `lyrica admin init` does today, in one
   function: `initSelf(passphrase)`, the persona seed, `self.name`, the
   first administrator. `admin init` calls it (with one more prompt, her
   name, default Lyrica) and so does the daemon. If anything fails before
   the user exists, `self.db` is removed so the next attempt starts clean.
2. **The setting-up state** (`daemon/src/lyricad.ts`): without
   `<runtime>/self.db`, `lyrica serve` starts instead of throwing. `GET
   /api/state` answers `{ setup: true, name: "Lyrica", users: [] }`; `POST
   /api/setup` (`SetupRequest { code, passphrase, saveCredentials, name,
   admin: { login, password, displayName, pronouns } }`) runs `bootstrap()`,
   saves the passphrase when asked (as `PUT …/admin/passphrase` does),
   calls `unlocked()`, logs the administrator in and answers a
   `LoginResponse`. Everything else is `503` as while locked. Rate limited
   like unlock.
3. **The setup code.** At start in this state `lyricad` makes a one-time
   code: eight characters in two groups from a 32-symbol alphabet
   (Crockford's base32, no 0/O or 1/I, from `crypto.randomBytes`), 40
   bits, logged once ("Set up Lyrica at http://127.0.0.1:7340 with the
   code XXXX-XXXX") and written to `<runtime>/setup-code` (0600). `lyrica
   admin setup-code` prints it. A wrong code is `403` and counts on the
   unlock limiter (`limited(d, ["unlock:<ip>"])` in `daemon/src/routes.ts`,
   the same counter); the file is deleted when setup completes.
4. **Where the setup page is reachable:** `127.0.0.1` and the Unix socket
   as always, and, only while setting up, the host's existing Tailscale
   addresses (plain HTTP on Tailscale's own interface, the external-proxy
   rule; `hostAddresses()` in `daemon/src/web/access.ts` already finds
   them). That listener closes when setup completes.
5. **Her name** (`self.name` in `self.db` `settings`, default Lyrica):
   `PersonaStore.read()` puts it in REGISTER.md's `Name:` line (the seed
   file is unchanged); the delegate preambles and the "Ask Lyrica" label
   take it; `lyricaIdentity(self, name)` for host pairing; `State.name`
   (while locked and setting up too); `GET`/`PUT /api/u/:userId/admin/name`
   (`{ name }`, administrators, 1 to 40 characters, trimmed). Nothing
   already written is rewritten.
6. **The tailnet** (`daemon/src/tailnet.ts`), through the `tailscale` CLI,
   run by the daemon directly (never in a sandbox, never a model tool):
   - `GET /api/u/:userId/admin/tailnet` → `Tailnet { state: "connected" |
     "disconnected" | "notJoined" | "notInstalled", tailnet?, address?,
     dnsName?, hostname?, controlServer?, version?, reason? }` from
     `tailscale status --json` (and `--peers=false`); `notInstalled`
     covers a missing binary and `lyrica` not being the operator, with
     `reason` saying which.
   - `PUT …/admin/tailnet` with `TailnetJoin { authKey, hostname?,
     controlServer?, leave?: boolean }`: `tailscale login --auth-key
     file:<path> [--login-server …]`, then `tailscale set --hostname …`
     only when a hostname was given, so preferences an operator set by
     hand (`--ssh`, `--accept-routes`, anything non-default) survive; never
     `up` with flags, which fails unless every non-default flag is
     repeated, and never `--reset`. Already joined to a different tailnet
     and `leave` not set is `409`; with `leave`, `logout` first. The key is written to a 0600 file under the runtime directory
     and deleted when `up` returns, whatever the outcome; it never appears
     in arguments, logs or the database. Errors from the CLI that could
     quote it are redacted as `access.ts` redacts DNS tokens.
   - `POST …/admin/tailnet/disconnect` (`down`), `POST
     …/admin/tailnet/connect` (a bare `up`), `DELETE …/admin/tailnet`
     (`logout`; turns the Tailnet web mode off first when it is on).
   - **It is the machine's tailscaled.** Disconnect, Leave and a join that
     leaves take the whole host off the tailnet, Li's SSH and anything
     else reached over it included, and would cut the request that asked
     for them. So each is refused with `409` and a reason when the request
     arrived over the tailnet (a Tailscale address, or through the Tailnet
     web mode: compare the connection's local address and the proxy's
     forwarded address with `hostAddresses()`), the rule that a change
     never locks the administrator out; the UI says to do it from another
     way in. On a host where Lyrica is one service among others, the
     operator is told this in the guide too.
   - **A fixed allow-list, structurally.** `tailnet.ts` builds every
     command from one table and nothing else can reach the binary:
     `status --json --peers=false`, `login --auth-key file:… [--login-server
     …]`, `up`, `down`, `logout`, `set --hostname …`, `serve --bg
     --https=443 http://127.0.0.1:<port>`, `serve reset`. Never `funnel`,
     `--ssh`, `--advertise-routes`, `--advertise-exit-node`, `--exit-node`
     or `--reset`: the operator right would allow them, and funnel would
     put her login page on the public internet.
   - One change at a time, as Web access does. The setup page's default
     hostname is `self.name` lower-cased; it is sent only when it differs
     from what `status` reports.
   - **Verify at first deployment** (the brief's handoff lists it): that
     `login --auth-key`, `up`, `down`, `logout`, `set --hostname` and
     `serve` are allowed to the operator in the installed Tailscale, and
     that preferences set by hand survive Connect, Disconnect and Connect
     again. If one isn't, the fallback is one
     `sudoers.d` line for exactly those subcommands, written by `install.sh`
     and the module; nothing broader, and nothing in `lyricad.service`.
7. **Web access: the Tailnet mode.** `WebMode` gains `"tailnet"`:
   `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, checked by
   fetching `https://<dnsName>/api/state` before it is saved; on failure
   `serve reset` and the previous mode stays, with the reason (the usual
   ones: MagicDNS or HTTPS certificates off in the tailnet, named so the UI
   can say which switch to flip). Off is `serve reset`. `WebAccess.tailnet:
   { dnsName, certificates: boolean } | null`; the status shows the name
   and the certificate as the other modes do. `frontDoor` adds 443 on the
   Tailscale addresses and the DNS name. The unlock page stays reachable
   after a restart because tailscaled keeps the serve configuration and
   `lyricad` listens on loopback from the start.
8. **Installers.** `install.sh`: install `tailscale` from Tailscale's apt
   repository when it isn't installed (keep an existing one), `tailscale
   set --operator=lyrica`, `After=tailscaled.service` in `lyricad.service`,
   and closing lines that print the setup address and code instead of the
   `admin init` command. NixOS module: `services.lyrica.tailscale` (default
   on) sets `services.tailscale.enable` and `extraSetFlags = [
   "--operator=lyrica" ]`, `tailscale` on lyricad's PATH, and
   `ConditionPathExists` removed. `nix/check-host.sh`: one more line,
   `tailscale status` answers as `lyrica`.

## Out of scope

The setup page and the Administration sections (Web: bootstrap); the
getting-started guide (Operator docs, after the merge); the releases layout
of `/opt/lyrica` (Releases); a per-user nickname for her (not now, Li
2026-10-11); routes, exit nodes and Tailscale SSH.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that: without `self.db` the daemon starts in the setting-up
  state and only `/api/state` and `/api/setup` answer; a wrong code is
  refused and leaves no `self.db`; a setup that fails after `initSelf`
  leaves no `self.db`; after setup `/api/state` is unlocked and the
  administrator is logged in; `admin init` and `/api/setup` produce the
  same `self.db` shape; her set name appears in her context's REGISTER
  line and nowhere else in the persona changes, and in `/api/state` while
  locked; the auth key file is gone after `up` succeeds and after it
  fails, and no log line contains the key; a join while joined elsewhere
  is `409` without `leave`; a disconnect, leave or switch requested over
  a Tailscale address is `409`; the fake CLI never receives `funnel`,
  `--ssh`, `--advertise-routes`, `--advertise-exit-node`, `--exit-node` or
  `--reset`, and joining is `login` followed by `set --hostname` only when
  one was given; the Tailnet mode adds its ports to `frontDoor`; leaving
  the tailnet turns the Tailnet web mode off. The CLI is a fake
  `tailscale` on `PATH` that records its arguments, as the Caddy tests
  fake the admin socket.
- docs/daemon.md (Starting and unlocking, Web access, Deployment, On
  NixOS) and docs/contracts.md describe what exists; the PR lists its
  contract changes.

## After merging

Tell the standing Operator docs thread by cross-session message: first run
is the setup page (the code, the tunnel only when the host isn't on a
tailnet yet), the Tailnet mode, the Tailnet section, Tailscale installed by
`install.sh` and the module, `check-host.sh` after the page. Tell Web:
bootstrap and Releases the merge commit.

## Handoff notes

(The thread fills this in if it stops before it's done.)
