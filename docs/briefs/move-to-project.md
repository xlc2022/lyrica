# Brief: Move to project

**Built by:** Codex on lunasa, one run (below). The Claude thread that wrote
the project-welcome brief reviews the diff, opens the PR and takes it
through PR review and UI review. **Branch:** `feature/move-to-project`.
**Status:** not started.

**Read first:** AGENTS.md, docs/ux.md §6 (the thread menu row, the Fold in
row and the confirm-before-add rule), docs/briefs/project-welcome.md,
`web/src/ThreadMenu.tsx`, `web/src/flyout.tsx`, `web/src/Project.tsx`
(`FoldCard` and its fold dialog), `daemon/src/hosted.ts` (`recentWork`).

## Goal

A thread that belongs in an existing project has no way in today. The only
paths are a fold Lyrica suggests, or starting a new project. Serves
principle 1 (the user does the common thing in one place) and the owner's
rule that nothing joins a project before a modal confirm with Cancel
(2026-10-13).

## In scope

1. **Move to project** in a top-level, non-project, non-subagent thread's
   right-click menu, next to Continue as project. Its tooltip is "Moves
   this thread and its child threads into a project." On a device that can
   hover it opens a flyout listing the pinned and recent projects of the
   thread's own pool, by title. On a phone it opens a submenu with the
   same list.
   - A local-only thread lists only local-only projects.
   - When no project qualifies, the item doesn't show.
2. Picking a project opens the fold confirm dialog that Fold in uses, with
   the same title, thread and child list, losses, unticked access box,
   one-way warning, Cancel and **Fold in**. Nothing happens before Fold in.
   Confirming calls the existing `POST …/threads/:pool/:projectId/fold`
   (and the settings route first when the box is ticked), then opens the
   project chat.
3. Reuse the dialog. If it lives inside `FoldCard`, lift it into its own
   component that both callers use. Add no second copy.
4. **Continue as project tidy-up (PR review note on #290):** when the only
   recent-work id is the Continue as project source, `recentWork()` leaves
   out the fold-suggesting directions, since that flow keeps the source
   thread in place.

## Out of scope

- Any new back-end route. The fold route already refuses other pools,
  projects, subagents and a local-only thread into a cloud project chat.
- Moving a thread out of a project.

## Done when

- e2e: Cancel leaves the thread where it was; Fold in moves it with its
  children; a private thread's menu lists no general project.
- A daemon test covers the Continue as project directions change.
- `npm run typecheck` and the web and daemon tests pass; PR review and
  UI review verify.

## Docs to update

docs/ux.md §6 (the thread menu row and the vocabulary list), docs/web.md,
and docs/briefs/project-welcome.md (a pointer here).

## Codex run

From a fresh worktree on lunasa, started with `</dev/null`. A minute later,
check it writes a session log under `~/.codex/sessions`.

```
Branch feature/move-to-project off origin/main. Read AGENTS.md, docs/ux.md
section 6, docs/web.md and docs/briefs/move-to-project.md, then build its
In scope. Reuse the fold confirm dialog from web/src/Project.tsx (lift it
into a shared component if it is local to FoldCard) and the flyout from
web/src/flyout.tsx; add no new widgets or dialogs. Update the docs the
brief lists. Run npm run typecheck, then the daemon and web test suites
one at a time. Take screenshots at 1280 and 390 px of the open flyout and
the confirm dialog. Commit naming principle 1, push, and stop: print the
head commit, a summary and the screenshot paths. Do not open a PR.
```

## Handoff note

2026-10-13: written after #290 merged; nothing built.
