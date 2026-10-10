# Brief: Child threads (Lyrica starts threads of her own)

**Thread:** Delegation (continuing after Delegation 2). **Branch:**
`feature/child-threads`.

**Depends on:** Delegation 2 merged (its message path and approvals in two
views are reused here).

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Models and endpoints" (the Subagents, Child threads and "chooses
  between them" bullets) and "Memory" (threads that aren't logged, daughter
  threads);
- docs/delegation.md, docs/daemon.md, docs/web.md, docs/memory.md;
- docs/contracts.md: `delegate`, `extension`, `daemon`, `core/store`.

## Goal

The user can regenerate, delete, edit and branch at any turn (weak local
models often need a few tries), and Lyrica splits
work the way Claude does: a subagent for a bounded answer she
needs now, a child thread for a stream of work of its own that the user can
follow and steer. Child threads sit under their parent in the sidebar, keep
going in the background, and talk with their parent. This serves principle 1
(long work doesn't swallow a conversation) and keeps every inherited rule
structural.

## In scope

1. **The `threads` tool** (one tool, within the budget):
   - `start({ title, task, folders?, readOnly?, internet? })` creates a child
     of the calling thread (`createThread({ parent, child: true })`) and
     starts it working on `task` in the background. It returns the thread's
     ID and a link at once.
   - `message({ id, text })` from a parent to its child, and
     `message({ to: "parent", text })` from a child: delivered into the live
     session or the stored thread, as Delegation 2 delivers notes.
   - `list` shows the calling thread's children: title, status (working,
     waiting for approval, idle), last update.
2. **What a child thread is.**
   - Full Lyrica: persona, memory tools, `delegate` and the tools its
     settings allow. Not a role prompt.
   - Inherits the parent's pool, "Do not log", local-only, permission mode
     and workspace settings; `start` can only narrow them, and the workspace
     refuses anything wider (`inheritSettings`). Its model comes from the
     router with its own `CallContext`, so a private or local-only parent's
     child is local-only.
   - Depth 1: a child thread can't start child threads (it can delegate).
     Limits: children started per user request (default 3) and children
     working at once per user (default 2), like Delegation's.
3. **Updates and messages.**
   - The child posts short updates with `message({ to: "parent" })` at
     milestones and when done; the prompt says when (not after every step).
   - In the sidebar the child gets a badge when it posts; in the parent an
     update shows as a card linking to the child.
   - The user talks in a child thread like any thread; the parent is not told
     about that (it's the user's conversation with the child).
4. **Approvals** in a child thread work as in any thread, and also appear in
   Notifications.
5. **Choosing.** Lyrica's tool guidance gives the rule from DESIGN: subagent
   for a bounded answer she needs to carry on; child thread for a stream of
   work of its own. Add an eval with a few requests of each kind, checking
   which she picks (a failure is evidence, not a broken build).
6. **Lifecycle.**
   - A child keeps its thread until forgotten. Lock stops working children;
     after a restart they are idle, never silently resumed, and the parent is
     told.
   - Forgetting a parent asks whether to forget its child threads too, ticked
     by default (API flag; the store cascades when set).
6a. **Branching by the user.**
   - `branchThread(threadId, entryN)` in the store: a child thread with the
     entries up to and including `entryN`, copied as an export copies them
     (`orig` keeps the source ID), titled from the source ("… (branch)",
     editable).
   - API: branch from a message.
     Same pool and owner checks as reading the thread; the branch inherits
     the parent's settings (it can't widen them) and is unlogged if the parent
     is.
   - Tests: a branch holds exactly the turns up to the chosen one; the source
     thread is unchanged; citations to copied entries resolve; sleep and
     search don't count copies twice; a branch of a private or local-only
     thread stays so.
6b. **Rewinding in place.**
   - `truncateThread(threadId, fromN)` in the store removes entries `fromN`
     onwards through the same path as forgetting: rows and index entries
     gone, notes written in those turns deleted, pages that cite them
     flagged, tombstones kept so sleep never re-notes them. Subagent runs
     started in those turns are stopped and their threads forgotten.
   - API, with the session's `turn` lock so nothing runs meanwhile:
     **Regenerate** (truncate from a reply, then resend its user message,
     optionally with a chosen model from the thread's allowed list, checked
     by the router), **Delete** (the last turn) and **Delete from here**,
     **Edit** (truncate from a user message and send the edited text).
   - Undo is a short delay in the UI before the request is sent, not a
     restore.
