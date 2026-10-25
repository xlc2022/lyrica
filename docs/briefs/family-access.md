# Open access within a thread family

The owner's decision (2026-10-25): a project's threads, and a parent with
its child threads outside projects, stop hamstringing each other. Tonight
a project chat started duplicate threads for one pull request because it
couldn't see what its other threads had on disk, and handovers failed
because `/shared` was the only route.

A thread family is a topmost thread and every thread below it: a project
chat and its threads, or a plain thread and its children.

## What changes

1. **Every member reads every other member's folder.** Each sandbox mounts
   every other family member's thread folder read-only at
   `/thread-workspaces/<id>`. That is the path a code thread's own worktree
   already lives at, so a path one thread reports ("read my worktree at
   /thread-workspaces/…/worktrees/repo") works as-is in every other one.
   Git state comes along: she can run `git status` or `git log` there.
   `threads list` names each thread's worktree path and branch, and what
   isn't committed or pushed yet.
2. **`/shared` is no longer the only handover route.** A thread can point at
   a file in its own folder. In `/shared`, each thread writes only in its
   own `/shared/<id>/`, made for it, and reads the rest. Files `lyricad` puts
   there (a project chat's uploads and images) stay where they are.
3. **No exclusive hold on the base checkout.** Any number of `base: true`
   threads may be open. The refusal, the reopen check and the resolve when a
   pull request merges all go.
4. **The project chat's `/tmp` lasts between commands.** It is a folder of
   its own in the encrypted home, outside the thread folder, emptied when
   the thread is forgotten. Other threads keep a fresh `/tmp` per command,
   since they write in their own folders.

## What stays

- Users stay apart: a family is one user's threads in one pool.
- A local-only member's folder (it, or a thread between it and the top, is
  local-only, under a top that may call the cloud) is never mounted in a
  member that may call the cloud. The same rule already decides `/shared`
  (`sharesFamilyFolder`).
- Tokens and keys stay outside the sandbox; page preview keeps no network.
- Everything mounted from another thread is read-only, so she still
  changes and deletes only her own files.
- A member started with fewer folders or repositories reads no one
  else's folder. One with fewer machines or MCP servers still does: what
  those left in a member's folder stays inside the family, which already
  shares a persona, memory and `/shared`.
- Out of scope: cleaning up `/shared/<id>/` when a thread resolves or its pull
  request merges.

## Principles

Structural boundaries (read-only mounts, the local-only rule) instead of
instructions. Within one family nothing private crosses a boundary that
didn't already: these threads share a persona, memory and `/shared`.
