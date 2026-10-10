# Brief: Projects (back end)

**Thread:** Projects. **Branch:** `feature/projects`. **Model:** Opus.

**Depends on:** child threads (merged, #44 to #51) and Modes (merged).
Nothing else; Projects (web) and Projects (sleep) build on this one's API.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Projects", and in "Models and endpoints" the Subagents, Child
  threads and "chooses between them" bullets; "Memory";
- docs/delegation.md (Child threads), docs/memory.md, docs/daemon.md,
  docs/workspace.md;
- docs/contracts.md: the **Planned (Projects)** entries under `core/store`,
  `delegate`, `extension`, `daemon` and `core/workspace`.

## Goal

Li can give Lyrica a stream of related work in one place, a project, and
find each piece done or waiting on her later. Lyrica coordinates it in the
project chat and does the work in threads, which share the project's goal,
instructions, memory and folder. This serves principle 1 (long work with
several strands stops swallowing conversations) and keeps every boundary
structural (principle 2): a project's threads are child threads, so pool,
local-only, "Do not log" and workspace settings are inherited as today.

## In scope

1. **The project flag.** `createThread({ project: true })` and
   `setProject(id)` on a top-level thread (a child or subagent is refused;
   there is no way back). `Thread.project`, `Thread.goal`. Project settings
   with no text (threads model and thinking, paused) in `user.db` with the
   thread's other settings.
2. **Anchors and states.** `child_threads.anchor`, `resolved`, `needs_you`.
   `threads.start` in a project anchors to the entry the calling turn will
   write; Start a thread anchors to the chosen message. States: working,
   waiting (approval, `needsYou`, or a failed turn), queued, idle, resolved.
   Past the at-once limit (2 per user, unchanged) a project's `start`
   queues the thread and it starts when a slot frees, in order.
   Resolve and reopen from the tool, the API, and by a message in the thread;
   the nightly tick resolves threads idle for 7 days.
3. **The `threads` tool** gains, in a project: `message({ to: "parent",
   text, needsYou })`; `message({ id, text })` to another thread of the same
   project, marked `fromThread(id)` (`FROM_THREAD`), at most 3 per turn, and
   refused for any thread outside the project; `suggest` (a card, no thread
   made); `resolve` and `reopen`. Still one tool.
4. **Context.** A `project` section in `assemble` with
   `DEFAULT_BUDGETS.project` (2,000 tokens): goal and instructions, project
   notes since the last sleep, the project page, and in the project chat its
   threads (title, state, what each waits on, the first line of its last
   update; resolved ones only counted). `pageForProject`, `projectNotes`
   (by citation, never stored apart).
5. **Guidance.** Her tool guidance in a project chat and in a project's
   thread, as DESIGN's "Projects" says: answer quick questions in place, one
   thread per task, route follow-ups to their thread and say which, suggest
   when asked to propose first, save how Li wants it run as a project note;
   in a thread, updates at milestones, `needsYou` only when Li must decide,
   `remember` for lasting decisions, resolve when delivered. Guidance, never
   a boundary.
6. **Files.** `inheritSettings` grants a project's thread the project
   chat's folder (read-only for a read-only thread).
7. **Paused, Hide, Delete.** Paused and Hide stop a project's working
   threads and start nothing new (as Lock stops children) and refuse
   messages while paused. Delete forgets the project chat, its threads, the
   project page, the notes that came only from it, and its folder.
8. **API**, as in contracts' daemon entry: create and make project, goal,
   paused and threads model, Start a thread, resolve and reopen,
   suggestions, overview, Recent calls filtered by project, `ThreadSummary`
   fields and the `child` event, the `waiting` Notifications type.
9. **Docs.** docs/delegation.md (projects under Child threads),
   docs/memory.md (project page and notes), docs/daemon.md describe what
   exists; DESIGN's "not built yet" line and the contracts' Planned entries
   become plain text.

## Out of scope

- The web UI (Projects web) and sleep's project page (Projects sleep).
- Updates waking her in the project chat (Li decided: not at first).
- Moving an existing thread into a project, schedules in a project, sharing
  a project.

## Done when

- `npm run typecheck`, `npm test` and `npm run evals` run in CI (evals may
  report failures as evidence).
- Tests show that:
  - a project's thread inherits pool, local-only and "Do not log" and can't
    widen its workspace; a child of a project thread is refused;
  - a private project's page and notes never appear in a general view;
  - a note remembered in one thread is in the next thread's `project`
    section;
  - a sibling message reaches only a thread of the same project, can't be
    sent by a user, and stops at 3 per turn;
  - a start past the limit queues and runs when a slot frees;
  - anchors survive a rewind of later turns, and a rewind that removes the
    anchor leaves the thread, unanchored;
  - resolve, reopen and the 7-day auto-resolve; Paused refuses messages;
  - Delete forgets threads, page, notes and folder;
  - no text reaches `user.db` or a log.
- Evals (`evals/project-coordinator.eval.ts`): in a project chat she
  answers a quick question herself, starts one thread per task for a
  message with several, routes a follow-up to the thread already on it, and
  saves "run two at a time" as a project note.

## Handoff notes

(The thread fills this in if it stops before it's done.)
