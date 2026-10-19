# Brief: A worktree for each code thread in a project

**Status:** Built on feature/thread-worktrees, in review.

**Branch:** `feature/thread-worktrees`. **Built by:** Codex (agent loop
area, so PR review).
**Read first:** AGENTS.md, PRINCIPLES.md (1, 6, 8), DESIGN.md (Projects,
Delegation), docs/contracts.md (core/workspace, Projects), docs/workspace.md
(Grants), docs/delegation.md (Parallel writers, Projects).

## Why

Racing sim 6 (main 6675412) was the first run where the project chat split
a build the way its guidance asks: a scaffold thread, then three `code:
true` part threads started together. All of them write in one checkout of
the granted repository. Partway through, `git status` there showed the
renderer thread's `src/renderer/` files and the HUD thread's `src/hud.js`
and `test/lap.test.js` uncommitted side by side. A `git add -A`, `git
stash` or `git checkout .` in either thread would take or wipe the other's
work. The only guard is that each brief names the files it owns, and
AGENTS.md says never to rely on telling the model.

Delegates already solve this for parallel writers: each gets a `git
worktree` on its own branch (docs/delegation.md, Parallel writers). Threads
don't.

- Principle 1: no thread can lose another thread's work.
- Principle 6: nothing widens. A thread gets its own branch of a folder it
  was already granted.
- Principle 8: reuses `makeWorktrees`, `worktreeGrants` and
  `removeWorktrees` from `extension/src/delegate/worktree.ts`; no new
  process, no new setting.

## Scope

Only host-folder grants that are the top of a git repository. Forge
repositories are already cloned per thread (`threads/<id>/repos/`), so
threads never share those clones. SSH machines are out of scope, as they
are for delegate worktrees.

## In scope

**A. A worktree per part thread.** When a project chat starts a `code:
true` thread (or a plain thread does, see E), each writable grant that is the top of a git repository is
turned into a worktree for that thread:

- Made in the child's own folder in the home workspace
  (`threads/<child>/worktrees/<repo name>`), on branch
  `lyrica/<project slug>/<thread slug>`, from the repository's current
  `HEAD`. `children.ts` makes it when it creates the child, by running git
  where the child's tools run, the way `makeWorktrees` does for a run.
- The child's grant for that repository becomes `worktreeGrants`' shape:
  the repository's `.git` writable (for commits), the checkout itself
  read-only, and the worktree in its own folder writable.
- Its prompt names the worktree and branch in the folder section, as
  `withWorktrees` does for a delegate: work and commit only there.
- If a worktree can't be made (not the top of a repository, the
  repository is mid-merge, or there's no sandbox target), the thread starts
  without one, its prompt says why, and the project chat's card shows it.
  Nothing is refused.

**B. The base thread.** `threads start` gains `base: true` for the
thread that works on the repository's own checkout: the scaffold thread
and the thread that merges (C). Only one thread of a project may hold the
base at a time. A second `base: true` start while one is open is refused
with the name of the thread that holds it. This guard is in `children.ts`,
not in the guidance.

**C. Merging the branches** (the owner chose this, 2026-10-19). When the
part threads report, the project chat starts one `code: true, base: true`
thread to merge them. That thread merges each branch in turn, runs the
tests after each merge, and sends any conflict or red test back to the
owning thread (`message`) rather than fixing that thread's files. This
keeps #375's rule that the project chat changes nothing. The split
guidance in `PROJECT_CHAT_GUIDELINES` gains a third step: scaffold, parts,
merge. The project chat doesn't get a merge tool of its own.

**D. Cleanup.** When a part thread is resolved, deleted or forgotten, its
worktree is removed with `removeWorktrees` (kept if it holds uncommitted
changes, and the note says where), and its branch is kept. The merge thread
deletes a branch after merging it.

**E. Outside a project** (the owner's rule, 2026-10-19). A plain thread
codes in place. When the user asks it for `code: true` children, each child
gets its own worktree and branch, as in A. The plain thread holds the base
and merges their branches itself; it isn't read-only. It starts a merge
thread only when the user asks for one. `CODING_GUIDELINE` says so in one
line, and merge threads stay a project-only default.

## Docs

- docs/workspace.md (Grants): part threads get worktrees, plus the base
  rule.
- docs/delegation.md (Parallel writers): the same machinery serves
  threads.
- docs/delegation.md (Projects) and DESIGN.md (Projects): scaffold, parts, merge.
- docs/contracts.md: `StartRequest.base`, and the worktree in the child's
  settings.
- docs/briefs/lyrica-project.md: the coding section.

## Tests

- In `daemon/test/children.test.ts`, two `code: true` threads started from
  a project chat on a granted git repository each get their own worktree
  and branch. A write in one doesn't show in the other's checkout, and
  each sees the repository read-only.
- A second `base: true` start is refused while the first is open.
- Resolving a part thread removes its worktree and keeps its branch.
- An eval in `evals/project-coordinator.eval.ts` checks that the merge
  step follows the parts (gated on a real model, like the split eval).

## Out of scope

- Forge repositories (already one clone per thread).
- Pushing branches or opening pull requests from part threads.
- Delegate worktrees inside a part thread's worktree. They still work, but
  they nest under the thread's folder.

## Build notes

Built sections A–E. The shared helpers moved to
`core/src/workspace/worktree.ts`. Project code threads use their own encrypted
folder, with identifier-only branch slugs and a unique `/thread-workspaces/<child>` sandbox alias so shared git
metadata never confuses two `/workspace` paths. Placement and base ownership
survive restarts in encrypted workspace settings; no schema migration.

Coverage also includes queued base holders and reopening, fallback reasons,
ordinary children staying in their parent's folder, dirty checkout retention
when forgetting files, and a real-sandbox check of unique git paths and mounts.
The coordinator eval's real-model scenario now checks scaffold, parts, merge;
it is not run against a real endpoint in this build.
