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
   admin setup-code` prints it, with the Direct certificate's fingerprint.
   The file is the `lyrica` user's; the `lyrica` command on PATH from #118
   (install.sh's wrapper on Debian and Ubuntu, the module's on NixOS)
   switches to her user and sets `LYRICA_HOME` itself, so the operator
   runs `lyrica admin setup-code` as root as is. On NixOS nothing prints
   the code or the fingerprint at `nixos-rebuild`, so that command is the
   operator's first-run step there. A wrong code is `403` and counts on the
   unlock limiter (`limited(d, ["unlock:<ip>"])` in `daemon/src/routes.ts`,
   the same counter); the file is deleted when setup completes.
4. **Where the setup page is reachable: the Direct mode.** Without
   `self.db`, and with no web access set, `lyricad` starts in a new
   `WebMode` `"direct"`: the external-proxy mode's extra listener
   (`web-external.json`, opened before unlock, `makeCertificate` for a LAN
   address, plain HTTP on Tailscale's own interface) on **every** LAN and
   Tailscale address `hostAddresses()` finds, port 7340, with no proxy
   allow-list and the client's own address as its address. The host is
   headless (Li), so this is how the setup page is reached:
   `https://<lan address>:7340`, the browser's one-time certificate
   warning, the fingerprint printed by `install.sh` and shown in Web access
   for comparing. Direct stays on after setup until an administrator turns
   it off or another mode replaces it (finishing setup without a tailnet
   must not lock anyone out); `frontDoor` includes its port on those
   addresses. The listener's settings file is written at first start when
   none exists, so a host that already had web access set keeps it.
5. **Her name** (`self.name` in `self.db` `settings`, default Lyrica):
   `PersonaStore.read()` puts it in REGISTER.md's `Name:` line (the seed
   file is unchanged); the delegate preambles and the "Ask Lyrica" label
   take it; `lyricaIdentity(self, name)` for host pairing; `State.name`
   (while locked and setting up too); `GET`/`PUT /api/u/:userId/admin/name`
   (`{ name }`, administrators, 1 to 40 characters, trimmed). Nothing
   already written is rewritten.
