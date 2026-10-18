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
  internet off if asked, and then Web search off too, so it has neither
  `web_search` nor `web_fetch`. It gets the parent's machines and MCP
  servers only when none of those narrowings apply and it isn't a writer
  in a worktree: bash on a machine, and an MCP server, follow none of
  them. With MCP servers it also gets `tool_search`. The workspace refuses
  anything wider;
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

`folders` narrows granted **host folders**, not paths inside the sandbox such
as `/workspace/repos/<name>`. Omit it when a scout needs to read the parent's
repository checkouts. Read-only roles, narrowed runs (folders, read-only or
no internet) and writers in a worktree share those clones read-only, with no
forge credentials; an unnarrowed writer keeps the parent's repositories and
their credentials. An invalid folder is refused with
this distinction and the omitted-`folders` alternative; it is never turned
into a host grant.

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

A subagent carries the owning project through every delegation depth. Its
`bash` hook reads that project's command rules on every call: Forbid refuses,
Ask always asks, and Allow skips sandbox mode prompts. Always allow on its
command card saves lyricad's computed prefix for the whole project.

An MCP call that its server doesn't mark read-only asks the same way in
every mode, shown in both threads; **Allow in this thread** holds for that
tool in the subagent's thread only.

## Roles

| Role | Tier | Tools | Writes |
|---|---|---|---|
| scout | cheap | read, bash, recall, read_memory | no |
| researcher | cheap | read, bash, recall, read_memory, web_search, web_fetch | no |
| reviewer | cheap | read, bash, recall, read_memory | no |
| worker | strong | read, write, edit, bash, recall, read_memory | yes |
| oracle | strong | read, recall, read_memory | no |

Prompts are adapted from `pi-subagents` 0.76.1 (MIT, credited in
`roles.ts`). A task with no role gets the worker. The parent's prompt lists
the roles and saved workflows, after a line (`SHARED_SANDBOX`) saying that
subagents and child threads have her sandbox's tools and her network or
less, so a brief asks for the result rather than a way to verify it.

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
thread's direct runs. `Models.usage` follows their descendants at every depth
for thread and project token shares, within the requested pool. Subagent
call records carry no turn counts, so these shares use `subagent_runs`
input plus output tokens once, with no GPU time. Cost is not tracked: every model is declared free to Pi.

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
  (`models.inheritContext`: pool, local-only, preset, thinking, models) and
  workspace (`inheritSettings`, narrowed by `folders`, `readOnly` and
  `internet: false`; any of those also leaves it no machines); the workspace refuses anything wider, and a folder the
  parent doesn't have is refused. It inherits "Do not log" from the store.
  If the child's first turn can't start, the child is forgotten.
- `message({ id, text })` to one of the thread's children, named by its ID
  or its current title (`pickThread`; a title two children share is
  refused): it starts a turn there, or, if the child is busy, joins its
  running turn as a Pi steer, taken after the current tool call (daemon.md,
  "Threads"). It is marked as from the parent with a
  first line `[From t:<parent>]`. Only `ChildThreads` sends that mark
  (`HostedThread.send(text, { fromParent })`); `send` refuses any other text
  that starts with it, so a user can't type it, and the UI shows it as hers
  only in a child thread. A sibling's message in a project, and a look,
  reach a busy thread the same way. If the turn is stopped or fails before
  taking the message, it is appended to the thread's stored messages, so it
  is never lost. `message({ to: "parent", text, question? })` from a child
  posts an update:
  delivered like a background subagent's result (`Delegation.deliver`, a
  `notice` with status `update` naming the child), into the live parent or
  its stored thread. Plain progress updates start no turn. `question: true`
  (a question needing an answer), or a project's `needsYou: true`, wakes an
  idle parent. When a child ends idle after messaging its parent, that report
  also wakes it, including when the user started the child's turn. The
  parent runs with `triggerTurn: true`; subagent results keep their existing
  delivery behaviour.

  One pending or running child wake per parent coalesces further notices;
  messages during that wake join its running turn as Pi steers. Wakes wait
  while the project is paused or hidden, and take no child slot: a parent
  waiting for a slot its own children hold would never answer them. A
  parent's reply to a child that woke it starts the child's turn, for up to
  three rounds (`MAX_WAKE_ROUNDS`) until the person writes in either thread;
  past that it is saved without starting the child, which sees it on its
  next turn. Pending wake metadata lives in memory; notices stay encrypted
  in the thread. A message saved while every slot was taken is kept in the
  thread, but after a restart its thread isn't woken for it: it sees the
  message on its next turn.

  `message` returns what happened, and the tool tells her: the thread
  started a turn, took the message into its running turn, waits for a slot
  (the at-once limit is full: the message is saved in the thread and it
  wakes when a slot frees), or was only saved. A child's message to its
  parent says whether it wakes the parent; a plain update tells the child to
  use `question: true` when it needs an answer before going on.
