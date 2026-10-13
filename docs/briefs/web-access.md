# Brief: Web access

**Status:** Built; on main. Handoff notes below are history.

**Thread:** Daemon (follow-up). **Branch:** `feature/web-access`.
**Depends on:** Daemon (#14, merged) and the Delegation wiring PR. Start
after the wiring PR is open.
**Read first:**
- AGENTS.md;
- DESIGN.md: "Reaching the web UI" and "Deployment";
- docs/contracts.md: `daemon` and `core/workspace`;
- docs/daemon.md and docs/workspace.md.

## Goal

An administrator sets up how Lyrica is reached from the control panel, with
no hand-edited config:
- **Built-in Caddy**, which `lyricad` configures;
- **External proxy**, elsewhere on the network.

Either way, the browser gets HTTPS on the owner's name, and sandboxes can't reach the
front door. This serves principle 1 (the owner sets it up once, from a page) and
principle 2 (one simple boundary).

## In scope

1. **Install script** (`daemon/deploy/install.sh`, run as root on Debian or
   Ubuntu, in the LXC or VM). It:
   - creates the service users;
   - installs `lyricad`'s unit;
   - installs a **pinned Caddy**, built with the DNS plugins for the bundled
     providers.
   - Build it reproducibly with `xcaddy` from pinned module versions, or
     fetch it from Caddy's official build service with the checksum recorded
     in the repo. Never take an unpinned "latest".
   - Run Caddy as its own service (the `caddy-api` style: `--resume`, no
     Caddyfile), with its admin API on a Unix socket that only `lyricad`'s
     user can use, via a shared group and socket mode.
   - Running it again upgrades in place.
2. **Providers.** One table defines the providers:
   - Cloudflare, Porkbun, Namecheap, Route 53, DigitalOcean, Hetzner, deSEC
     and DuckDNS;
   - for each, the plugin module, the credential fields, and a one-line hint
     on making a token limited to one zone.

   Adding a provider means a table row and a rebuild.
3. **Settings** (administrators only), in `self.db`, with the credentials
   encrypted there:
   - **mode**: `builtin` or `external`;
   - **name**: for example `lyrica.example.net`;
   - **built-in:**
     - serve on the Tailscale and/or LAN addresses, detected from the host's
       interfaces and shown with their kind;
     - the provider and its credentials;
     - an optional ACME email, and a staging switch for testing;
   - **external:**
     - the address `lyricad` listens on, a Tailscale or LAN address;
     - the proxy addresses it accepts;
     - on a LAN address, `lyricad` serves HTTPS with a certificate it makes,
       and the panel shows its fingerprint and PEM for pinning.
4. **Applying.**
   - **Built-in:** `lyricad` writes Caddy's whole JSON config through the
     admin socket (`POST /load`). That covers the site on the chosen
     addresses, DNS-01 with the provider, and `reverse_proxy` to
     `127.0.0.1:<port>`. It re-applies after unlock if Caddy's config
     differs. Caddy keeps its saved config, so it serves while `lyricad` is
     locked.
   - **External:**
     - `lyricad` opens the extra listener;
     - it accepts only the listed proxy addresses on it;
     - it trusts `X-Forwarded-For` only from them;
     - Plain HTTP is refused on a non-tailnet address (`100.64.0.0/10`).
     - The panel shows a Caddyfile snippet for the proxy.
   - Changing mode or name never locks the admin out mid-change. Apply the new
     config, check it, and keep the old one if the check fails.
5. **Status** in the panel:
   - the mode, and whether Caddy answers;
   - the certificate's issuer and expiry, read by connecting to the name on
     the host's own address;
   - the last ACME error, if Caddy reports one.
6. **Sandbox front door** (Workspace).
   - Today `frontPorts` are refused on this machine's own addresses. Add the
     external proxy's addresses, and whatever Lyrica's name resolves to when a
     sandbox starts.
   - The extra listener's address and port (external mode) are covered by
     `excludePorts`, which applies on every address.
   - Settings changes take effect at the next sandbox start.
7. **API** in `daemon/src/api.ts`: get and set the web access settings, the
   status, and the snippet. List them in the PR so the Web UI thread can add
   the **Web access** page under the control panel's admin section.

## Out of scope

- Proxies other than Caddy for the built-in mode.
- Public internet exposure: no port forwarding or HTTP challenge.
- Distribution packages (`.deb`).
- The web page itself (Web UI thread).

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that:
  - the generated Caddy config has the right site, addresses, DNS provider
    and upstream, checked against a fake admin socket;
  - credentials are never returned by the API or logged, and are encrypted
    in `self.db`;
  - a normal user can't read or change web access;
  - in external mode, a connection from an unlisted address is refused,
    plain HTTP on a LAN address is refused, HTTPS with the pinned certificate
    works, and forwarded addresses are trusted only from the proxy;
  - a sandbox with internet on can't reach the front door on its own name, on
    the external proxy's address, or on this machine's addresses;
  - a failed apply keeps the previous config.
- The install script runs cleanly twice in a fresh Debian container. Record
  that in the PR if CI can't run it.
- `docs/daemon.md` (deployment, web access) and `docs/workspace.md` describe
  what exists. Any contract change is listed in the PR.

## Handoff notes

(The thread fills this in if it stops before it's done.)
