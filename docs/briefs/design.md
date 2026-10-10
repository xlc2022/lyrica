# Brief: the design thread

**Thread:** Design. **Branch:** `claude/agent-harness-design-ft4cad`, merged
into `main` by pull request like any other. This brief is the design thread's
own handoff, so a fresh session (or a project conversation) can take over.

## What the design thread does

- Owns PRINCIPLES.md, DESIGN.md, docs/contracts.md and docs/ux.md. Nobody
  else edits them; a feature thread that needs a contract change says so in
  its pull request.
- Writes one brief per feature thread in `docs/briefs/`, starts the thread
  as a cloud session named `Lyrica: <thread>` (tag `project:lyrica`), and
  answers its questions by message.
- Reviews every feature pull request: a full read of the diff against the
  brief, the contracts and docs/ux.md, usually with background agents
  checking the privacy and cloud boundaries, then a fix round with the
  thread. Blocking items are fixed and verified in code before Li is asked.
- Merges only when Li says so, pull request by pull request. A stacked
  branch is merged with a merge commit, not a squash, after its base is
  retargeted to `main` (a squash of the base makes the stack conflict).
- Keeps mockups, not code: the app at
  https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx and the Models area at
  https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V. Always update them in
  place.

## Li's standing decisions

- Private memory never reaches general contexts or cloud models. A local-only
  switch on a thread forbids every cloud model for every purpose.
- No plaintext memory on disk, no fixtures from real data.
- Users are protected from each other, not from the operator. Photos of the
  user go to the cloud only per the user's own setting.
- Use cheaper, well-steered models for simple tasks; mind usage.
- Lyrica deletes only files she downloaded.
- The interface follows docs/ux.md. Labels are nouns, no captions, numbers
  typed with their maximum shown, one idiom for everything.

## Where things stand (10 October 2026, evening)

Merged on `main`: Core, Memory, Workspace, Models, Delegation, Daemon, Web
UI, Sleep, Delegation 2, Models 2 (#30, #34, #36, #37, #40, #41, #46), Model
host (#28, #31, #32, #33, #38, #39, #42, #45) and Child threads 1/3 (#44).

| Thread | Branch | State |
|---|---|---|
| Models 2 | done | context and pace merged in #46 |
| Model host | done | AMD and integrated GPUs merged in #45; hardware checks listed in its handoff notes |
| Child threads | `feature/child-threads-2`, `feature/child-threads-3` | #47 (2/3) has a fix round open: a kept child still marked as a child, the working-at-once limit bypassed by messages, a spoofable parent marker; 3/3 being redone |
| Modes | `feature/modes` | building docs/briefs/modes.md; no pull request yet |
| Images | not started | docs/briefs/images.md |
| Web UI 2 | not started | docs/briefs/web-2.md; reads docs/ux.md first |

## Open questions for Li

From reading the merged Models 2 code against its pull requests:

- A host that revoked Lyrica (`unpaired`) looks like any other down host.
  Should the Models page say that pairing again is what's needed?
- Gone shared models are pruned only once every user has unlocked since the
  migration. A user who never unlocks blocks it for everyone. Prune after a
  deadline, or only on an administrator's Clean up?
- The longest reply is capped at the smaller of 8192 tokens and a quarter of
  the context window, whatever the saved setting says. Keep the cap, or let
  the setting win?

## Handoff notes

The design work moves to the Lyrica project chat on claude.ai, which picks
up reviews and merges from here.

- Next: verify #47's fix round, then record its contracts (the PR body
  lists them: `threads.child`, `forgetThread` detaching kept daughters,
  `listThreads` children, `ChildStatus`/`ChildInfo`/`StartRequest`,
  DELETE `?children=1`, notice status `update`, `Services.children`,
  `HostedThread.waiting`) and give the child-thread card a home in
  docs/ux.md section 6.
- To settle in DESIGN: whether a child follows its parent's later switch
  to local-only or "Do not log" (today it keeps the values it was started
  with), and depth through a user's branch of a child.
- Small leftovers for the threads' next PRs: a failed resend after a
  rewind still drops the first queued message (#44); a tool turn's
  fallback context reads a little high (#46, noted in docs/daemon.md).
