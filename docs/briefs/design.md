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
host (#28, #31, #32, #33, #38, #39, #42, #45), Child threads 1/3 (#44),
2/3 (#47) and pinned messages (#48).

| Thread | Branch | State |
|---|---|---|
| Models 2 | done | context and pace merged in #46 |
| Model host | done | AMD and integrated GPUs merged in #45; hardware checks listed in its handoff notes |
| Child threads | done | #47, #48, #51 and #53 merged |
| Modes | done | #50 merged; the chat's pending bar in #55 |
| Images | not started | docs/briefs/images.md |
| Web UI 2 | not started | docs/briefs/web-2.md; reads docs/ux.md first |
| Machines, SSH helper, Proxmox, Web: machines | not started, wait for Li's go | docs/briefs/machines.md, ssh-helper.md, proxmox.md, web-machines.md; decided in /mnt/project-files/remote/proposal.md |

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

Since 10 October 2026 (evening), feature-PR reviews run in the project's
standing **PR review** thread, and the look and feel in a separate **UI
review** thread; a PR merges once both have verified their rounds and CI
is green. The PR review thread then records contracts, DESIGN and
docs/ux.md changes in a docs-only PR.

- Settled in review: subagents and child threads follow their parent's
  later narrowing of mode and switches at once (Modes, #50). Recorded in
  DESIGN and the contracts.

Earlier notes from the design thread:

- To settle in DESIGN: whether a child follows its parent's later switch
  to local-only or "Do not log" (today it keeps the values it was started
  with), and depth through a user's branch of a child.
- Small leftover for a thread's next PR: a tool turn's fallback context
  reads a little high (#46, noted in docs/daemon.md). (#44's dropped
  queued message was fixed in #47.)
