# Lyrica

A continuous personal companion built on [Pi](https://github.com/badlogic/pi-mono).

Lyrica runs on one server that the owner administers. The owner and anyone the owner lets in each
have one or more separate users, and each user's memory is encrypted with
that user's own key. Encryption protects data at rest: anyone with root
access while a user is unlocked can read that user's data, an administrator
who sets a user's password can read that user's data, and anything sent to a
cloud model is outside our control.

## Running her

- [docs/guides/getting-started.md](docs/guides/getting-started.md) installs
  her on a new server (NixOS through the flake, or Debian or Ubuntu), takes
  her through the first run,
  and covers updates, rollback and backups.
- [docs/guides/model-hosts.md](docs/guides/model-hosts.md) sets up a GPU
  machine for her models.
- [docs/guides/ci-runners.md](docs/guides/ci-runners.md) sets up a machine
  that runs the checks.
- [docs/guides/searxng.md](docs/guides/searxng.md) sets up the SearXNG her
  web search uses.

She isn't deployed yet. The first run is the web setup page, with
`lyrica admin init` on the server as the other way.

## Contributing

Contributors (people or models) start with [AGENTS.md](AGENTS.md). The design
lives in [PRINCIPLES.md](PRINCIPLES.md) and [DESIGN.md](DESIGN.md), the
interfaces between components in [docs/contracts.md](docs/contracts.md), and
each component's doc in [docs/](docs/). Work in progress is planned in
[docs/briefs/](docs/briefs/).

## What exists

The repository was rebuilt from scratch starting 2026-10-09.

- Users and keys, the persona, topic routing and context assembly.
- Encrypted general and private memory pools, with notes, memory tools,
  automatic recall and a memory browser.
- `lyricad`, which hosts every conversation, and a web UI for threads,
  projects, files, machines, voice, notifications, reactions, message
  search and settings, with a setup page, her name, the tailnet and updates
  in Administration.
- Sleep, which writes notes, pages, WAKE and the journal.
- Delegation and child threads, modes, remote machines over SSH or
  Proxmox, and Git accounts with project repositories.
- Web search through a SearXNG of your own, and reading pages from the
  thread's sandbox.
- MCP servers (remote, per thread).
- Model and speech hosts on GPU machines, and the web's Models area for
  text and image models, their downloads and hub tokens.
- The `image` tool for creation, edits and upscaling, with encrypted results,
  portrait consent and authenticated file/photo APIs; offline diagram rendering
  through the sandbox's Chromium.
- Releases with automatic rollback, and numbered database migrations.

Not built yet: `lyrica chat` and `lyrica mem` (clients of `lyricad`), dedicated
image-part rendering and portrait settings in the web UI. A calendar and
sorting data wait until real use asks. Next
comes living with her for a few weeks while keeping the evals and a friction
log.

## Layout

```text
core/          keyring, users, stores, migrations, model router, workspace
extension/     the Lyrica Pi extension: persona, context, memory tools, sleep
daemon/        lyricad: sessions, HTTP/SSE and local-socket API, scheduler
daemon/deploy/ install.sh, systemd units, updater and rollback
web/           the web UI
host/          model and speech hosts for GPU machines
nix/           NixOS module, package, sandbox tools and check-host.sh
persona/       seed, imported into self.db on first run
evals/         continuity scenarios
bin/lyrica     one command: serve, admin, dev, version, smoke-test
docs/          component docs, guides and briefs
```

Checks: `npm install`, `npm run typecheck`, `npm test`, and `npm run evals`
for the continuity scenarios.
