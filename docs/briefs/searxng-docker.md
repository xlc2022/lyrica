# Brief: SearXNG in Docker from install.sh

**Status:** In review. **Branch:** `claude/project-thread-ol9r4b`.
**Read first:** AGENTS.md, PRINCIPLES.md (1, 2, 8), DESIGN.md (Switches in
the message box), docs/contracts.md (Web search), docs/daemon.md
(Deployment) and docs/guides/searxng.md.

## Goal

Her `web_search` needs a SearXNG, and today the operator has to host one
and type its address into Administration → Web search. On Debian or
Ubuntu, `install.sh` asks whether to run one for her, and with a yes it
runs it in Docker on the same machine and the address fills itself in.

- Principle 1: web search works from the first run, without a separate
  hosting job before she can look anything up.
- Principle 2: one operator, one server: the instance lives on her own
  machine, published on 127.0.0.1 only, and nothing new leaves it beyond
  what SearXNG already sends its engines.
- Principle 8: one shell section, one unit, one settings template and one
  small function in `core/src/web.ts`. No new dependency in lyricad.

## In scope

- **The question.** `install.sh` asks at its start, before the long build,
  so the rest runs unattended: "Run SearXNG in Docker on this machine for
  her web search? [Y/n]". `LYRICA_SEARXNG=yes|no` answers ahead; no
  terminal means no. An install that already has
  `/etc/lyrica/searxng/settings.yml` is a yes without asking.
- **No Docker, no setup.** Without `docker` on the PATH it says so and goes
  on. It never installs Docker.
- **The instance.** The official `searxng/searxng` image pinned by tag and
  digest, run by `lyrica-searxng.service` (`docker run --rm`, enabled at
  boot, restarted on failure), published on `127.0.0.1:8888`. Its
  `settings.yml` is written once from `daemon/deploy/searxng-settings.yml`
  with a random secret: JSON on, limiter off. `GRANIAN_HOST=0.0.0.0`
  inside the container, as the image's default `::` fails where IPv6 is
  off.
- **The address.** `install.sh` writes `http://127.0.0.1:8888` to
  `/var/lib/lyrica/searxng-address`. On each unlock lyricad calls
  `adoptLocalSearxng`: while no address is set, it stores that one, and
  `web.searxng.offered` remembers it, so an administrator who clears or
  changes it is never overridden. A new address is a new offer.
- **Docs:** guides/searxng.md, getting-started.md, daemon.md, contracts.md,
  workspace.md, DESIGN.md, README.

- **NixOS (follow-up PR).** The operator chose on by default:
  `services.lyrica.searxng` (default true) turns on NixOS's
  `services.searx` in uWSGI with `disable-logging` (its built-in server
  logs every query), on 127.0.0.1:8888 with the same settings. A
  `lyrica-searxng-secret` oneshot makes the secret once in
  `/var/lib/lyrica-searxng/env`. A tmpfiles rule writes the same
  `searxng-address` (and removes it when the option is off), and
  `nix/check-host.sh` checks `/healthz`.

## Out of scope
- Starting and stopping with lyricad. The unit runs on its own from boot,
  so lyricad.service is unchanged and installs without SearXNG see no
  stale-units report.
- Any UI change: Administration → Web search shows the filled-in address
  with its existing field and status.

## Handoff

NixOS part: the module evaluates, and the generated uWSGI vassal, run by
hand in the sandbox, answered `format=json` on 127.0.0.1:8888 and logged
no query. It hasn't run as a NixOS system (no KVM for a VM test).

Built and tested in the cloud sandbox: the pinned image runs with the
template settings and answers `format=json` (engines unreachable there,
which is the sandbox's network). Not yet run end to end by `install.sh`
on a real Debian host with systemd.
