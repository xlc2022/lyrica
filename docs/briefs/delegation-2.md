# Brief: Delegation 2 (talking with subagents, and their approvals)

**Thread:** Delegation 2. **Branch:** `feature/delegation-2`.

**Depends on:** Delegation, Daemon and Web UI (merged).

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Models and endpoints" (the Delegation and Subagents bullets);
- docs/delegation.md, docs/daemon.md and docs/web.md;
- docs/contracts.md: `delegate`, `daemon` (permission prompts), `extension`.

## Goal

Lyrica and her subagents can talk back and forth, the way Claude works with
its agents, and Li can talk to a subagent too. Subagents that change things
work in threads that ask before acting, because their approvals reach Li.
This serves principle 1 (work keeps going instead of being refused) and keeps
the permission boundary structural.

## In scope

1. **One `message` action** on `delegate`, replacing `steer` and `answer`
   (remove both; update the role and tool prompts):
   - a working subagent: the message joins its current turn, as `steer` did;
   - a subagent waiting on `ask_parent`: the message is the answer;
   - a finished, failed, stopped or interrupted subagent: it continues in its
     own thread, with its full history, under the same run. It gets a new
     stretch of work: the usual timeout, a concurrency slot while it works,
     and it counts once more against `runsPerRequest`. Its workspace,
     model rules and permission mode are worked out again from the parent's
     current settings (so a parent that turned local-only gives a local
     model, and one that was forgotten refuses).
   - It works after a restart, from the stored thread. `status` shows which
     runs can be continued.
   - Several subagents in one run (`tasks`, `chain`, `loop`, `council`):
     `message` takes an optional `thread` to pick one; without it, a run
     with one subagent waiting or one subagent at all is unambiguous, and
     anything else is an error that lists the threads.
2. **Notes from a subagent.** `ask_parent({ question, wait })`: `wait`
   defaults to `true` (today's behaviour). With `wait: false` the subagent
   keeps working and the note is delivered to the parent like a background
   result: into the live session, or into the stored thread. Limit notes to
   a few per stretch of work so a subagent can't flood its parent.
3. **The user talks to a subagent.**
   - The composer works in a subagent's thread. Its settings panel stays
     read-only.
   - The message reaches the subagent through the same path as `message`,
     marked as the user's (by name in its context, as in any thread).
   - The parent thread gets a short note: who said what to which subagent.
     In the web UI it's a card linking to the subagent's thread.
   - Only users who can open the parent can do this (the same pool and
     owner checks as any thread).
4. **Approvals from subagents.**
   - A subagent's tool calls go through the workspace extension's
     `tool_call` hook with the **parent's** permission mode, and
     `ThreadTools.approve` asks as it does for the parent.
   - The prompt shows in the subagent's thread and in the parent's (a card:
     which subagent, which tool, what exactly), and any open view of either
     can answer. The first answer wins; the other view updates.
   - A deny, a timeout or Stop refuses that one call, and the subagent is
     told plainly, as the parent would be.
   - Remove the rule that refuses writer roles in threads that ask first,
     and its docs.
   - Parallel writers each ask for their own calls; answers name the
     subagent so they can't be confused.
5. **Web UI.**
   - The `delegate` card and notice cards gain **Message** (send a message to
     the run) where useful, and show notes and approvals.
   - The subagent thread shows who sent each message: Lyrica, Li, or the
     subagent's own work.
6. **Docs.** docs/delegation.md, docs/daemon.md and docs/web.md describe
   what exists; the PR lists the contract changes.

## Out of scope

- External coding CLIs as subagents.
- Durable runs that keep running across a restart (continuing a stopped run
  after a restart is in scope; resuming mid-turn is not).

## Done when

- `npm run typecheck` and `npm test` pass in CI, including the sandbox
  suites.
- Tests, with the scripted fake model server, show that:
  - `message` steers a working subagent, answers one that asked, and
    continues a finished one with its earlier context in the request;
  - a run interrupted by a restart can be continued from its thread;
  - a continued subagent of a parent that has since turned local-only gets
    a local model, and one whose parent was forgotten is refused;
  - `ask_parent` with `wait: false` delivers a note and the subagent keeps
    going; the note limit holds;
  - a user's message in a subagent's thread reaches the subagent as theirs
    and leaves a note in the parent;
  - a user without access to the parent can't post in its subagent's thread;
  - in an ask-first thread, a writer subagent's command waits for approval
    shown in both threads, runs once approved, is refused on deny or
    timeout, and the first of two answers wins;
  - `steer` and `answer` are gone;
  - no message text reaches any log (marker string).

## Handoff notes

(The thread fills this in if it stops before it's done.)
