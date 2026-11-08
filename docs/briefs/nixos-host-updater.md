# Brief: Update a NixOS model host from Lyrica

**Status:** In review (branch `claude/project-thread-u1rb3n`).
**Branch:** a `feature/*` branch of the building thread's choosing.
**Model:** Opus. **Reviews:** PR review (`nix/`, `host/install.sh`, the
updater: all risky). No UI review: nothing a user sees changes except that
**Update…** stops being greyed out.

**Read first:** AGENTS.md; host/README.md, "Updates" and "On NixOS";
[host-updates.md](host-updates.md) (#311) and
[host-update-menu.md](host-update-menu.md) (#797, #811); `host/update.sh`,
`host/install.sh` (the updater block near "Updates from Lyrica"),
`nix/host-module.nix`; and how lyricad's own NixOS updater is declared in
`nix/module.nix` (`updater`, `systemd.services.lyrica-update`,
`systemd.paths.lyrica-update`) with `daemon/test/updater-path.test.ts`.

## Goal

A model host on NixOS can't be updated from Lyrica. `install.sh` sees
`/etc/NIXOS`, installs no updater and reports the reason "Update this host
from its NixOS configuration.", so the host's **Update…** is greyed out.
The operator has to log in to every NixOS host and run `git pull &&
host/install.sh` by hand. A fix such as a Dockerfile change then waits on
that for each host, even though Debian hosts take it with one press.

The tooltip is also misleading. The NixOS module only declares Docker, the
driver, the egress unit and the models folder. The host's code is a plain
checkout, so `nix flake update` and `nixos-rebuild` never bring a new
release.

This serves principle 6 (make review easy: the operator sees an update and
approves it in one place) and principle 2 (one operator, simple
boundaries: one way to update every host, whatever its system).

## Design

Do what `nix/module.nix` already does for lyricad: the module declares the
updater from the store, and the same `host/update.sh` does the work.

1. **The module declares the updater.** `nix/host-module.nix` adds
   `services.lyrica-host.updates.enable` (default `true`, as on Debian,
   where every systemd install gets the updater). With it on, the module
   declares:
   - `lyrica-host-update` as a store copy of `host/update.sh` with a fixed
     PATH. That PATH holds every command `update.sh` runs, and every
     command the `install.sh --yes` it calls runs: bash, coreutils,
     findutils, gnugrep, gnused, gawk, gnutar, jq, curl, git, openssh,
     util-linux (flock), iptables, iproute2, kmod, docker with compose,
     and systemd. An update never replaces it, as on Debian: it changes
     only with a `nixos-rebuild`.
   - `systemd.services.lyrica-host-update` and
     `systemd.paths.lyrica-host-update`, the same as
     `host/lyrica-host-update.service` and `.path`.
   - tmpfiles for `/var/lib/lyrica-host-update` (0755 root),
     `inbox/` (0700, 10001) and `status/` (0755 root), and for
     `/etc/lyrica-host` (0700 root) and `/opt/lyrica-host` (0755 root).
     NixOS leaves unmanaged files in `/etc` writable, so the deploy key
     and `known_hosts` stay where `update.sh` looks for them.
2. **`install.sh` uses the module's updater.** On NixOS, when
   `systemctl cat lyrica-host-update.path` succeeds, `install.sh` does
   everything in its updater block (the repository, HTTPS or the deploy
   key, `current`, `updater_status true`) except installing the script and
   the units, which the module owns. Without the module's updater the
   reason becomes "Set services.lyrica-host.updates.enable, or update with
   git pull and install.sh in the host's folder."
3. **The egress unit follows the running tree.** The module's
   `lyrica-host-egress` runs `${checkout}/host/egress.sh` and checks for
   `${checkout}/host/.env`. After an update the host runs from
   `/opt/lyrica-host/<commit>`, so the unit must read that folder from
   `/var/lib/lyrica-host-update/current` when it exists, and fall back to
   the checkout otherwise. The Debian unit gets its folder from
   `install.sh` each run, so it already follows. This pinned checkout is why
   host/README.md says Lyrica "can't update it".
4. **`checkout` keeps its meaning**: where the operator cloned the repo and
   first ran `install.sh`. After the first update the release tree is the
   installed folder, as on Debian, and `git pull && host/install.sh` in the
   checkout still takes the host back to it.
5. **Uninstall**: `install.sh --uninstall` on NixOS removes the trees, the
   repository and the deploy key. It leaves the units, which belong to the
   module: the operator turns `updates.enable` off and rebuilds.
6. **Folder change** (`--models`) comes along for free. Today NixOS says
   "set `modelsDir` and run `install.sh --models`". With the updater, the
   Models page can change the folder, but the module's `modelsDir`
   tmpfiles rule still names the old one. Either keep `changesFolder`
   false on NixOS, or make the module rule harmless. PR review decides
   which. The simple choice is to keep it false.

## Tests

- A PATH test like `daemon/test/updater-path.test.ts`: every command
  `host/update.sh` and `host/install.sh` call is on the module's updater
  PATH. The NixOS updater broke silently once (#838, no `awk`).
- The `nix` CI job evaluates `model-host` with `updates.enable` on and off.
- The existing `update.sh` tests still pass. No GPU run is needed to merge.
  The first real test is an Update on lunasa's host, then on mystria.

## Docs to update in the same PR

host/README.md ("Updates" no longer says "other than NixOS"; "On NixOS"
drops "can't update it"), host/API.md (the `409 unavailable` reasons),
docs/guides/model-hosts.md (the **On NixOS** bullet under Upgrade, and
step 7 of the install steps), and the NixOS line in docs/guides/getting-started.md
if it mentions host upgrades. Tell Operator docs: each NixOS host needs one
`nix flake update lyrica && nixos-rebuild switch`, then one `git pull &&
host/install.sh` in its checkout, before **Update…** works there.

## Out of scope

Building the host's images with Nix, or putting host code in the Nix store.
The host stays a Docker stack built by `install.sh`. lyricad's own updater
doesn't change.

## Handoff

**Done:** `nix/host-module.nix` declares `updates.enable` (default on):
`lyrica-host-update` from the store (`host/update.sh` with a fixed PATH;
`host/test/updater-path.test.ts` checks every command the host scripts run
is on it), the service and path units, and the updater's folders as
tmpfiles. The egress unit runs `egress.sh` from the folder in
`/var/lib/lyrica-host-update/current`, falling back to `checkout`, and
carries `checkout` in `LYRICA_HOST_CHECKOUT` for `install.sh`'s check.
`install.sh` on NixOS uses the module's updater when its path unit exists
(and installs no script or unit), else reports "Set
services.lyrica-host.updates.enable and rebuild, or update with git pull
and install.sh in the host's folder." `changesFolder` stays true: the
module's `modelsDir` rule only creates the folder, so a stale one is
harmless (documented). `flake.nix` evaluates `model-host` with the updater
on and off. Docs: host/README.md, host/API.md, docs/guides/model-hosts.md,
docs/ux.md.

**Merged** as #847 (53e2d4db, 2026-11-08). Lunasa's host rebuilt and
reported its updater available.

**Found on the first real test:** Update… on lunasa's host answered "Lyrica
isn't running a release from her updater". Lunasa's Lyrica is built from
the flake, and `lyrica-nixos-start` recorded the running release with the
module's 7-character commit (`package.build`), while `runningRelease` and
the host's updater take only a whole commit they can check is on `main`.
Fix (follow-up PR): `package.build` is the whole commit, recorded whole;
`LYRICA_BUILD` stays 12 characters. A flake-built Lyrica needs one rebuild
to a flake from that fix on before Update… works on any host.

**Next:** each NixOS host (mystria, lunasa's host) runs `nix flake update
<the lyrica input> && nixos-rebuild switch` (the input's name is the
operator's; mystria's isn't `lyrica`), then `git pull && host/install.sh`
in its checkout once; a flake-built Lyrica rebuilds too; then the first
real Update from Lyrica, on lunasa's host first.

**Open:** none.
