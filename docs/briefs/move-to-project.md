# Brief: Move to project

**Built by:** Codex on lunasa, one run (below). The Claude thread that wrote
the project-welcome brief reviews the diff, opens the PR and takes it
through PR review and UI review. **Branch:** `feature/move-to-project`.
**Status:** implementation prepared and targeted checks passed; awaiting full suite and review.

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


Run handoff (2026-10-13): principle 1 implementation is in the working tree on
feature/move-to-project. ThreadMenu uses the existing flyout/phone submenu,
filtered to visible same-pool projects, pinned then recent, and local-only
projects for local-only sources. FoldConfirm is shared with FoldCard; it
lists child threads and losses, grants ticked access through settings before
folding, and warns when cloud models are lost. Continue as project omits
fold-suggesting directions for its single source. Presets remain in use;
no schema step or new API route was needed. Updated ux.md, web.md, the
project-welcome pointer, contracts and DESIGN (including stale Keep access
wording). UX homes: section 6 thread menu and Fold in; existing widgets
follow sections 2–3, phone behavior section 8.

Validation: typecheck and build passed; under the shared test lock, 25 daemon
project tests and 21 selected web tests (fold, flyout, cards, images) passed.
Existing project welcome/fold and the new move flow passed at 1280 and 390 px
with fake endpoints only. Screenshots checked with no horizontal overflow:
shots/move-flyout-1280.png, shots/move-flyout-390.png,
shots/move-confirm-1280.png, shots/move-confirm-390.png. The phone screenshot
shows the in-place submenu. shots/ and web/playwright.local.config.ts stay
untracked; never include them in a commit. No commit, push or PR was made,
per the latest run instructions. Next: the user runs the full suite, commits
and pushes, then the brief's owning thread takes the work through review.
