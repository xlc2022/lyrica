# Brief: Watching threads, part 2

**Thread:** the feature comparison thread (Fable directs; Opus and Sonnet
subagents build). **Branch:** `claude/project-thread-mlqt59`. **Depends
on:** nothing beyond main. **Touches the same files as:** Web UI 2 (the
Sleep section, `web/src/`): keep the web change to the look marker, and
merge main before pushing.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Projects" (She
watches her threads, Threads talk to each other) and "Models and
endpoints" (Tasks), docs/delegation.md "Child threads", docs/models.md
"Profiles and lists", `daemon/src/watch.ts`, `daemon/src/hosted.ts`
(`send`, `post`, `run`, the `title` call), `daemon/src/children.ts`
(`message`, `deliver`), `extension/src/delegate/tool.ts` (`deliverVia`),
and `/mnt/project-files/comparison/self-development-tools.md` for the
reasoning.

## Goal

Watching her threads costs little and reaches the threads it means to
(principle 1: Li notices when a thread that should have been told wasn't;
principle 8: no new process, no new tool). Li asked for these four
changes on 2026-10-12 after comparing them with this project's own
coordinator.

## In scope

1. **A Watching model.** A new model task, `watching` ("Watching threads"
   in `TASK_NAMES`), a text task, following `subagent.cheap` in a new
   profile and in existing ones that have no list of their own for it
   (like `title`). It resolves through the router with the project chat's
   `CallContext`, so a private or local-only project uses local models
   only, as every task does. It is in `THREAD_TASKS`, so the project
   chat's drawer can override it. No schema change: task lists are
   already stored per task.
2. **A look is one model call** with a small context, not a project-chat
   turn. In `watch.ts`, when a look fires, `lyricad` builds one prompt:
   her name, the project's goal and instructions, the project's threads as
   the project chat sees them (`threads list` lines), and the digest it
   builds today (what Li wrote, what the thread answered, that a thread
   posted an update, failed or is waiting for an approval). It asks the
   `watching` model, through `callWithFallback` and `completeSimple` as
   the `title` call does, for JSON:
   `{ "tell": [{ "thread": "<id>", "text": "<one or two lines>" }], "raise": "<one line for Li>" }`,
   with `tell` empty and `raise` absent when nothing is needed.
   - Each `tell` goes to that thread as a message from the project chat
     (the `[From t:<project chat>]` mark `children.message` already uses
     for project-chat-to-thread messages), only to threads of this project
     that are not resolved, at most 3 per look, and never back to a
     thread the look was about unless the digest shows it asked something.
   - The look is stored in the project chat as one short entry without a
     turn: which threads it was about and what happened in each, who was
     told and the line sent to each, so the marker shows "Checked the
     other threads · told 2" from the entry itself. The quoted words go
     only into the one call and are never stored, so the project chat
     grows by a line or two per look (Li asked about compaction,
     2026-10-12). The next look reads the last three looks' told lines so
     it doesn't repeat itself; nothing else carries over.
   - `raise` starts one project-chat turn, on the chat's own model, with
     the short look and the line it raised, exactly as a look starts a
     turn today. Without `raise`, no project-chat turn runs.
   - Unparseable output counts as nothing to do and is logged by name
     only (no text, AGENTS.md "No plaintext memory").
   - A look's call is recorded in Recent calls with the project chat's
     thread, task `watching`.
3. **Looks on failures and approvals.** A project thread whose turn ends
   with an error, and one that starts waiting for a permission answer, are
   triggers like an update (`Watcher.failed`, `Watcher.waiting`), batched
   the same way. They don't count toward the run of 3 looks without Li
   and aren't stopped by it, since threads can't cause them by messaging
   each other; each thread triggers at most once per turn. The same
   privacy rules apply as now: unlogged threads are left out, and a
   local-only thread is quoted only into a local-only project chat.
4. **Messages land mid-turn.** In `hosted.ts`, a message sent with
   `fromParent`, `fromThread` or `watching` to a thread that is busy goes
   into its running turn as a steer (after the current tool call), the
   way a child's notice already reaches a busy parent as a follow-up,
   rather than waiting in the queue for the turn to end. What the person
   types during a turn stays a follow-up, as now. If the turn ends with
   an error or is stopped before a steered message was taken, or a
   queued one is dropped, the message is appended to the stored thread
   (the `deliverTo` path) so it is never lost; it shows where it landed.
5. **Docs in the same PR:** DESIGN.md "Projects" (She watches her
   threads), docs/models.md (the task), docs/delegation.md (delivery to a
   busy thread), docs/daemon.md (the look), docs/web.md (the marker),
   docs/contracts.md (`TASKS`, `THREAD_TASKS`).

## Out of scope

A Watching model per project (the task's thread override on the project
chat covers it), reading another thread's messages and stopping a thread
(gap 6 in the comparison), a wake-up timer, routines, PR events.

## Tests

What Li would notice: a look on a cheap model tells the affected thread
and starts no project-chat turn; a look that raises starts one; a private
project's look never reaches a cloud model; a failed thread and a waiting
approval each trigger a look even after a run of 3; a message from
another thread reaches a busy thread inside its running turn; a message
to a thread whose turn errors is kept in the thread. Extend
`daemon/test/projects.test.ts` and `daemon/test/children.test.ts` with
the scripted model they already use.

## After merging

Tell the Models 2 thread and Web UI 2 by cross-session message: the
`watching` task, its name and its default (follows Cheap subagents), so
the Models page lists it. Merge notice to the project chat. Nothing for
Operator docs: nothing is set by hand.

## Handoff notes

(Filled in if the work stops before it's done.)
