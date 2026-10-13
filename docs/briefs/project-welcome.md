# Brief: New-project welcome and Continue as Project

**Thread:** Web UI (UI) with Projects back end (seeding). **Branch:**
`feature/project-welcome`. **Model:** Fable for the UI, Opus for the seed.
**Status:** proposed; needs the owner's go before anyone builds it.

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
   - **Connect repo** (Claude's "Connect tools") opens the Repositories
     picker already in the Project settings page under This chat (ux.md
     §6, "A thread's repositories"); no new picker. Once a repository is
     granted, Lyrica is told and clones nothing herself.
   - **Make a plan** sends a first message asking for a plan, which gets the
     existing plan card.
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

## Docs to update in the build PR

docs/ux.md §6 (the A project row and the vocabulary list: Connect repo,
Set up from recent work, Make a plan, Continue as Project), DESIGN.md
"Projects", docs/web.md, docs/contracts.md if the seed needs a daemon
route, and docs/briefs/projects-web.md.

## Open questions

- Is the seed's summary written by the thread's own model, or by the
  project's? (Default: the thread's, so local-only holds.)
- Should the welcome come back if the user clears the chat?

## Handoff note

2026-10-12: brief written, nothing built. Next: the owner's go, then a
Web UI thread and UI review's pass on the welcome card against ux.md.
