# Update to the latest merge

Serves principle 1 (real use hit a real wall: an update waited for someone
to push an annotated `update/*` tag, which only one account could do),
within DESIGN.md "Updates and self-editing".

## What was built

- **Updater** (`lyrica-update`): `--commit <sha>`, or a request
  `{ action: "update", commit }`, installs a whole commit with no tag once
  it is on `main` after the fetch. It is labelled `main` (no update tag
  has that name) in `state.json` and RELEASE.json. Every fetch records
  main's head as `latest` (commit, commit time, title: a merge commit's
  `#<number> <pull request title>`, else its subject). That title becomes
  the release's note, so it shows in the kept releases. Build, smoke test,
  drain, snapshot, switch, probation and rollback are unchanged.
- **lyricad:** `Updates.latest`; `POST …/admin/updates` takes `{ commit }`
  (40 hex) in place of `{ tag }`. A model host still updates only to a
  tagged release: `runningRelease` returns only `update/*` tags.
- **Web:** a **Latest merge** checkbox beside Update. When it is ticked,
  the facts show main's head, and Update asks in a dialog: "Not tagged as
  a release yet, so less tested."

## Out of scope

Model hosts following the latest merge. The host-update thread will build
it after #797, using the same rule (a whole commit that is an ancestor of
`main`, labelled `main`) and the same wording.

## Handoff

Done: the above, with tests in `daemon/test/updater.test.ts`,
`daemon/test/updates.test.ts` and `web/e2e/web-admin.spec.ts`. This work
is stacked on #796 and #798. Next: the host follow-up.