6c. **Orphans.**
   - Automatic with the removal: subagent runs and threads from those turns;
     images and outputs in the thread's folder, uploads attached only to
     removed messages, and scratch files those turns made.
   - **File snapshots** (Workspace's operations, the only place this
     touches it): before `write` or `edit` changes or creates a file, record
     the change against the entry (path, created or changed, hash after) and
     keep a snapshot of the earlier content in the user's encrypted home.
     Never for files outside the thread's granted folders.
   - Before removing, the API reports, per file: created (delete), changed
     (restore), changed since by something else (keep), touched only by a
     command (not tracked); plus subagents and git branches from those turns
     (branches with no commits ticked). The user can untick any item; the
     removal then applies the ticked ones.
   - A nightly sweep in `lyricad` removes thread folders of forgotten
     threads, worktrees with no live run, and snapshots older than 30 days.
     It logs counts only.
   - Tests: regenerate replaces the reply and what followed; regenerate with
     a cloud model in a local-only thread is refused; delete from the end
     repeatedly; a note written in a removed turn is gone and sleep doesn't
     see the turn; a page citing it is flagged; a running subagent from a
     removed turn is stopped; a file a removed turn created is deleted and one
     it changed is restored; a file edited since is kept and listed; a file
     touched only by a command is listed as not tracked; images from removed
     turns are gone; the sweep removes old snapshots and orphaned worktrees;
     nothing outside the granted folders is ever touched; no text reaches a
     log.
6d. **Pinned messages.**
   - Store: pin and unpin an entry (`pinned` on the entry; listed per thread
     and across a pool), copied with a branch, removed with the entry.
   - Context: a `pinned` section in `assemble` (budget 2,000 tokens, in
     `DEFAULT_BUDGETS`) holding pinned entries verbatim; compaction leaves
     pinned entries out of what it summarises. Over budget, the oldest pins
     are summarised and the thread's header says so.
   - Sleep: pinned entries in the material are marked as pinned.
   - Tests: a pinned message survives compaction word for word; the budget
     holds; a branch keeps pins; removing a pinned turn is reported; pins of
     a private thread never appear in a general view.
7. **Web UI.**
   - Every message's menu: **Pin**, **Branch from here**, **Delete from here**; on
     Lyrica's replies **Regenerate** and **Regenerate with…** (a model
     picker); on the user's messages **Edit**; and **Delete** on the last
     turn. Removing turns confirms with the file and branch list (ticked by
     default), then shows an Undo toast. A new branch opens, nested under its parent. Children nest collapsibly under their parent (as forks do),
   with status and the update badge; update cards in the parent; `threads`
   calls render as a card.
8. **Docs.** docs/delegation.md (or a new docs/threads.md if it reads better),
   docs/daemon.md, docs/web.md, docs/memory.md describe what exists; the PR
   lists contract changes.

## Out of scope

- Child threads of child threads started by Lyrica (a user may branch a
  branch; Lyrica's own children stay one level deep).
- Versions inside one thread (ChatGPT's < 1/2 >): branches replace them.
- Moving a child to another pool.

## Done when

- `npm run typecheck`, `npm test` and `npm run evals` run in CI (evals may
  report failures as evidence).
- Tests show that:
  - `start` creates a nested child that works in the background and returns
    at once;
  - a child of a private or local-only parent gets local models only, and of
    an unlogged parent is unlogged;
  - `start` can narrow folders and permissions but never widen them;
  - messages flow both ways, live and stored;
  - the depth and concurrency limits hold;
  - Lock stops children and a restart leaves them idle with the parent told;
  - forgetting a parent with the flag forgets its children, and without it
    keeps them;
  - no message text reaches a log.

## Handoff notes

(The thread fills this in if it stops before it's done.)