- `list`: the children, with status (working, waiting for approval, idle)
  and last update.
- `read({ id, last? })`: the latest `last` messages (10 by default, at
  most 30) of a thread `list` shows, tool results left out, each cut as
  `read_memory` cuts an entry. Read as from another thread, so entries
  written unlogged are left out, and an unlogged thread is refused. A
  child that isn't a project's thread can't read.
- `stop({ id })`: stops one of the thread's children (in a project chat,
  one of its threads) as Pause does: the running turn is aborted and the
  child is idle. The project's threads can't stop each other.
- `ask({ question, options, recommended, context? })`: one question card for
  the user, in hosted plain chats, project chats and project threads, never
  ordinary children or subagents. Two to four unique options each have a
  label and consequence; one is recommended. `ASK_LIMITS` and `cleanAsk`
  enforce the bounds before anything is stored. Ask only for a fork that
  changes the goal, a visible output or an irreversible step; ask once on
  the card, recommend the first option, keep working where reversible and
  stop where not. The answer arrives as an ordinary user message in a later
  turn. Replacing an open question, Stop (the person's or a parent's) or
  Resolve withdraws it; lock and project pause keep it.
- `compact({ summary })`: compacts the thread she's in with her summary
  (daemon.md, "Compacting herself"). Child threads have it too.

