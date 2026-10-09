# Delegation: subagents

Lyrica hands work to subagents with one tool, `delegate`. It is her own,
built on Pi's SDK; it borrows the role prompts and feature list of
`pi-subagents`, not its runtime (see DESIGN.md History). Code:
`extension/src/delegate/` and `core/src/delegation.ts`.

## Guarantee

A subagent never reaches more than its parent does: its
model comes from the router with the parent's rules, its workspace is the
parent's or narrower, an unlogged parent makes it unlogged, and it can read
memory but not write it. Effects that already happened (files written,
commands run) are not undone by stopping a run.

## What a run is

A **run** is one `delegate` call. It starts one or more **subagents**. Each
subagent:
- is a Pi session inside the same process (`openThreadSession`), never a
  separate `pi` process;
- has its own thread, created with `createThread({ parent, subagent: true })`,
  so it lists under its parent and the UI can nest it. Its entries are
  recorded like any thread's;
- gets its model from `childContext(parent.call, child, { tier } | { model })`:
  the parent's `subagent.cheap` or `subagent.strong` model, or a named model
  the parent's context allows. In a private or local-only thread that is
  always a local model. A refused model fails the run before any thread is
  made;
- gets its workspace from `inheritSettings`: the parent's folders (or the
  ones asked for), read-only for a read-only role or `readOnly: true`, and
  internet off if asked. The workspace refuses anything wider;
- gets a short preamble plus its role's prompt instead of Lyrica's persona,
  `recall` and `read_memory` (never `remember`), `ask_parent`, and only the
  tools its role lists.

## The tool

`delegate({ action?, ... })`. The default action, `run`, takes exactly one
of:

| Work | What happens |
|---|---|
| `task` (with `role`, `tier` or `model`) | One subagent. |
| `tasks: [...]` | Several at once, within the concurrency limit. The results come back together, each under its own heading; one failing doesn't stop the others. |
| `chain: [...]` | Steps in order. Each step's task gets the previous result at `{previous}`, or appended. |
| `loop: { task, worker?, reviewer?, rounds? }` | A worker does the task and a reviewer checks it, up to `rounds` (default 3, at most 5), until the reviewer's reply says `VERDICT: APPROVED`. Both keep their threads across rounds. |
| `council: { question, models? }` | The question to several models at once (oracle role), then one strong oracle combines the answers. Without `models`, up to three of the thread's: its subagent models, then others it allows. |
| `workflow: name` (with `input`) | A saved chain, loop or council, with `{input}` filled in. |

Any of them can add `background: true`, `folders`, `readOnly: true` or
`internet: false`.

The other actions take a run `id`:
- `status`: this thread's runs (role, status, thread, model, tokens, cost),
  any open questions, and the total for the thread;
- `wait`: until the run asks a question or ends;
- `stop`: aborts its subagents' model calls and tools, including a command
  running in the sandbox;
- `steer`: sends a message to a subagent while it works;
- `answer`: answers the run's oldest open question.

A **foreground** run returns its result, or its first question, as the tool
result. **Background** runs return an ID at once. When one asks a question or
ends, a message is delivered into the parent thread:
- into the live parent session: appended at once if she is idle, so she sees
  it on her next turn; as a Pi follow-up if she is busy;
- with no live session, straight into the stored thread, after its last
  entry, so her next session on it loads it with the rest.

## Questions

A subagent calls `ask_parent({ question })` and stops. Its run waits for
`answer`, which becomes the subagent's next message; time spent waiting
doesn't count against the timeout or hold a concurrency slot.

## Roles

| Role | Tier | Tools | Writes |
|---|---|---|---|
| scout | cheap | read, bash, recall, read_memory | no |
| researcher | cheap | read, bash, recall, read_memory | no |
| reviewer | cheap | read, bash, recall, read_memory | no |
| worker | strong | read, write, edit, bash, recall, read_memory | yes |
| oracle | strong | read, recall, read_memory | no |

Prompts are adapted from `pi-subagents` 0.76.1 (MIT, credited in
`roles.ts`). A task with no role gets the worker. The parent's prompt lists
the roles and saved workflows.

**Custom roles and workflows** are stored in the user's `user.db` through
`DelegationStore` (`setRole`, `removeRole`, `setWorkflow`,
`removeWorkflow`). A custom role sets its prompt, tier, tools, read-only flag
and thinking level, and one with a built-in's name overrides it.

## Parallel writers

Two writers never share a folder. When a run starts more than one writer at
once and every writable folder of the parent is the top of a git repository
(sandbox target only), each writer gets a `git worktree` of each repository
under `worktrees/<run>-<n>/` in the parent's folder in the home workspace, on
branch `lyrica/<run>-<n>`. Git runs where the parent's tools run. The writer's
grant for the repository becomes its `.git` folder (for commits), and its task
and result name the worktree and branch. Otherwise, the writers run one at a
time, and the result says why. Writers share only the thread's scratch folder
(`/workspace`).

## Limits and accounting

`new Delegation({ ..., limits })`:
- `depth`: how deep subagents nest, default 1 (subagents can't delegate), at
  most 3. Below the limit, a subagent gets `delegate` too;
- `concurrency`: subagents working at once per parent thread, default 2. The
  rest wait;
- `runsPerRequest`: subagents one message to the parent may start, default 8;
- `timeoutMs`: per stretch of work, default 15 minutes. A timed-out run is
  stopped.

Each subagent's tokens and cost are recorded as it works. `usage(thread)`
sums a parent thread's.

## Records and restarts

`user.db` holds `delegate_roles`, `delegate_workflows` and `subagent_runs`
(one row per subagent: run, parent, role, model, status, tokens, cost,
times). No conversation text goes there: tasks, answers and results live in
the threads, in their pool's database.

Runs are not durable. The first time a user's runs are touched in a new
process, any subagent still recorded as running or asking is marked
**interrupted**, an `interrupted` event is sent, and the parent thread gets a
message naming the run and its kept threads. `stopAll(userId?)` stops live
runs, for Lock and shutdown.

## Events

`delegation.events` is a typed `EventEmitter`. Each event carries `userId`,
`pool`, `parentThreadId`, `runId` and `threadId`, and is emitted under its
type and under `"event"`:

| Type | Extra fields |
|---|---|
| `started` | `role`, `model`, `title` |
| `output` | `delta` (text as it streams) |
| `tool_call` | `toolName`, `args` |
| `question` | `question` |
| `finished` | `status`: `finished` or `failed` |
| `stopped` | `reason`: `stopped` or `timeout` |
| `interrupted` | |
| `usage` | `inputTokens`, `outputTokens`, `cost` (running totals) |

## Not here

- External coding CLIs (Claude Code, Codex) as subagents: they would send her
  work outside the router.
- A watchdog or LSP checks: use the reviewer role or a loop.
- Durable runs, missions and schedules.