6. **The tailnet** (`daemon/src/tailnet.ts`): **her own tailscaled.**
   `lyrica-tailscaled.service` (installed by `install.sh` from Tailscale's
   package, and by the NixOS module from `pkgs.tailscale`) runs
   `tailscaled --tun=userspace-networking --state=/var/lib/lyrica-tailscale/tailscaled.state
   --socket=/run/lyrica-tailscale/tailscaled.sock --port=0` as the `lyrica`
   user with its own `StateDirectory` and `RuntimeDirectory`; no root, no
   TUN device, no operator setting, and the host's own Tailscale, if any,
   untouched. She is a device of her own with her own address and MagicDNS
   name, beside the host's. `lyricad` drives it with the `tailscale` CLI
   and `--socket` pointing at hers, run by the daemon directly (never in a
   sandbox, never a model tool). Userspace networking carries inbound
   connections through `serve`; her outbound traffic to tailnet peers
   (model hosts, machines, allowed hosts) keeps going through the host's
   network as today, so DESIGN's "a host that should reach peers over the
   tailnet joins it itself" holds; the brief doesn't add the SOCKS proxy.
   - `GET /api/u/:userId/admin/tailnet` → `Tailnet { state: "connected" |
     "disconnected" | "notJoined" | "notInstalled", tailnet?, address?,
     dnsName?, hostname?, controlServer?, version?, reason? }` from
     `tailscale status --json` (and `--peers=false`); `notInstalled`
     covers a missing binary and her tailscaled not running, with
     `reason` saying which.
   - `PUT …/admin/tailnet` with `TailnetJoin { authKey, hostname?,
     controlServer?, leave?: boolean }`: `tailscale login --auth-key
     file:<path> [--login-server …]`, then `tailscale set --hostname …`
     only when a hostname was given, so preferences already set on her
     device survive a second join; never `up` with flags, which fails
     unless every non-default flag is repeated, and never `--reset`. Already joined to a different tailnet
     and `leave` not set is `409`; with `leave`, `logout` first. The key is written to a 0600 file under the runtime directory
     and deleted when `login` returns, whatever the outcome; it never appears
     in arguments, logs or the database. Errors from the CLI that could
     quote it are redacted as `access.ts` redacts DNS tokens.
   - `POST …/admin/tailnet/disconnect` (`down`), `POST
     …/admin/tailnet/connect` (a bare `up`), `DELETE …/admin/tailnet`
     (`logout`; turns the Tailnet web mode off first when it is on).
   - **Not over her own tailnet address.** Disconnect, Leave and a join
     that leaves would cut the request that asked for them when it came
     through her device (the Tailnet web mode: a connection on the serve
     port, item 7, which only `serve` targets, so the listener alone
     decides and no header is trusted), so
     each is refused with `409` and a reason then, the rule that a change
     never locks the administrator out; the UI says to do it over the LAN
     or on the machine. The host's own tailnet, SSH and routes are
     unaffected either way.
   - **A fixed allow-list, structurally.** `tailnet.ts` builds every
     command from one table and nothing else can reach the binary:
     `status --json --peers=false`, `login --auth-key file:… [--login-server
     …]`, `up`, `down`, `logout`, `set --hostname …`, `serve --bg
     --https=443 http://127.0.0.1:<port>`, `serve reset`. Never `funnel`,
     `--ssh`, `--advertise-routes`, `--advertise-exit-node`, `--exit-node`
     or `--reset`: funnel would put her login page on the public
     internet, and the rest are a host's business, not hers.
   - One change at a time, as Web access does. The setup page's default
     hostname is `self.name` lower-cased; it is sent only when it differs
     from what `status` reports.
   - **Verify at first deployment** (the brief's handoff lists it): that
     the userspace tailscaled runs as `lyrica` with `serve` on 443 (the
     listener is inside tailscaled's own stack, so no capability should be
     needed; if the installed version does bind a host port,
     `AmbientCapabilities=CAP_NET_BIND_SERVICE` goes on its unit, nothing
     on lyricad's), and that a host already on a tailnet shows two
     devices with two addresses.
7. **Web access: the Direct and Tailnet modes.** `WebMode` gains
   `"direct"` (item 4; its state line shows the addresses and the
   certificate's fingerprint) and `"tailnet"`:
   `tailscale serve --bg --https=443 http://127.0.0.1:<serve port>`, where
   the serve port is a second loopback listener of `lyricad`'s that
   nothing else targets; checked by
   fetching `https://<dnsName>/api/state` before it is saved; on failure
   `serve reset` and the previous mode stays, with the reason (the usual
   ones: MagicDNS or HTTPS certificates off in the tailnet, named so the UI
   can say which switch to flip). Off is `serve reset`. `WebAccess.tailnet:
   { dnsName, certificates: boolean } | null`; the status shows the name
   and the certificate as the other modes do. `frontDoor` adds 443 on the
   Tailscale addresses and the DNS name. The unlock page stays reachable
   after a restart because tailscaled keeps the serve configuration and
   `lyricad` listens on loopback from the start.
8. **Installers.** `install.sh`: install the `tailscale` package from
   Tailscale's apt repository when the binaries are missing (a host's own
   `tailscaled.service` is left as it is), install and enable
   `lyrica-tailscaled.service` (`daemon/deploy/`; hardened like Caddy's
   unit, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
   `PrivateTmp`, since it needs nothing of what lyricad's sandboxes
   need; under `ProtectSystem=strict` every path it writes must be its
   `StateDirectory` or `RuntimeDirectory`, so add `CacheDirectory=` if
   the installed version writes a cache), `After=` it in
   `lyricad.service`, and closing lines that print the setup addresses,
   the certificate fingerprint and the code instead of the `admin init`
   command. NixOS module: `services.lyrica.tailscale` (default on) declares
   the same unit from `pkgs.tailscale`, `tailscale` added to the `PATH`
   list the module sets for lyricad, `ConditionPathExists` removed, and a
   `services.lyrica.openFirewall` option that opens 7340. It defaults to
   on, against the NixOS convention, on purpose: it matches Debian, a
   headless first run needs it, and the port answers only while the setup
   page or the Direct mode is on (NixOS blocks incoming ports by default;
   Debian has no default firewall). `nix/check-host.sh`: one more line,
   `tailscale --socket … status` answers as `lyrica`.

## Out of scope

The setup page and the Administration sections (Web: bootstrap); the
getting-started guide (Operator docs, after the merge); the releases layout
of `/opt/lyrica` (Releases); a per-user nickname for her (not now, Li
2026-10-11); routes, exit nodes and Tailscale SSH; her own outbound path
to tailnet peers through her device (a SOCKS proxy for sandboxes and
machines; later, if a host that isn't on the tailnet needs it).

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that: without `self.db` the daemon starts in the setting-up
  state and only `/api/state` and `/api/setup` answer; a wrong code is
  refused and leaves no `self.db`; a setup that fails after `initSelf`
  leaves no `self.db`; after setup `/api/state` is unlocked and the
  administrator is logged in; `admin init` and `/api/setup` produce the
  same `self.db` shape; her set name appears in her context's REGISTER
  line and nowhere else in the persona changes, and in `/api/state` while
  locked; the auth key file is gone after `login` succeeds and after it
  fails, and no log line contains the key; a join while joined elsewhere
  is `409` without `leave`; a disconnect, leave or switch requested
  through her own tailnet listener is `409`; every `tailscale` call names
  her socket; the Direct listener opens on every LAN address with the
  certificate and refuses nothing by address; the fake CLI never receives `funnel`,
  `--ssh`, `--advertise-routes`, `--advertise-exit-node`, `--exit-node` or
  `--reset`, and joining is `login` followed by `set --hostname` only when
  one was given; the Tailnet mode adds its ports to `frontDoor`; leaving
  the tailnet turns the Tailnet web mode off. The CLI is a fake
  `tailscale` on `PATH` that records its arguments, as the Caddy tests
  fake the admin socket.
- docs/daemon.md (Starting and unlocking, Web access, Deployment, On
  NixOS) and docs/contracts.md describe what exists; the PR lists its
  contract changes. The handoff names the operator's first-run command
  on both systems (`lyrica admin setup-code`, through #118's wrappers) so
  the guide gets it right.

## After merging

Tell the standing Operator docs thread by cross-session message: first run
is the setup page (the LAN address, the fingerprint and the code; no
tunnel), the Direct and Tailnet modes, the Tailnet section, her own
tailscaled installed by `install.sh` and the module, `check-host.sh` after
the page. Tell Web:
bootstrap and Releases the merge commit.

## Handoff notes

Built on `feature/bootstrap-ri74ui` (2026-10-12).

- **Operator's first run.** Debian/Ubuntu: `install.sh` ends by printing
  the setup addresses, the certificate's fingerprint and the code; again any
  time with `lyrica admin setup-code` as root. NixOS: after `nixos-rebuild
  switch`, `lyrica admin setup-code` as root is the first-run step (nothing
  prints at rebuild). Then `https://<lan address>:7340`, compare the
  fingerprint in the browser's warning, enter the code. `lyrica admin init`
  still works from a terminal instead.
- **Changed from the brief.** Direct serves HTTPS on Tailscale addresses
  too: the login cookie is `__Host-`/`Secure`, which browsers drop over
  plain HTTP on a 100.x address. The Tailnet mode's fetch check can't always
  run from this machine (it need not be on her tailnet), so MagicDNS and the
  certificate domains are checked from `tailscale status` as hard
  conditions, the fetch decides `certificates`, and Direct stays on beside
  Tailnet until a later switch confirms the name answers. `controlServer`
  isn't read back: `status --json` doesn't carry it.
- **Verify at first deployment:** her tailscaled starts as `lyrica` under
  the unit's hardening (`Type=notify`, `ProtectSystem=strict`, its own
  state, cache and runtime directories); `serve` on 443 works without a
  capability; a bare `tailscale up` after `set --hostname` doesn't ask for
  every flag; a host already on a tailnet shows two devices; install.sh's
  Tailscale repository lines on Debian 12 and Ubuntu 24.04.
