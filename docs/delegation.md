# Delegation: subagents

Lyrica hands work to subagents with one tool, `delegate`. It is her own,
built on Pi's SDK; it borrows the role prompts and feature list of
`pi-subagents`, not its runtime (see DESIGN.md History). Code:
`extension/src/delegate/` and `core/src/delegation.ts`.

## Guarantee

A subagent never reaches more than its parent does: its
model comes from the router with the parent's rules, its workspace is the
parent's or narrower, an unlogged parent makes it unlogged, and it can read
memory but not write it. The parent's rules are read again before every
turn, so a parent switched to local-only, made unlogged or forgotten stops
its cloud or logged subagents at their next turn. Effects that already
happened (files written, commands run) are not undone by stopping a run.

## What a run is

A **run** is one `delegate` call. It starts one or more **subagents**. Each
subagent:
- is a Pi session inside the same process (`openThreadSession`), never a
  separate `pi` process;
- has its own thread, created with `createThread({ parent, subagent: true })`,
  so it lists under its parent and the UI can nest it. Its entries are
  recorded like any thread's;
- gets its model from `childContext(parent, child, { tier } | { model })`,
  with the parent's `CallContext` as it is when the subagent starts: the
  parent's `subagent.cheap` or `subagent.strong` model. She picks a tier,
  never a model; only a saved workflow, which a user writes, may name a model
  the parent allows. In a private or local-only thread it is always a local
  model. A refused model fails the run before any thread is made;
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
| `task` (with `role` or `tier`) | One subagent. |
| `tasks: [...]` | Several at once, within the concurrency limit. The results come back together, each under its own heading; one failing doesn't stop the others. |
| `chain: [...]` | Steps in order. Each step's task gets the previous result at `{previous}`, or appended. |
| `loop: { task, worker?, reviewer?, rounds? }` | A worker does the task and a reviewer checks it, up to `rounds` (default 3, at most 5), until the reviewer's reply says `VERDICT: APPROVED`. Both keep their threads across rounds. |
| `council: { question }` | The question to up to three of the thread's models at once (oracle role): its subagent models, then others it allows. Then one strong oracle combines the answers. |
| `workflow: name` (with `input`) | A saved chain, loop or council, with `{input}` filled in. |

Any of them can add `background: true`, `folders`, `readOnly: true` or
`internet: false`.

The other actions take a run `id`:
- `status`: this thread's runs (role, status, thread, model, tokens),
  any open questions, which can be continued, and the total for the thread;
- `wait`: until the run asks a question or ends;
- `stop`: aborts its subagents' model calls and tools, including a command
  running in the sandbox;
- `message`: talks to one of its subagents (below).

A **foreground** run returns its result, or its first question, as the tool
result. **Background** runs return an ID at once. When one asks a question or
ends, a message is delivered into the parent thread:
- into the live parent session: appended at once if she is idle, so she sees
  it on her next turn; as a Pi follow-up if she is busy;
- with no live session, straight into the stored thread, after its last
  entry, so her next session on it loads it with the rest.

## Talking with subagents

`delegate({ action: "message", id, message, thread? })` sends one subagent of
the run a message (`Delegation.message`):
- **working:** it joins the turn in progress (Pi's steer), or its next turn
  if it is between turns;
- **waiting on `ask_parent`:** it is the answer;
- **finished, failed, stopped or interrupted:** the subagent continues in its
  own thread, with its whole history, under the same run ID. It is a new
  stretch of work: the usual timeout, a concurrency slot while it works, and
  one more against `runsPerRequest`. Its model and workspace are worked out
  again from the parent's settings as they are now, from the tier (or named
  model) and narrowing recorded when it started: a parent turned local-only
  gives a local model, and a forgotten or unlogged parent refuses. A writer
  takes the parent's folders again (no worktree). This works after a
  restart, from the stored thread: what a subagent is told is stored as soon
  as it is sent.

`thread` picks the subagent. Without it, a run with one subagent waiting, or
only one subagent, is clear; anything else is an error that lists the
threads. A subagent that has ended while the rest of its run still works
can't be continued until the run ends.

A foreground run's `message` waits like `wait`; a background run's returns at
once, and the reply is delivered.

