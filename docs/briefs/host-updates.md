# Brief: Host updates

**Thread:** Model hosts and downloads. **Branch:** `feature/host-updates`.
**Depends on:** #307 (Models: pausing, companions, downloads).

**Read first:** AGENTS.md, DESIGN.md "Updates and self-editing", host/README.md,
host/API.md, docs/models.md, docs/ux.md (Hosts and endpoints, Updates), and
daemon/deploy/updater/lyrica-update, whose checks this mirrors.

## Goal

An administrator updates a model host from Lyrica's Models page the way they
update Lyrica herself: one press, the same reviewed release, and a host that
goes back by itself when the new one doesn't come up (principle 6: make
review easy; principle 7: keep the boundaries structural). Today a host is
updated only by `git pull && host/install.sh` on the machine.

## Design

1. **Version.** A host runs a commit, as `/host/v1/status` already reports
   (`version`, from `git describe`). The host installer records the full
   commit too, so Lyrica can compare it with her own running commit.
2. **Same releases as Lyrica.** A host updates only to an annotated
   `update/<date>` tag whose commit is on `main`, the checks lyrica-update
   makes. Lyrica asks a host to go to the release she runs; nothing else is
   offered.
3. **The updater runs outside host-api.** host-api has no route out
   (egress.sh) and no Docker socket, and keeps both. install.sh installs a
   root systemd path unit, `lyrica-host-update.path`, watching a request file
   in a directory host-api can write (a bind mount, `HOST_DIR/.update/`), and
   `lyrica-host-update.service` running `host/update.sh --request`.
4. **Steps:** read the request (a tag only, checked by regex); fetch `main`
   and `update/*` with the clone's own remote; check the tag; ask host-api to
   pause (its existing Pause: running jobs finish, up to 10 minutes); note the
   running commit; `git checkout --detach` the tag's commit; run
   `install.sh --yes`; then probation: `/host/v1/status` answers with the new
   commit within 5 minutes. Otherwise check out the old commit, run
   `install.sh --yes` again, and record the failure. The update leaves the
   host paused as it found it, or running.
5. **State** lives in `HOST_DIR/.update/state.json` (`idle`, `fetching`,
   `draining`, `building`, `probation`, `failed`, with the tag and the failed
   step) and `/host/v1/status` reports it as `update`. Pairing and models
   survive, as with a manual reinstall.
6. **Lyrica.** `POST /host/v1/update {tag}` (paired, administrators only,
   through `core/models`); `Models.hostUpdate(actor, id)` sends her running
   release's tag. The Models page shows a host's version in its drawer and,
   when it differs from hers, "Update available" with **Update** in the
   host's ⋯ menu and a status line while it runs. No automatic updates:
   an administrator presses Update, as for Lyrica.
7. **NixOS and hand-run hosts.** A host whose install has no updater (NixOS,
   no systemd, or a dirty checkout) reports `update: {available: false,
   reason}`; Lyrica shows the version and the reason in a tooltip, and no
   button.

## Out of scope

Updating hosts automatically after Lyrica updates, rolling a host back to an
older release from Lyrica, NixOS hosts (their config pins the checkout), the
speech host.

## Docs in the same PR

host/README.md, host/API.md, docs/models.md, docs/contracts.md, docs/ux.md,
DESIGN.md (Updates and self-editing), and a note to Operator docs for
docs/guides/model-hosts.md.
