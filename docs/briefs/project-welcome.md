# Brief: New-project welcome and Continue as project

**Built by:** Codex on lunasa, in two runs (below); the Claude thread that
wrote this brief reviews each diff, opens the PRs and takes them through
PR review and UI review. **Branches:** `feature/project-welcome-api`, then
`feature/project-welcome`.
**Status:** back end implemented; web run remains after its review and merge.

**Read first:** AGENTS.md, docs/ux.md §6 (the Project rows and the
vocabulary list), DESIGN.md "Projects", docs/contracts.md (daemon,
core/store), docs/briefs/projects-web.md, `web/src/Project.tsx`,
`web/src/ThreadMenu.tsx`, `daemon/src/api.ts`, `daemon/src/routes.ts`,
`core/src/threads.ts`.

## Goal

An empty project chat is a dead end today. Lyrica wakes in it with no
folder, no repository and no goal, and asks the user what the project is
(seen on a lunasa model, 2026-10-12). Claude's own new project opens on a
greeting with three starters. Lyrica should do the same, and a thread that
has grown into a project should carry its context across instead of making
the user retype it. Serves principle 1 (the user does the common thing in
one place) and the existing Projects design.

## In scope

Pools never mix. Every list and move below stays inside the project's own
pool; a private pool's threads are read only through `openThreadView` and
only while that pool is unlocked. A local-only thread is offered, read or
moved only when the project chat itself runs local-only, so no cloud model
ever reads its text.

1. **Welcome state.** Whenever a project chat has no messages (a state,
   not a stored message, so it comes back after the chat is cleared), it
   shows a greeting card with three starters, all secondary buttons (the
   composer stays the page's main action; at 390 px they stack full
   width): **Set up from recent work**, **Add repository** and **Make a
   plan**.
   - **Set up from recent work** opens a list in place inside the card
     (no dialog: picking is editing, and ux.md lets dialogs only confirm),
     the way Change passphrase… opens its fields: the ten most recent
     top-level, non-project threads of the project's pool, each with a
     checkbox, all ticked to start, then **Continue** (primary) and
     **Cancel**. Lyrica reads the ticked threads and answers in the project
     chat with (a) a draft Goal and Instructions, her reply ending with a
     **Project settings** link that opens the page with the drafts filled
     in and unsaved, and (b) a **Fold in** card, shaped like the Suggested
     threads card, naming the threads she suggests bringing in: secondary
     **Fold in** per row, one primary **Fold in all** with the count in
     mono ("Fold in all 3"); a row goes once it is folded. Folded work takes the
     project's limits (a child's settings are its parent's or narrower), so
     each row names, muted, any folder, machine, repository or network host
     the fold would remove, then **Add to project** (secondary): it grants
     those folders, machines, repositories and hosts to the project chat
     through the existing settings route, as Save on Project settings
     would, after which the row lists nothing lost and Fold in keeps the
     thread's access. Nothing is added without that click. ux.md's Fold in
     row says so. Folding a thread
     in moves it, with its child threads, under the project, as Continue
     as project does.
   - **Add repository** opens the Add repository popover in place under
     the button: the one already on Project settings under This chat
     (ux.md §6, "A thread's repositories"), listing the repositories each
     of the user's Git accounts can see, grouped by account, with its
     search box and **Git accounts** link. A pick grants the repository to
     the project chat at once, so every thread of the project inherits it.
     No new picker; Lyrica is told and clones nothing herself.
   - **Make a plan** starts a project thread titled **Plan**, separate from
     the project chat, with a first message asking for a plan for the
     project's goal; it gets its card in the project chat and opens. The
     plan comes back as the existing plan card in that thread, and its
     suggested threads in the project chat's Suggested threads card.
