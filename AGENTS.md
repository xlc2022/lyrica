# Working on Lyrica

This guide is for every contributor: people, Claude, ChatGPT, DeepSeek, and
eventually Lyrica herself.

## Before you start

Read these, in this order:

1. [PRINCIPLES.md](PRINCIPLES.md): the thesis and the ten principles. When two
   conflict, the earlier one wins.
2. [DESIGN.md](DESIGN.md): the current agreed design. Don't reopen a settled
   point without new evidence.
3. [docs/contracts.md](docs/contracts.md): the interfaces between components.
4. Your brief in `docs/briefs/`, if you have one, and the doc for the component
   you are changing.
5. [docs/ux.md](docs/ux.md) before changing anything a user sees. Every new
   control needs a home from its table; a PR that touches the interface
   says which rule each new control follows.

## Rules

- **Name the principle.** Every change says which principle or decision it
  serves. "Closes a theoretical gap" doesn't count.
- **Respect the budgets in principle 8.** Going over one takes an agreed
  change to DESIGN.md, or removing something else.
- **Keep the boundaries structural.** Private memory is reached only through
  `openThreadView`. Model calls go only through `core/models`. Never rely on
  telling the model not to do something.
- **No plaintext memory.** Memory and thread text never reach disk unencrypted:
  no logs of message text, no temp files, no fixtures copied from real data.
- **Docs never drift.** Every person, agent and model on this project starts
  from the docs, so they are the source of truth. A change updates every doc
  it makes stale (its component doc, the contracts, DESIGN, docs/ux.md, the
  guides, a brief that describes it) in the same PR. Docs describe what
  exists: write plainly, keep them short, and put plans in briefs, never in
  component docs. If a doc and the code disagree, the PR isn't done, and a
  missing doc update blocks review. Whoever notices drift anywhere fixes it
  in a small docs PR or tells the thread that owns the doc.
- **Tests protect what the user would notice:** context assembly, memory round trips,
  the privacy and cloud boundaries, and sleep output. Don't add a test for
  every hypothetical.
- **Migrations expand, then contract.** A schema change that removes or
  renames something waits one release, so the previous release can still
  open the database and a rollback keeps its data; the contract raises the
  database's oldest-reader version. Each database migrates
  in one transaction, and a migration comes with a test from every
  released schema (DESIGN.md, Updates and self-editing).
- **No personal names.** Docs, comments, prompts and test fixtures never
  name the owner or another real person: say "the user" or "the operator",
  and use a made-up name (Ada, Sam) in examples.
- **Deleting code is progress.**

## Workflow

The project runs as threads, each a session of whatever tool or model suits
the work, with fixed roles:

- **Coordinator** (the project chat): writes a brief in `docs/briefs/` for
  each piece of work, starts the thread that builds it and routes messages.
  It brings the owner only what needs the owner.
- **Feature thread:** builds one brief on its own `feature/*` branch and
  finishes with one pull request into `main`. Later work in the same area
  goes to the same thread.
- **PR review:** reviews each pull request that needs it (below) against
  its brief, this file and the docs, and owns PRINCIPLES, DESIGN, the
  contracts and docs/ux.md, recording settled decisions in docs PRs. Its
  session starts fresh from a handoff note once its context passes about
  100k tokens, since every turn re-reads that context.
- **UI review:** judges every change a user sees against docs/ux.md and the
  mockups.
- **Operator docs:** owns the guides in `docs/guides/`.

Review and merge:

