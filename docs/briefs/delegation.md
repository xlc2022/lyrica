# Brief: Delegation

**Thread:** Delegation. **Branch:** `feature/delegation`. **Depends on:**
Memory (merged), Workspace (#6) and Models. Start once both are merged.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md ("Models and endpoints"),
docs/delegation.md, and docs/contracts.md (`delegate`, `core/store`,
`core/workspace`, `core/models`).

## Goal

Lyrica can hand work to subagents, in every pattern `docs/delegation.md`
lists, without weakening anything: privacy, local-only, the sandbox, and
encrypted storage. Feature-complete is the bar.

## In scope

Everything in the "yes" rows of `docs/delegation.md`:

1. **The `delegate` tool**, one tool with actions:
   - run work: `task`, `tasks: [...]` (parallel), `chain: [...]`, `loop`
     (worker, then reviewer, up to N rounds), `council` and `workflow: name`,
     each optionally `background: true`;
   - and `status`, `wait`, `stop`, `steer` and `answer` on a run ID.
2. **Runs.** Each run:
   - creates a child thread with `createThread({ parent, interface })`,
     recorded as a subagent, so it is listable under its parent;
   - calls `workspace.inheritSettings` (narrowing only);
   - resolves its model through the router with the child's `CallContext`;
   - runs a Pi SDK session in-process, with entries recorded through
     Memory's `recordEntries`.

   Subagents get read-only memory (`recall`, `read_memory`) and the
   workspace tools their role allows.
3. **Roles.**
   - Built-in roles: scout, researcher, reviewer, worker and oracle. Adapt the
     prompts from `pi-subagents`' MIT `agents/*.md` (`npm pack pi-subagents`),
     with a credit line in the source.
   - Custom roles and overrides, stored in the user's `user.db`: prompt,
     default tier, tools, read-only flag and thinking level.
4. **Background runs.**
   - A run ID is returned at once.
   - On finishing, the result is delivered into the parent thread as a
     message she sees on her next turn. If the parent is busy, use Pi's
     follow-up.
   - A run interrupted by a `lyricad` restart is marked **interrupted**, never
     silently lost.
5. **Questions.** A child can end with a question. A foreground run returns
   it as the result. A background run pauses until `answer`.
6. **Parallel writers.** Two writers never share a folder. In a git
   repository, each parallel writer gets a `git worktree` under the home
   workspace, and the result says where its changes are. Otherwise, writers
   run one at a time.
7. **Limits and accounting.**
   - Limits: depth (default 1, configurable up to 3), per-thread concurrency,
     total runs per request, and a timeout per run.
   - Tokens and cost, per run and per parent thread.
8. **Events** for the web UI's live view: started, output, tool call,
   question, finished, stopped, interrupted, and usage. Expose them as a
   typed emitter that `lyricad` can forward over server-sent events (SSE).
9. **Saved workflows,** stored in `user.db`: named chains, loops and
   councils.
10. **Developer bench.** Delegation works in `lyrica dev`, including a
    background run whose result arrives on a later turn.

## Out of scope

- The web live view (Web thread). Only the events are in scope here.
- External coding CLIs as subagents.
- The watchdog.
- Durability across restarts.
- Missions and schedules.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, with a fake model server, show that:
  - a subagent in a private or local-only thread can only get a local model;
  - a subagent can't widen its parent's folders, switches or hosts;
  - an unlogged parent makes unlogged children;
  - subagent threads list under their parent;
  - parallel runs respect the concurrency limit;
  - a chain passes each output on, a loop stops when the reviewer approves,
    and a council combines answers;
  - a background run's result reaches the parent, and `stop` stops it;
  - a question pauses a background run until it's answered;
  - two parallel writers in a git folder get separate worktrees;
  - depth and run limits refuse more;
  - a run interrupted by a restart is reported as interrupted.
- `docs/delegation.md` describes what exists, and any contract change is
  listed in the pull request description.

## Handoff notes

(The Delegation thread fills this in if it stops before it's done.)