2. **Continue as project** in a top-level thread's right-click menu, next
   to Make project…, tooltip "Starts a new project from this thread; the
   thread stays." (Make project… gains the tooltip "Turns this thread into
   a project."). It creates a new pinned project in the thread's pool and
   opens its Project settings. The project chat copies the thread's
   folders, machines, repositories, MCP servers, local-only switch and model
   `preset` (#283). Its
   first message links back to the thread and asks Lyrica, on the thread's
   own model (so local-only holds), to draft Goal and Instructions, shown
   on Project settings for editing, never applied silently. The thread's
   child threads move under the new project as its threads, with their
   state, checklists and wake-ups intact, each with a card in the project
   chat. The source thread stays otherwise as it is. Make project is
   unchanged (it turns the thread itself into the project, with no way
   back).

## Out of scope

- Moving or copying the source thread's own messages into the project.
- Any change to Make project beyond its tooltip.

## Build plan

**PR 1, back end** (`feature/project-welcome-api`):
- `POST …/threads/:pool/:projectId/fold` `{ threadId }` → ThreadSummary.
  Moves a top-level, non-project thread of the same pool (with its
  children) under the project, as a project thread with a card. Refused
  for another pool, a project, a subagent, another project's thread, and a
  local-only thread into a project chat that isn't local-only. Keeps
  checklists and wake-ups.
- `POST …/threads/:pool/:threadId/continue-as-project` → the new project's
  ThreadSummary, as item 2 says.
- `GET …/threads/:pool/recent?top=10`: the ten most recent top-level,
  non-project threads of the pool, without local-only ones unless the
  asking project chat is local-only (`?project=:id`).
- A `threads` tool action `fold` (her suggestion, as `suggest` is): thread
  ids; the UI draws the Fold in card from the call.
  `POST …/:projectId/folds/:callId/apply` `{ index? }` applies one or all.
- A `threads` tool action `draft` `{ goal?, instructions? }`: stores a
  draft on the project, shown on Project settings until the user saves or
  discards it; never applied by itself. Storage: new nullable draft
  columns on `project_settings` (core/src/migrations.ts), an expand-only
  user.db step with a migration test from every released schema.
  command-rules and spend-share also add user.db steps; whichever of
  these merges later renumbers its step after merging main.
- How she reads the ticked threads: Continue posts the user's ticked ids
  with the first message, and lyricad puts a bounded read of each
  (`latestEntries`, formatted as the `threads` tool's `read` formats it,
  through `openThreadView`) into that one turn's context. Only the threads
  the user ticked, only that turn; the `read` action itself is never
  widened beyond the project's own threads. Unlogged threads (`unlogged`)
  are left out of the recent list and of that context.

**PR 2, web** (`feature/project-welcome`): the welcome card and its three
starters, the in-place recent-work list, the Fold in card, Continue as
project in ThreadMenu with a free letter key, both tooltips, and the drafts
on Project settings. Run the design skills (design-critique,
accessibility-review, ux-copy). Screenshots at 1280 and 390 px of the
welcome card, the open list and the Fold in card go to UI review.

## Done when

- Tests: a fold round trip keeps children, checklist and wake-ups; a fold
  across pools is refused; a local-only thread is never listed for, or
  folded into, a cloud project chat; a draft is never applied without
  Save; an unlogged thread is never listed or read; the user.db step
  migrates from every released schema; Continue as project copies the grants, the local-only switch and the preset.
- `npm run typecheck` and `npm test` pass; PR review verifies both PRs and
  UI review verifies PR 2.

## Docs to update in the build PRs

docs/ux.md §6 (the A project row, the thread menu row, and the vocabulary
list: Set up from recent work, Make a plan, Fold in, Fold in all, Continue
as project; Add repository is already there), DESIGN.md "Projects",
docs/web.md, docs/contracts.md (routes and tool actions),
docs/briefs/projects-web.md, and docs/briefs/lyrica-project.md only if her
tools change how she works on her own code.

## Codex runs

One at a time on lunasa, from a fresh worktree, each started with
`</dev/null`; a minute later check it writes a session log under
`~/.codex/sessions`. Run 2 starts after PR 1 has merged.

Run 1 prompt:

```
Branch feature/project-welcome-api off origin/main. Read AGENTS.md,
PRINCIPLES.md, DESIGN.md "Projects", docs/contracts.md (daemon,
core/store) and docs/briefs/project-welcome.md. Build "PR 1, back end"
from its Build plan, following the patterns of the suggestions/:callId/start
route in daemon/src/routes.ts, daemon/src/api.ts and core/src/threads.ts.
Private memory only through openThreadView; model calls only through
core/models; no message text in logs or temp files. Add the back-end tests
from Done when. The draft columns are an expand-only user.db step with a
migration test from every released schema; if command-rules or
spend-share merged a user.db step first, number yours after it. Update
docs/contracts.md and DESIGN.md "Projects". Run
npm run typecheck, then the core and daemon test suites one at a time.
Commit naming principle 1, push, and stop: print the head commit and a
summary. Do not open a PR.
```

Run 2 prompt:

```
Branch feature/project-welcome off origin/main. Read AGENTS.md,
docs/ux.md (section 6 and the vocabulary list), docs/web.md,
docs/briefs/projects-web.md and docs/briefs/project-welcome.md. Build
"PR 2, web" from the Build plan in web/src (Project.tsx, ThreadMenu.tsx,
Shell.tsx; since #260, New project lives in NewButtons/NewRow and
submenus open as flyouts from web/src/flyout.tsx, so Continue as project
is a plain ThreadMenu item beside Make project…, with no submenu),
reusing the Repositories popover, the Suggested threads card
and the in-place pattern of Change passphrase…; no new widgets, dialogs or
button looks. Labels are nouns or the names given in the brief, no
captions. Update docs/ux.md section 6 and its vocabulary list, and
docs/web.md. Run npm run typecheck, then the web tests one at a time. Take
screenshots at 1280 and 390 px of the welcome card, the open list and the
Fold in card. Commit, push, and stop: print the head commit, a summary and
the screenshot paths. Do not open a PR.
```

## Handoff note

2026-10-13: brief approved and reviewed (PR review and UI review findings
folded in), nothing built. Next: Codex run 1, then this brief's thread
opens PR 1 and sends it to PR review.


Run 1 (2026-10-13, Codex on lunasa): built the recent-work, fold, fold
apply and Continue as project routes, the `fold` and `draft` tool actions,
and the expand-only user.db step 9 (draft columns, after main's steps 6 to
8). The ticked threads' text is held in memory for that one turn only,
bounded by `WELCOME_LIMITS`; unlogged threads, and local-only threads for a
cloud project chat, are refused. Drafts apply only on Save or discard.
Typecheck and the full suite passed on lunasa apart from the known updater
environment failure. Next: PR review of PR 1, then Codex run 2 (web).
