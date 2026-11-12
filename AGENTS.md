# Working on Lyrica

Lyrica is a personal AI companion: a daemon (`lyricad`) that runs on one
server, a web interface, and model hosts on GPU machines. This guide is for
every agent and person who changes the code. It covers how to work here;
how the projects that build Lyrica review and merge is in
[docs/workflow.md](docs/workflow.md).

## Where things are

| Folder | What it holds | Its doc |
| --- | --- | --- |
| `core/` | Keys, users, encrypted stores, migrations, the sandbox | `core/README.md`, [docs/memory.md](docs/memory.md), [docs/workspace.md](docs/workspace.md) |
| `extension/` | Her Pi extension: context, tools, threads, delegation | `extension/README.md`, [docs/delegation.md](docs/delegation.md) |
| `daemon/` | `lyricad`: the HTTP API, routes, web access, install scripts | [docs/daemon.md](docs/daemon.md) |
| `web/` | The web interface and its Playwright tests (`web/e2e/`) | [docs/web.md](docs/web.md), [docs/ux.md](docs/ux.md) |
| `host/` | The model host stack | `host/README.md`, [docs/models.md](docs/models.md) |
| `nix/` | The NixOS module | the guides in `docs/guides/` |
| `persona/` | Her persona files | [docs/sleep.md](docs/sleep.md) for what sleep writes |
| `evals/` | Continuity scenarios | |
| `docs/briefs/` | One brief per piece of planned work | |

Reference, read only the sections your task touches:
[PRINCIPLES.md](PRINCIPLES.md) (the ten principles; when two conflict, the
earlier wins), [DESIGN.md](DESIGN.md) (the agreed design),
[docs/contracts.md](docs/contracts.md) (interfaces between components) and
[docs/ux.md](docs/ux.md) (every control's home; read before changing
anything a user sees). Search them for the feature's name rather than
reading them whole.

## How to work

1. **Fix the problem that was asked.** Propose a reasonable scope: the
   whole problem the person named, plus bugs you find on the way that are
   directly related to it (the same screen, the same code path, the same
   cause). Don't shrink the ask to what is easy, and don't mark the hard
   part "out of scope" and ship the rest. If you can't fix what was asked,
   say so before building, and say why. Leave unrelated work out, and file
   it as an issue instead.
2. **Understand before you edit.** Reproduce the bug with one focused test
   or measurement. Write the cause in one sentence, pointing at the line or
   the number that proves it. Only then change code.
3. **Run only what tests your change** while you work: one test file, or one
   test by name (Checks, below). Run the touched area's tests once before
   you push. CI runs the full suite on every pull request; don't repeat it
   locally.
4. **Two misses means stop guessing.** If two changes in a row don't fix
   it, go back to step 2 rather than trying a third tweak.
5. **Never throw away unsaved work.** Before starting over, commit what you
   have to your branch and push it, with a line on what didn't work.
   Starting over is a new commit on the same branch, never a fresh copy of
   `main`.
6. **Write little.** An issue says the problem, what done looks like and
   what is out of bounds; it doesn't diagnose. A pull request has one
   description and, at merge, one comment. No status comments, no working
   history, no brief for a small change. For a UI change, two screenshots:
   phone and desktop.
7. **Say what it cost.** The pull request description ends with the tokens
   the change took, from the thread's Tokens popover.

## Rules

- **Name the principle.** Every change says which principle or decision it
  serves. "Closes a theoretical gap" doesn't count.
- **Respect the budgets in principle 8.** Going over one takes an agreed
  change to DESIGN.md, or removing something else.
- **Keep the boundaries structural.** Private memory is reached only through
  `openThreadView`. Model calls go only through `core/models`. Never rely on
  telling the model not to do something.
- **No plaintext memory.** Memory and thread text never reach disk
  unencrypted: no logs of message text, no temp files, no fixtures copied
  from real data.
- **Docs never drift.** Agents learn this repo from its docs. A change
  updates every doc it makes stale (its component doc, the contracts,
  DESIGN, docs/ux.md, the guides, a brief that describes it) in the same
  PR. Docs describe what exists, plainly and briefly; plans go in briefs.
  If a doc and the code disagree, the PR isn't done.
- **Tests protect what the user would notice:** context assembly, memory
  round trips, the privacy and cloud boundaries, and sleep output. Don't add
  a test for every hypothetical.
- **Migrations expand, then contract.** A schema change that removes or
  renames something waits one release, so the previous release can still
  open the database; the contract raises the database's oldest-reader
  version. Each database migrates in one transaction, with a test from
  every released schema (DESIGN.md, Updates and self-editing).
- **No personal names.** Docs, comments, prompts and test fixtures never
  name the owner or another real person: say "the user" or "the operator",
  and use a made-up name (Ada, Sam) in examples.
- **Deleting code is progress.**

## Checks

```sh
npm install
npm run typecheck
npx vitest run <file>        # one unit test file; add -t "<name>" for one test
npm test                      # the whole unit suite; CI runs it too
npm run evals                 # continuity scenarios; a failure is evidence, not a broken build
npm run build && npm run e2e -w @lyrica/web   # the web UI's Playwright tests
```

One e2e test: `npm run build`, then `E2E_PROJECTS=desktop-chat npx playwright
test -c web/playwright.config.ts -g "<test title>"`. Each
`web-<spec>.spec.ts` runs in the projects `phone-<spec>` and
`desktop-<spec>` (chat, workspace, projects, admin), and `setup.spec.ts` in
`setup`. `E2E_PROJECTS` (comma-separated) starts only the named projects'
lyricads; `--project` alone starts all nine. `npm test` is vitest: it runs
only `*/test/**/*.test.ts`, so given a Playwright spec it finds nothing.

Run one test suite at a time. One run peaks at about 5.4 GB of memory; two
side by side froze a 30 GB machine. A test host needs `openssl` and `bash`
on its PATH; tests run in UTC whatever the host's zone. CI runs on GitHub's
hosted runners ([docs/ci.md](docs/ci.md)).