**Questions.** A subagent calls `ask_parent({ question })` and stops. Its run
waits for a message, which becomes the subagent's next one; time spent
waiting doesn't count against the timeout or hold a concurrency slot.

**Notes.** `ask_parent({ question, wait: false })` sends a note and the
subagent keeps working. The note is delivered like a background result, and
sent as a `note` event. A subagent may send `limits.notes` (default 3) per
stretch of work; past that the tool refuses.

**The user.** A user's message in a subagent's thread goes through the same
`message`, marked as theirs: it reaches the subagent as a custom message
(`USER_MESSAGE`) that names them, which only lyricad can make. A short note
goes to the parent thread: who wrote what to which subagent. A run a user
has messaged delivers its questions and outcome to the parent, since no tool
call waits for them.

## Approvals

A subagent's file and command tools go through the workspace extension's
`tool_call` hook with its parent's permission mode as it is now (or its own,
if stricter). Where that mode asks, the hook calls `DelegationOptions.approve`
with the subagent's run, thread, role and the exact call; lyricad shows it in
the subagent's thread and the parent's. A deny, no answer in time, Stop, or
the subagent being stopped refuses that one call, and the subagent is told
"Not approved", as the parent would be. With no `approve` (no lyricad), every
such call is refused. So writers run in threads that ask first, and parallel
writers each ask for their own calls.

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

Two writers never share a folder. A writer takes its parent thread's folders
for as long as it lives, so writers from any runs of that thread go one at a
time. The exception is a run that starts more than one writer at once when
every writable folder of the parent is the top of a git repository (sandbox
target only):
- each writer gets a `git worktree` of each repository under
  `worktrees/<run>-<n>/` in the parent's folder in the home workspace, on
  branch `lyrica/<run>-<n>`. Git runs where the parent's tools run, with the
  repository's hooks off;
- the writer's grant for the repository becomes its `.git` folder (for
  commits), and its task names the worktree;
- when it ends, its worktree is removed and its branch kept, and the result
  names the branch. A worktree with changes that weren't committed is kept,
  and the result says where.

Otherwise the writers take turns, and the result says why. Writers share only
the thread's scratch folder (`/workspace`).

## Limits and accounting

`new Delegation({ ..., limits })`:
- `depth`: how deep subagents nest, default 1 (subagents can't delegate), at
  most 3. Below the limit, a subagent gets `delegate` too;
- `concurrency`: subagents working at once per parent thread, default 2. A
  subagent holds a slot only while it works on a turn, so a loop or a paused
  subagent never blocks the rest;
- `runsPerRequest`: subagents one message to the parent may start, default 8,
  counting the ones its subagents start;
- `timeoutMs`: per stretch of work, default 15 minutes. A timed-out run is
  stopped;
- `notes`: notes per stretch of work, default 3.

Each subagent's tokens are recorded as it works. `usage(thread)` sums a parent
thread's. There is no cost yet: models are declared free to Pi.

## Records and restarts

`user.db` holds `delegate_roles`, `delegate_workflows` and `subagent_runs`
(one row per subagent: run, parent, role, model, status, tokens, times, and
how to continue it: its tier or named model and its run's narrowing). No
conversation text goes there: tasks, answers and results live in the
threads, in their pool's database.

Runs are not durable. The first time a user's runs are touched in a new
process, any subagent still recorded as running or asking is marked
**interrupted**, an `interrupted` event is sent, and the parent thread gets a
message naming the run and its kept threads, unless it was forgotten. A
`message` continues it from its thread; resuming mid-turn is not possible.
`stopAll(userId?)` stops live runs, for Lock and shutdown.

Forgetting a thread forgets its subagents' threads too (`forgetThread`), since
they hold its tasks and results. `forget(userId, pool, threadId)`, called
first, stops the runs it started and drops their records.

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
| `note` | `note` |
| `finished` | `status`: `finished` or `failed` |
| `stopped` | `reason`: `stopped`, `timeout` or `parent_changed` |
| `interrupted` | |
| `usage` | `inputTokens`, `outputTokens` (running totals) |

## Not here

- External coding CLIs (Claude Code, Codex) as subagents: they would send her
  work outside the router.
- A watchdog or LSP checks: use the reviewer role or a loop.
- Durable runs that keep working across a restart, missions and schedules.