**Lyrica's own PRs take the stricter path.** Every PR she builds, including
docs-only and small `web/` changes, goes to her project's Review thread
with the PR and head commit, and to UI review too if a user would see the
change. She fixes findings and sends the new head for recheck. Only after
every required reviewer says **verified** with the exact head commit and
CI is green does she send it to Claude's PR review for approval and merge,
using an issue labelled `claude`; she answers review comments on the PR.
The Lyrica building thread never merges its own PR. After Claude merges,
she reports it as in step 4 below. See
[the project handoff](docs/briefs/lyrica-project.md#claudes-side).

For other contributors, the existing path remains:

1. The building thread sends the pull request and its head commit to PR
   review, and to UI review too if a user would see the change. PR review
   isn't needed when the pull request changes only docs and briefs (but not
   PRINCIPLES.md, DESIGN.md, docs/contracts.md or docs/ux.md), or makes a
   small change only in `web/` (UI review still judges it). When unsure,
   it goes to PR review. Otherwise the building thread checks its
   own docs against this file's "Docs never drift" rule and merges on green
   CI and UI review's verified, if it needs one. Everything else goes to PR
   review, including the daemon, `core/`, `host/`, `nix/`, `extension/`,
   `persona/`, migrations and CI.
2. A reviewer sends findings back; the building thread fixes them and sends
   the new commit; the reviewer checks it. A reviewer says **verified**,
   naming the commit, only when the PR meets its brief and the docs.
3. Once every reviewer it needs has verified the head commit and CI is
   green, the building thread merges it, with no further approval. If
   merging `main` in later conflicts in files the review touched, it sends
   the merge commit back to the reviewer first. Stacked pull requests merge
   with merge commits, each retargeted to `main` first.
4. After merging, the building thread says so in its own thread and tells
   the coordinator the number, title and merge commit, what landed and what
   it may affect; the coordinator tells the affected threads. If it changes
   anything an operator does by hand (installing, running or configuring
   the daemon, a model host, CI runners, a setting an operator sets), it
   also tells Operator docs what changed and where.

Handoffs: nobody waits silently. A thread that needs another thread messages
it every time, naming the commit and what it needs, and the receiver
answers in the same turn, even if only to say when. A message sent isn't a
message read, so check for replies after each long step. No reply in 10
minutes: ask the coordinator to pass it on. Waiting more than 15 minutes:
say so in your own thread.

A second review from another model family (such as Codex, run on the test
machine) happens only when the owner or PR review asks for one.

**Claude Code threads only: the local model.** This paragraph is specific to
Claude Code sessions in the owner's Claude project. Other harnesses and models
(Codex, DeepSeek, Lyrica) ignore it. A local model runs in LM Studio on the
operator's main machine. On the test machine, Claude Code reaches it through
the `houtini-lm` MCP server (Claude stays in charge and gets text back) or the
`claude-local` command (a whole Claude Code session on the local model, run
with `-p` from the thread's own worktree, its diff reviewed before commit).
Before giving it any work, the thread that wants the work done asks the owner
in its own thread. If the owner doesn't answer within 5 minutes, or the model
isn't reachable, the work goes to Codex, then to Claude. A `codex exec` run
in the background waits forever for input unless its input is closed: start
it with `</dev/null`, and a minute later check that it is writing its session
log under `~/.codex/sessions`.

- A pull request description says what changed and why, what is out of scope,
  any contract change it needs, and which docs it updated (or why none needed
  it).
- When a change alters how Lyrica works on her own code (roles, review,
  boundaries, updates, the tools she uses for it), update the handoff in
  [docs/briefs/lyrica-project.md](docs/briefs/lyrica-project.md) in the same
  PR.
- If your context is getting long, stop at a clean point. Write a handoff note
  at the end of your brief (done, next, open questions), push, and let a fresh
  session continue from it.

## Checks

```sh
npm install
npm run typecheck
npm test
npm run evals      # continuity scenarios in evals/; a failure is evidence, not a broken build
```

Run one test suite at a time. One run peaks at about 5.4 GB of memory, but
two side by side took about 12 GB each and froze a 30 GB machine.

A test host needs `openssl` and `bash` on its PATH; tests run in UTC
whatever the host's zone. CI runs on GitHub's hosted runners ([docs/ci.md](docs/ci.md)); the owner's own
runners are idle for now.