For `ask` and `steps`, unambiguous slips (an array sent as a JSON string,
the recommended option named by label, near-synonyms for a step's state)
are accepted, and any other mistake gets an error saying exactly what to
fix, so a weaker model can correct the call in the same turn (contracts.md).
A reply that ends with a question and 2 to 4 listed options, with no card,
gets one hidden follow-up asking her to put it on a card if the choice
blocks her. `evals/question-card.eval.ts` and `evals/checklist.eval.ts`
show how well a given model uses both, with a fake model by default or a
real one through `LYRICA_EVAL_*` (`LYRICA_EVAL_KIND=local` for a local
server).

The tool also has `later`, `routine` and `steps` (below), and `suggest`,
`resolve` and `reopen` in projects. Each thread is sent only the actions it
can use, with their fields, so a definition resent with every reply carries
nothing it can't call: an ordinary child's tool has no `start`, `list` or
`read`, and an action a thread lacks fails Pi's validation.

A subagent's thread never gets the tool. An ordinary child can message its
parent, set wake-ups, manage routines, keep a checklist and compact itself;
her prompt says it
is a child thread and to post updates at milestones, not after every step,
and always end with a message to the parent: the result, or what blocked it.
**Depth 1:** the store refuses a child of a child; a child can
delegate. The user talks in a child like any thread, and the parent isn't
told. Its approvals work as in any thread.

**Wake-ups** (`daemon/src/wakeups.ts`). `later({ minutes, note })` wakes
the thread she is in, any thread with the tool: the note becomes its next
turn, marked `[Wake-up, set <time>]`, or joins a running turn as a steer.
`later({ cancel: true })` drops its pending ones. Limits
(`WAKEUP_LIMITS`): 1 minute to 7 days ahead, clamped; 3 pending; wake-ups
and routines together fire at most 24 times per thread in a rolling day.
At the cap, pending wake-ups wait and new ones are refused. The note is stored in
the thread's pool (step 4, `wakeups`), so it is encrypted and survives a
restart; due times are held in memory while the user is unlocked, and
lyricad's 20-second tick fires them, not while an update drains. A child
past the at-once limit, a queued thread and a paused or hidden project's
thread wait; a resolved project thread reopens. A locked user's wake-ups
fire at the first tick after unlock, marked with when they were due. The
views get times and IDs only, never the note; the user removes one from
the facts line.

**Routines** (`threads routine`, `daemon/src/routines.ts`).
`threads({ action: "routine", routineAction, ... })` manages only the calling
thread's routines: `add` takes `schedule`, `note` and optional `newThread`
(false by default); `list` returns IDs, schedules in words, active next times,
paused state and whether they open a thread, without notes; `pause`,
`resume` and `remove` take numeric `routineId`. At most 10 per thread,
including paused ones. Routines are for what the user asked to happen
regularly; a one-off later is a wake-up. Schedules are checked by
`parseSchedule`, with plain-word errors: `{ kind: "daily" | "weekdays",
time: "HH:MM" }`, `{ kind: "weekly", day: 0..6, time }` (Sunday is 0),
`{ kind: "yearly", date: "MM-DD", time }`, or `{ kind: "every", hours:
1..168 }`, counted from when it was added. Calendar times use the daemon's
local zone; one skipped by a clock change fires at the next valid minute,
and one that comes twice fires once; a routine set for 29 February runs on
the 28th in other years.

Pool step 6's `routines` keeps each schedule and note encrypted with the
pool. The same 20-second tick as wake-ups starts a due turn marked
`[Routine, <schedule in words>]`, with its note; or, when it opens a new
thread, starts one in the source's project or thread list, inheriting the
source's workspace and model privacy and the project's new-thread choices.
Paused routines don't fire, and resuming one schedules its next run from then, with no catch-up for the paused span; a queued thread and a paused or hidden
project's thread wait; turns share the child at-once budget, and a resolved
project thread reopens. A still-working last run is skipped and `next_at`
moves on. Missed runs fire once, saying how many were due; Lock stops
firing until unlock. Wake-ups and routines share the text-free daily
ledger: at 24 fires per source thread in a rolling day, a routine moves on
and a wake-up waits. Last-run tracking is in memory and is cleared on Lock
or restart. This extends the existing tool, serving principles 1 and 8.

**Checklist** (`threads steps`). Any thread with the tool keeps a
checklist of its own work: `steps({ steps })` replaces the whole list,
each step a few words with its state (`todo`, `doing`, `done`), at most
12 steps (`STEPS_LIMITS`), each cut to 80 characters; an empty list clears
it. Her guidance says to keep one on work of several steps that runs a
while and to leave every step at its real end state. It is stored in the
thread's pool (step 5, `thread_steps`), so it is encrypted; open views get
a `steps` event, the thread's summary carries it, the project chat's card
updates, and a parent's `list` shows where each thread stands ("1 of 3
steps done, now: …"). The person's **Checklists** display switch
(`Display.checklists`, on by default) turns it off: her sessions reopen
without the action's description and guidance, a call is refused, and
summaries carry no steps.

**Told when a child ends.** A child working on a task from its parent (a
`start`, a queued start that began, or a parent's `message`; not a look's
line) owes it a report. When its turn ends and it is idle, the parent gets
a note that wakes the idle parent under the same guards: "stopped with an
error" if the turn
ended with an error, or "finished without a report" if the child sent no
`message to: "parent"` since the task. The parent hears this once: after
a note, the child's next bad end tells nobody until it messages the parent
or the user writes in it, so a child that fails every time can't keep its
parent taking turns. A stopped turn tells nobody, nor does a turn the user
started in the child. Which children owe a report is
held in memory; a restart tells the parent anyway.

**Limits:** `start`s per message to the parent (`perRequest`, default 3,
counted before each start so parallel calls can't slip past), and children
working at once per user (`concurrency`, default 2), checked by `start` and
by a message that would start an idle child's turn (past it the message is
saved and the child wakes when a slot frees); routines share that budget,
parent wakes don't. `LyricadOptions.threads`.

**Records and restarts.** `user.db` has `child_threads`: pool, thread,
parent, whether a turn was running, and unseen updates (no text). A turn's
start and end set `working`; a thread closed by shutdown keeps it. When a
user's key first becomes available in a new process, any child still marked
working becomes idle, is never resumed, and its parent gets a note naming it.
Lock stops working children first, and tells their parents the same way; a
parent mid-turn is stopped before the note, so the note is stored. Each
update has its own ID, so two identical updates both show. Opening a
child's messages sees its updates.

**Projects.** A project chat's child threads are the project's threads
(`daemon/src/projects.ts` and `children.ts`; the rule is in DESIGN.md,
"Projects"):
- `start` there records the thread's **anchor**, the first entry the
  calling turn writes, and past the at-once limit **queues** the thread
  instead of refusing: it starts, oldest first, when a turn ends and a slot
  frees. The queued task is held in memory only; after a restart the project
  chat is told the thread didn't start, and a message starts it.
- A project's thread can **message another thread of the same project**
  (`message({ id, text })`, at most 3 per turn), marked with the sender's
  `[From t:<sender>]` line, and `list` shows it the project's other threads.
  A thread outside the project is refused.
- `ask({ question, options, recommended, context? })` asks the user on a
  question card and marks the thread **waiting on the user**, waking the
  project chat once. It replaces `message({ to: "parent", needsYou: true })`
  for asking the user; that older flag still works. A tap or typed answer
  clears `needs_you` immediately, rather than waiting for her next update.
- **States:** working, waiting (an approval, or `needsYou`), queued, idle,
  resolved. `resolve` (her tool; a thread resolves only itself, the project
  chat any of its threads), the API, and the nightly tick for a thread idle
  7 days resolve it; `reopen`, the API, any message in it, or a sibling's
  message reopen it. `child_threads` keeps `anchor`, `resolved_at`,
  `needs_you` and `queued` (no text).
- `suggest({ threads })` proposes threads on a card and makes none; the
  user starts them from the card, each once.
- `fold({ ids })` proposes bringing existing same-pool work into the
  project; the user applies one or all from the call, once each. Local-only
  work needs a local-only project chat. Existing child threads become
  siblings, keeping their state, checklists and wake-ups.
- `draft({ goal?, instructions? })` keeps editable unsaved project settings
  in encrypted user.db. Only the user saves or discards them; neither
  field is silently applied. Selected recent work is a bounded read for
  one turn, and never widens `threads read` beyond project membership.
- **Paused** (or hidden): working threads stop, nothing new starts, and
  messages to its threads are refused.
- A rewind of the project chat that removes a thread's anchor leaves the
  thread, unanchored.
- **Watching threads** (`daemon/src/watch.ts`; the project setting
  `watchThreads`, on by default). A **look** follows 30 s after any of
  these in a logged thread of the project, batched across threads: a turn
  the user started there ends, the thread posts to the project chat, its
  turn ends with an error, or it starts waiting for a permission answer
  (the last two once a turn). A look is one `watching` call (see
  docs/daemon.md). A local-only thread is left out unless the project chat
  is local-only (or private) too, since the call quotes the user. A look
  waits for a running turn in the chat to end. Nothing is sent while the
  project is paused, hidden, locked or the setting is off. After 3 looks
  of any kind with no message from the user anywhere in the project, the
  user's messages and updates wait for one, so threads can't keep each
  other going; a failure or a wait still brings a look, which tells no
  thread but may raise. A look never tells a thread it was about unless
  that thread asked something.
  Pending looks and the once-a-turn flags live in memory only.

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
- Durable runs that keep working across a restart, and missions.
