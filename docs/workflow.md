# How the projects build Lyrica

How work is reviewed and merged. How to write the code itself is in
[AGENTS.md](../AGENTS.md), which every builder follows.

Two projects build Lyrica: Lyrica's own, on each deployment that runs it,
and Claude's. Neither reviews or directs the other. GitHub is the only
channel between them, both ways: either asks the other for work with an
issue (labelled `claude`, or assigned to her account), never with a
message into its threads. Her branches are named `lyrica/*`; Claude's are
`claude/*` and `feature/*`.

Every pull request, from either project:

- says what changed and why, what is out of scope, any contract change it
  needs, which docs it updated (or why none needed it), and the tokens it
  took;
- merges on green CI, which means CI's last job, `done`, passed. On a
  docs-only pull request every job but `changes` and `done` is skipped and
  the run takes about a minute, so the builder checks it and merges then;
- merges with a merge commit when pull requests are stacked, each
  retargeted to `main` first;
- updates the handoff in
  [docs/briefs/lyrica-project.md](briefs/lyrica-project.md) in the same PR
  when it changes how Lyrica works on her own code (roles, review,
  boundaries, updates, the tools she uses for it).

## Lyrica's project

One thread per issue plans, builds, tests and merges its own change on
green CI, following AGENTS.md. Later work in the same area goes to the
same thread.

- Her **Review** thread looks only at a pull request that touches boundary
  code (CODEOWNERS) or changes PRINCIPLES.md, DESIGN.md, docs/contracts.md
  or docs/ux.md, and keeps those four true to what her project settles.
  It says **verified**, naming the commit, and she records that in her
  merge comment.
- A pull request touching boundary code also waits for the owner's own
  approval, and says so in its first line.
- A UI change carries two screenshots, phone and desktop. There is no UI
  review thread.
- A thread reports to the project chat once, when done or truly blocked.
  Only a decision the owner must make reaches the owner, as a card.
- After merging, she says so in her own project; the project chat tells
  threads the merge affects.

Claude's project doesn't review or approve her pull requests; her reviewers
act as her own GitHub account. **Claude Code** is a tool of hers: the
`claude` program in her sandbox, on the owner's Claude plan, run from her
shell or as the `claude` delegate role (docs/workspace.md, "Claude Code").
When the owner asks her to confer with Claude on a change, she runs it there
and weighs its report like a reviewer's findings. See
[the project handoff](briefs/lyrica-project.md#claudes-side).

When she runs on more than one deployment, each has its own GitHub account:
she works only on issues assigned to her own account, checks a new
`lyrica/*` name isn't on GitHub before pushing it, and never pushes to a
branch another account created
([More than one deployment](briefs/lyrica-project.md#more-than-one-deployment)).

## Claude's project

Claude's project runs as threads with fixed roles:

- **Coordinator** (the project chat): writes a brief in `docs/briefs/` for
  each piece of work, starts the thread that builds it and routes messages.
  It brings the owner only what needs the owner.
- **Feature thread:** builds one brief on its own branch and finishes with
  one pull request into `main`. Later work in the same area goes to the
  same thread.
- **PR review:** reviews each pull request that needs it (below) against
  its brief, AGENTS.md and the docs, and keeps PRINCIPLES, DESIGN, the
  contracts and docs/ux.md true to what the project settles, recording
  settled decisions in docs PRs. Its session starts fresh from a handoff
  note once its context passes about 100k tokens, since every turn
  re-reads that context.
- **UI review:** judges every change a user sees against docs/ux.md and the
  mockups.
- **Operator docs:** owns the guides in `docs/guides/`.

Review and merge:

1. The building thread sends the pull request and its head commit to PR
   review, and to UI review too if a user would see the change. PR review
   isn't needed when the pull request changes only docs and briefs (but not
   PRINCIPLES.md, DESIGN.md, docs/contracts.md or docs/ux.md), or makes a
   small change only in `web/` (UI review still judges it). When unsure,
   it goes to PR review. Everything else goes to PR review, including the
   daemon, `core/`, `host/`, `nix/`, `extension/`, `persona/`, migrations
   and CI.
2. A reviewer sends findings back; the building thread fixes them and sends
   the new commit; the reviewer checks it. A reviewer says **verified**,
   naming the commit, only when the PR meets its brief and the docs.
3. Once every reviewer it needs has verified the head commit and CI is
   green, the building thread merges it, with no further approval. If
   merging `main` in later conflicts in files the review touched, it sends
   the merge commit back to the reviewer first.
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

If your context is getting long, stop at a clean point. Write a handoff
note at the end of your brief (done, next, open questions), push, and let a
fresh session continue from it.

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
