# Delegation: subagents and child threads

Lyrica hands work to subagents with one tool, `delegate`, and starts child
threads with another, `threads` ([below](#child-threads)). `delegate` is her own,
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
  so it belongs to its parent and the UI shows it in its `delegate` card. Its entries are
  recorded like any thread's;
- gets its model from `childContext(parent, child, { tier } | { model })`,
  with the parent's `CallContext` as it is when the subagent starts: the
  parent's `subagent.cheap` or `subagent.strong` model. She picks a tier,
  never a model; only a saved workflow, which a user writes, may name a model
  the parent allows, by its offering ID or as `<endpoint>/<model>`. In a private or local-only thread it is always a local
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

**Fork.** A task with `fork: true` starts its subagent from a copy of the
parent's stored conversation, then its task. The copy is made with
`copyEntries`, as an export is: entry for entry, so it is compacted as the
parent's is, each copy pointing at its original (`orig`) and not indexed
again, so search and sleep see the conversation once. The `delegate` call
still waiting for its result is left out. The tool stores the parent's current turn first. It keeps its
role's tools and prompt, and the parent's pool, rules and model limits. A fork
of a private or local-only parent is local-only itself, and stays so when
continued. Off by default: each fork costs the whole conversation again.

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
  gives a local model (as does a subagent that was local-only itself), and
  a forgotten or unlogged parent refuses. A writer
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
`tool_call` hook with its parent's mode as it is now (or its own, if
stricter; `WorkspaceSettings.effective`). Where that mode asks, the hook calls `DelegationOptions.approve`
with the subagent's run, thread, role and the exact call; lyricad shows it in
the subagent's thread and the parent's. In a thread in Plan mode only
read-only roles start (a writer fails before any thread is made), and the
subagent itself is in Plan mode: its `bash` and anything else Plan mode turns
off isn't offered. The parent's switches apply to it the same way. A deny, no answer in time, Stop, or
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
(one row per subagent: run, parent, role, model label and offering ID, status, tokens, times, and
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
first, stops the runs it started and drops their records. Removing turns
(a rewind) forgets the subagent threads started in them the same way:
`forgetSubagents(userId, pool, threads)` stops every run with a subagent
among them, with reason `parent_changed`, and drops their records. The
subagents are found by when they started, so a run from a kept turn that
started a subagent after the cut is stopped too.

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

## Child threads

A subagent gives her a bounded answer she needs to carry on. A **child
thread** is a stream of work of its own, which the user can open, follow and
steer: full Lyrica (persona, memory tools, `delegate` and the tools its
settings allow), hosted by `lyricad` like any thread, working in the
background. Her tool guidance gives the rule; `evals/subagent-or-child.eval.ts`
checks it reaches her, and with a real model which she picks. Code:
`extension/src/threads.ts` (the tool) and `daemon/src/children.ts` (hosting).

**The tool**, `threads({ action, ... })`:
- `start({ title, task, folders?, readOnly?, internet? })` creates the child
  (`createThread({ parent, child: true })`) and sends it the task, then
  returns its ID at once, as `[t:<id>]`, which she mentions it by. It gets the parent's model context
  (`models.inheritContext`: pool, local-only, profile, thinking, models) and
  workspace (`inheritSettings`, narrowed by `folders`, `readOnly` and
  `internet: false`); the workspace refuses anything wider, and a folder the
  parent doesn't have is refused. It inherits "Do not log" from the store.
  If the child's first turn can't start, the child is forgotten.
- `message({ id, text })` to one of the thread's children, named by its ID
  or its current title (`pickThread`; a title two children share is
  refused): sent as its next
  turn (or queued behind the running one), marked as from the parent with a
  first line `[From t:<parent>]`. Only `ChildThreads` sends it
  (`HostedThread.send(text, { fromParent })`); `send` refuses any other text
  that starts with it, so a user can't type it, and the UI shows it as hers
  only in a child thread. `message({ to: "parent", text })` from a child posts an update:
  delivered like a background subagent's result (`Delegation.deliver`, a
  `notice` with status `update` naming the child), into the live parent or
  its stored thread, without starting a turn there.
- `list`: the children, with status (working, waiting for approval, idle)
  and last update.
- `compact({ summary })`: compacts the thread she's in with her summary
  (daemon.md, "Compacting herself"). Child threads have it too.

A subagent's thread never gets the tool. In a child thread it only messages the parent, and her prompt says it
is a child thread and to post updates at milestones and when done, not after
every step. **Depth 1:** the store refuses a child of a child; a child can
delegate. The user talks in a child like any thread, and the parent isn't
told. Its approvals work as in any thread.

**Limits:** `start`s per message to the parent (`perRequest`, default 3,
counted before each start so parallel calls can't slip past), and children
working at once per user (`concurrency`, default 2), checked by `start` and
by a parent's message that wakes an idle child; `LyricadOptions.threads`.

**Records and restarts.** `user.db` has `child_threads`: pool, thread,
parent, whether a turn was running, and unseen updates (no text). A turn's
start and end set `working`; a thread closed by shutdown keeps it. When a
user's key first becomes available in a new process, any child still marked
working becomes idle, is never resumed, and its parent gets a note naming it.
Lock stops working children first, and tells their parents the same way; a
parent mid-turn is stopped before the note, so the note is stored. Each
update has its own ID, so two identical updates both show. Opening a
child's messages sees its updates.

**Forgetting** a parent forgets its child threads too when asked (the
default in the UI); otherwise they are kept as threads of their own, detached
from the parent's workspace, with the settings they have; a kept child is no
longer a child (`child` is cleared, its `child_threads` row dropped), so it may
start child threads of its own.

## Not here

- Child threads of child threads, moving a child to another pool.
- External coding CLIs (Claude Code, Codex) as subagents: they would send her
  work outside the router.
- A watchdog or LSP checks: use the reviewer role or a loop.
- Durable runs that keep working across a restart, missions and schedules.
