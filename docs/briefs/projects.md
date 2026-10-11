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
   there is no way back). Making a project pins it. This brief builds
   **thread pins** for every thread, since Projects comes first: a per-user
   `pinned_threads` table in `user.db` (thread and pool, no text; never in
   the pool, like `thread_groups`), `PUT`/`DELETE threads/:id/pin`, and
   `ThreadSummary.pinned`. Web UI 2's Pin in the thread menu uses them. `Thread.project`, `Thread.goal`. Project settings
   with no text (threads model and thinking, paused) in `user.db` with the
   thread's other settings.
2. **Anchors and states.** `child_threads.anchor`, `resolved`, `needs_you`.
   `threads.start` in a project anchors to the entry the calling turn will
   write; Start a thread anchors to the chosen message. States: working,
   waiting (approval, `needsYou`, or a failed turn), queued, idle, resolved.
   Past the at-once limit (2 per user, unchanged) a project's `start`
   queues the thread and it starts when a slot frees, in order.
   A branch of the project chat or of a project's thread is a thread of the
   project (parent the project chat), never a thread under a thread.
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
- Updates waking her in the project chat: see "Watching threads" below.
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
  - a branch of a project's thread is a thread of the project, beside its
    source;
  - anchors survive a rewind of later turns, and a rewind that removes the
    anchor leaves the thread, unanchored;
  - resolve, reopen and the 7-day auto-resolve; Paused refuses messages;
  - Delete forgets threads, page, notes and folder;
  - no text reaches `user.db` or a log.
- Evals (`evals/project-coordinator.eval.ts`): in a project chat she
  answers a quick question herself, starts one thread per task for a
  message with several, routes a follow-up to the thread already on it, and
  saves "run two at a time" as a project note.

## Watching threads (follow-up, Li 2026-10-11)

Li wants the project chat to work the way a coordinator does: notice what
Li and a thread decide, tell the other threads it touches, and bring their
answers back. Li chose a project setting, on by default.

1. **Setting.** `project_settings.watch` in `user.db` (a new column,
   default on); `PATCH` `watchThreads`, `ThreadSummary.watchThreads`. No text.
2. **What triggers a look.** In a logged thread of the project, a turn that
   Li started ends, or the thread posts an update or `needsYou` to the
   project chat. Messages from the project chat or a sibling don't trigger
   one on their own; their update to the chat does.
3. **The look.** 30 seconds after the first trigger, lyricad sends the
   project chat one message marked `[Watching threads]` (a mark only
   `lyricad` writes, like `[From t:…]`). It holds, per thread, a mention, the
   first 500 characters of what Li wrote there, and of the thread's reply.
   Updates are already in the chat, so they are named, not repeated. If the
   chat is busy, the look waits for its turn to end. Paused, hidden, locked
   or switched off: nothing is sent, and pending triggers are dropped.
4. **Her guidance** for such a turn: decide whether another thread is
   affected, message it with what it needs to know, and relay answers; say
   nothing in the chat unless Li must know or decide; never repeat Li's
   words back to Li. Guidance, not a boundary.
5. **Limits.** At most 3 looks in a row without Li writing anywhere in the
   project; the count resets when Li writes. Each look is one turn of the
   project chat's model, so its cost is visible in Recent calls.
6. **Web** (projects-web): a **Watch threads** switch on the General
   page; a `[Watching threads]` message shows as a one-line notice
   ("Looked at her threads"), expandable, never as Li's bubble.
7. **Sleep** (projects-sleep): a look quotes Li; sleep takes Li's words
   from the thread where they were said, never from the look.
8. **Tests:** a turn Li starts in a thread leads to one look after the
   delay; two threads in the delay make one look; an unlogged thread, a
   paused project and the setting off make none; the fourth look in a row
   waits for Li; a user can't write the mark.

Built (back end): items 1 to 5, and the test for a look, the setting off,
the mark and a run of looks. Item 6 is projects-web's, item 7
projects-sleep's. Found while building: an update to a project chat that is
mid-turn arrives as a follow-up that starts a turn (Delegation's delivery,
as for any busy parent), with or without watching.

## Handoff notes

Done (2026-10-11): everything in scope except the items below.

Left for a follow-up, each small:
- A failed turn doesn't yet count as **waiting**; only an approval and
  `needsYou` do.
- The project section and `ThreadSummary` don't carry the first line of a
  thread's last update, or `outputs` (the files it made).
- A read-only project thread can still write in the shared project folder,
  as a read-only child thread can today (threads work in their parent's
  folder through `folderThread`).
- There is no Notifications API yet, so there is no `waiting` type; the
  `needsYou` summary field and the `waiting` notice carry it until Web UI 2
  builds Notifications.
