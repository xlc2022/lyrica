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

Lyrica splits work the way Claude does: a subagent for a bounded answer she
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
7. **Web UI.** Children nest collapsibly under their parent (as forks do),
   with status and the update badge; update cards in the parent; `threads`
   calls render as a card.
8. **Docs.** docs/delegation.md (or a new docs/threads.md if it reads better),
   docs/daemon.md, docs/web.md, docs/memory.md describe what exists; the PR
   lists contract changes.

## Out of scope

- Child threads of child threads.
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
