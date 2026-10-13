# Brief: New-project welcome and Continue as Project

**Thread:** Web UI (UI) with Projects back end (seeding). **Branch:**
`feature/project-welcome`. **Model:** Fable for the UI, Opus for the seed.
**Status:** approved by the owner 2026-10-13; queued for Codex on lunasa.

**Read first:** AGENTS.md, docs/ux.md §6 (the Project rows), DESIGN.md
"Projects", docs/briefs/projects-web.md, `web/src/Project.tsx`,
`web/src/ThreadMenu.tsx`.

## Goal

An empty project chat is a dead end today. Lyrica wakes in it with no
folder, no repository and no goal, and asks the user what the project is
(seen on a lunasa model, 2026-10-12). Claude's own new project opens on a
greeting with three starters. Lyrica should do the same, and a thread that
has grown into a project should carry its context across instead of making
the user retype it. Serves principle 1 (the user does the common thing in
one place) and the existing Projects design.

## In scope

1. **Welcome state.** While a project chat has no messages, it shows a
   greeting card (a marker, not a stored message) with three starters, as
   buttons: **Set up from recent work**, **Connect repo** and **Make a
   plan**. The card goes once the first message exists.
   - **Set up from recent work** opens a dialog listing the ten most recent
     top-level threads (general pool only; private threads and memory stay
     behind `openThreadView`), each with a checkbox, all ticked to start,
     and one **Continue**. Lyrica reads the ticked threads and answers in
     the project chat with a draft Goal and Instructions (applied only from
     Project settings) and a **Fold in** card, shaped like the Suggested
     threads card, naming the threads she suggests bringing in: secondary
     **Fold in** per row, one primary **Fold in all**. Folding a thread in
     moves it, with its child threads, under the project, as Continue as
     Project does. The dialog picks and confirms; it edits nothing (ux.md:
     dialogs only confirm).
   - **Connect repo** (Claude's "Connect tools") opens the Add repository
     popover in place under the button: the one already on Project
     settings under This chat (ux.md §6, "A thread's repositories"), which
     lists the repositories each of the user's Git accounts can see,
     grouped by account, with a search box and a **Git accounts** link at
     its foot. A pick grants the repository to the project chat at once,
     so every thread of the project inherits it. No new picker; Lyrica is
     told and clones nothing herself.
   - **Make a plan** starts a project thread titled **Plan**, separate from
     the project chat, with a first message asking for a plan for the
     project's goal; it gets its card in the project chat and opens. The
     plan comes back as the existing plan card in that thread, and its
     suggested threads in the project chat's Suggested threads card.
2. **Continue as Project** in a top-level thread's right-click menu, beside
   Make project. It creates a new pinned project whose **Goal** and
   **Instructions** are drafted from the thread (a summary Lyrica writes,
   shown for editing on the Project settings page, not applied silently),
   whose repositories, folders and machines copy the thread's grants, and
   whose first message links back to the source thread. The thread's child
   threads move under the new project as its threads, with their state,
   checklists and wake-ups intact, and get a card in the project chat. The
   source thread stays as it is otherwise, and its pool and local-only setting carry over; a
   local-only thread seeds with its local model only. Make project is
   unchanged (it turns the thread itself into the project, with no way
   back).

## Out of scope

- Moving or copying the source thread's own messages into the project.
- Any change to Make project.

## Build plan

Two PRs, back end first, each on its own branch off `main`.

**PR 1, back end** (`feature/project-welcome-api`):
- `POST …/threads/:pool/:projectId/fold` `{ threadId }` → ThreadSummary.
  Moves a top-level, non-project thread (with its children) under the
  project: it becomes a project thread (state, anchor none, card in the
  chat). Refused for a private thread into a general project, a project,
  a subagent or another project's thread. Keeps checklists and wake-ups.
- `POST /api/u/:userId/threads/:pool/:threadId/continue-as-project` →
  ThreadSummary of the new project. Creates a pinned project in the same
  pool, copies the thread's folders, machines, repositories, MCP servers
  and local-only switch to the project chat, folds the thread's children
  in, and posts a first message linking the source thread that asks
  Lyrica to draft Goal and Instructions with `threads draft` (below).
- `GET …/threads/:pool/recent?top=10` (or reuse the list): the ten most
  recent top-level, non-project threads the user can read in that pool.
- A `threads` tool action `fold` (her suggestion, like `suggest`): a list
  of thread ids; the UI draws the Fold in card from the call, as it draws
  Suggested threads from `suggest`. `POST …/:projectId/folds/:callId/apply`
  `{ index? }` applies one or all.
- A `threads` tool action `draft` `{ goal?, instructions? }`: stores a
  draft on the project, shown on Project settings for the user to edit
  and Save; never applied by itself.
- Tests: fold round trip (children, checklist, wake-ups), private → general
  refused, local-only carried, draft never applied without Save.

**PR 2, web** (`feature/project-welcome`): the welcome card, the Set up
from recent work dialog, Connect repo's popover in place, Make a plan's
thread, the Fold in card, Continue as Project in ThreadMenu with a
letter key, and the draft shown on Project settings. Run the design
skills (design-critique, accessibility-review, ux-copy). Both reviewers.

## Docs to update in the build PR

docs/ux.md §6 (the A project row and the vocabulary list: Connect repo,
Set up from recent work, Make a plan, Continue as Project), DESIGN.md
"Projects", docs/web.md, docs/contracts.md if the seed needs a daemon
routes and tool actions, docs/briefs/projects-web.md, and
docs/briefs/lyrica-project.md only if her tools change how she works on
her own code.

## Open questions

- Is the seed's summary written by the thread's own model, or by the
  project's? (Default: the thread's, so local-only holds.)
- Should the welcome come back if the user clears the chat?

## Handoff note

2026-10-13: brief approved, nothing built. Next: Codex on lunasa builds it, then a
Web UI thread and UI review's pass on the welcome card against ux.md.
