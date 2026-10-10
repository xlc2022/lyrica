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

## Where things stand (10 October 2026)

Merged on `main`: Core, Memory, Workspace, Models, Delegation, Daemon, Web
UI, Sleep, Delegation 2, Models 2 (#30, #34, #36, #37, #40) and Model host
(#28, #31, #32, #33, #38, #39).

| Thread | Branch | State |
|---|---|---|
| Models 2 | `feature/context` | building docs/briefs/context.md; ships `compact` as its own tool until `threads` lands |
| Model host | done | handoff notes in #42; its AMD/iGPU question answered to Li directly |
| Child threads | `feature/child-threads` | building docs/briefs/child-threads.md; owns the `threads` tool |
| Modes | `feature/modes` | building docs/briefs/modes.md; was stopped by a session limit, resumes on its own |
| Images | not started | docs/briefs/images.md |
| Web UI 2 | not started | docs/briefs/web-2.md; reads docs/ux.md first |

Open pull requests: #41 (Models 2 docs follow-up) and #42 (Model host
handoff notes), both reviewed and waiting for Li's OK; the design pull
request carrying this brief and the contracts for Models 2.

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

(The thread fills this in if it stops before it's done.)
