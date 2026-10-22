# Brief: The changes view

**Status:** Built; in review.

**Thread:** Changes view for PRs. **Branch:** `claude/project-thread-h16cf8`.
**Model:** Opus.

**Read first:** AGENTS.md, DESIGN.md "Files and images" (Changes),
docs/ux.md §6 ("A thread's branch and pull request", "The changes a thread
made in a repository"), docs/web.md (Chat, "Changes"), docs/daemon.md
"Changes", `core/src/workspace/git-changes.ts`, `web/src/Changes.tsx`,
`web/src/diff.ts`.

## Goal

The user asked (2026-10-22) for what Claude's own app shows of a branch: a
bar in the thread with the pull request's number, the branch and "+n −m",
opening a Changes dialog with the files at the left, a commits list under
them, and each file's diff at the right, unified or side by side, with the
unmodified stretches folded (principle 6: see what she did without leaving
the thread). Until now a thread showed nothing of its branch; the branch,
commits and checks reached her prompt only.

## In scope

1. **The badge:** one per checkout whose branch has moved from its base or
   has a pull request, in the thread header's facts line: PR number and
   check dot when the forge watcher knows an open pull request, the branch,
   the counts, a caret.
2. **The view:** a dialog like the file viewer. Files and commits at the
   left (All changes, Not committed, each commit); a section per file at the
   right with folds, word marks inside changed pairs, Unified | Side by side
   from 1180 px up, unified on a phone.
3. **Reading git** where the thread's tools run, with fixed argv
   (`ExecutionTarget.run`), for its worktrees, clones and writable granted
   repositories: `GET …/changes`, `…/changes/commit`, `…/changes/file`.
   The diff is computed in the browser (`diff.ts`); nothing is stored.
4. **The pull request** from the forge watcher's last poll
   (`ForgeWatcher.openPull`): number, head, URL, checks.
5. **Docs:** DESIGN.md, docs/ux.md, docs/web.md, docs/daemon.md,
   docs/contracts.md, the `api.ts` comments, the app mockup.

## Out of scope

- Review comments, approving or merging from the view: the forge has them.
- Diffs on an SSH machine's checkout (its tools don't run git for the
  daemon); the badge stays away there.
- Counts on a project thread's card in the project chat (its "+n" files).

## Handoff

Done: the back end (core `git-changes.ts`, routes, the watcher's `openPull`),
the web badge and dialog, unit tests (core `git-changes.test.ts`, web
`diff.test.ts`), an e2e test with the routes answered from a fixture
(`web-chat.spec.ts`, "changes view"), docs and the mockup.
Next: UI review's verified, PR review (the daemon routes), merge.
Open: whether a project thread's card should carry the counts too.
