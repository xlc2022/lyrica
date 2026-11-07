# Brief: Update a host from its ⋯ menu

**Status:** Merged as #797 (7c911444); the follow-up below is in review.
**Branch:** `claude/project-thread-uy30v4`.
**Builds on:** [host-updates.md](host-updates.md) (#311), which made the
updater and a hidden **Update**.

## Goal

The operator couldn't find how to update a model host from Lyrica: **Update**
appeared in the host's ⋯ only when everything lined up, so a host that
couldn't update gave no hint why (principle 6, make review easy: a person
sees what will happen and why not). Setting up the updater also needed a
deploy key on GitHub, which a public repository doesn't need.

## Design

1. **Update… is always in the ⋯** of a paired host, first. When it can't
   run it's greyed out (`aria-disabled`, so it stays focusable and its
   tooltip shows) and the tooltip says why: the host isn't answering, an
   update is running, the host's own reason it has no updater (NixOS, no
   systemd, missing jq or git), Lyrica runs no release yet, or the host
   already runs it. `RowMenu` items take `disabled`.
2. **A dialog confirms it** (dialogs confirm, docs/ux.md): "Update <host>?",
   the release it goes to, that it pauses once running jobs finish (up to
   10 minutes), installs and restarts, and goes back to the version it runs
   if it doesn't come back within 5 minutes. Cancel and **Update**.
3. **Progress on the card:** the state word is the updater's step
   (Updating while the request waits, then Fetching, Draining, Building,
   Rolling back), tooltip "Updating to <tag>". A failed update keeps its
   warn line.
4. **No deploy key for a public repository.** `install.sh` checks the
   repository with `git ls-remote` over HTTPS without credentials; if it
   answers, the updater fetches over HTTPS and no key is made. Otherwise it
   uses SSH with the read-only deploy key as before. `LYRICA_REPO` still
   overrides the URL. A rerun sets the updater repository's remote, so an
   existing host switches, and shows the key again when it moves to SSH.
   The updater fetches with prompts off. The tag checks run on what was
   fetched, so the trust is that the fetch reached GitHub: its certificate
   over HTTPS, its pinned host key over SSH. Having Lyrica send her commit
   with the request, so the transport stops mattering, is a possible
   follow-up.

Permissions are unchanged: host-api can only write a tag into the inbox;
the root path unit runs the fixed updater; Lyrica's server lets an
administrator update a shared host and the owner a private one.

## Follow-up: hosts follow the latest merge

Lyrica can run her latest merge, a commit on `main` with no tag
([latest-merge.md](latest-merge.md)); a host follows what she runs.

1. **The request names the commit.** `runningRelease` returns `{ tag?,
   commit }`: the `update/*` tag with its commit, or the commit alone.
   `POST /host/v1/update` takes `{ tag?, commit? }`. With both, the updater
   refuses a tag that no longer points at that commit (`not the tag's
   commit`), which pins what was fetched to what Lyrica runs. A commit
   alone must be on `main` after the fetch; it is labelled `main` (state
   and `last.tag`), as Lyrica's updater labels it, and installed as
   version `main-<12 hex>`. CLI: `--commit <sha>`, alone or after `--tag`.
2. **Older updaters.** An update never replaces the updater, so
   `install.sh` writes `commits: true` with the updater, and host-api
   reports it. Lyrica sends the commit only to a host with `commits`; an
   older one gets the tag alone and can't take a latest merge (Update… is
   greyed out: "This host's updater can't install a latest merge yet: run
   install.sh on the host again.").
3. **Web:** the latest merge's dialog is "Update <host> to the latest
   merge?" with the commit in mono after the title and "Not tagged as a
   release yet, so less tested." first, then the pause and rollback
   sentences. Tooltips and the failure line say "the latest merge" in
   place of a tag. No release from her updater: "Lyrica isn't running a
   release from her updater. Update her first, in Administration →
   Updates."

## Out of scope

Lyrica's own updater's deploy key (its own thread); NixOS hosts; updating
hosts to anything but what Lyrica runs.

## Docs

docs/ux.md, DESIGN.md (host bullet), host/README.md,
docs/guides/model-hosts.md. No contract change: the API and HostStatus are
as before.

## Handoff

Done: #797 (menu, dialog, step words, HTTPS fetch, e2e). Follow-up: the
commit request, built with host, core and e2e tests; next is PR review and
UI review, then tell Operator docs after merge.
