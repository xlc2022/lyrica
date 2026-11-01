# extension

The Lyrica Pi extension. `createLyricaExtension(thread, options)` returns a Pi
`ExtensionFactory` for one thread.

- **`before_agent_start`** routes topics for the user's message and assembles
  her context. It never replaces the whole system prompt. Instead it does
  three things:
  - It edits Pi's `systemPromptOptions`. The persona core becomes
    `customPrompt`, which also drops Pi's coding preamble. Topics, WAKE, the
    page index and "who you're talking with" become `sections`.
  - Pi's default tool list and rules are dropped along with the preamble, so
    `toolGuidance` rebuilds them into a `tools` section from each tool's own
    snippet and guidelines. Her own prompt (never a subagent's) also gets
    operational continuation rules:
    act before the final reply, which ends the turn; after failed delegation
    use direct tools if available; name a successfully started or queued
    background mechanism and distinguish queued from running. Otherwise
    report the stopping point and idle. Routines require a user request for
    recurring work. This is guidance, not an autonomous continuation loop.
    Her prompt and every subagent's also get `WORK_GUIDELINES`: independent
    tool calls go together in one reply, and a file already read isn't read
    again unless it changed, since every reply resends the whole context.
  - It returns content that changes every turn (recall and the time) as a
    hidden `lyrica-turn` message.

  Because only the turn message changes, the system prompt stays
  byte-identical from turn to turn when nothing in it changed. Pi then sends
  only the deltas, so the prompt prefix stays cacheable.
- **`routing.ts`**: a topic scores trigger overlap (whole words, simple
  plurals) plus its priority. Up to 3 topics load per turn. A triggered topic
  persists for 3 more turns with a decaying score; only a new trigger resets
  its count, so it always expires.
- **`assemble.ts`** builds these pieces:
  - stable: the persona core, topic addenda, WAKE, the page about the user
    (`p:about-user`), the page index, and who
    she's talking with (display name, pronouns, previous names with dates);
  - per turn: recall, and the time, with the time since you last talked.

  Each has a character budget (`DEFAULT_BUDGETS`) and is cut at a line break
  when it's over.
- **`memory.ts`** reads the thread's `PoolView`: an unlogged notice, WAKE, the
  about-user page (private first, then general), the page index and pages about the thread's `folders()` go in the system
  prompt; recall hits for the message, found by its words and, through the
  thread's `embed`, by its meaning (labelled "added by Sam" for a user's
  own memories), and the time since the user last spoke go in the turn
  message.
- **`tools.ts`** registers `remember`, `recall` and `read_memory`, each with a
  snippet and guidelines; `recall` embeds its query the same way and falls
  back to keywords alone. In an unlogged thread `remember` is taken out of the
  active tools (through `gate.ts`, which several reasons share to turn tools
  off). Subagents and sleep get only `recall` and `read_memory` from here
  (sleep registers its own `remember` and writing tools).
- **`record.ts`** stores Pi's entries in the thread (`recordEntries`).
- **`context.ts`**, **`react.ts`**, **`threads.ts`**: how full her context
  is and her model's pace, with the lines that tell her to compact, the user's reactions told to her in the turn message, and
  the `threads` tool (child threads and project actions, wake-ups, routines,
  checklists, and compacting with her own summary).
- **`sleep.ts`** (`Sleep`) runs consolidate, dream and wake as Pi sessions
  with the memory and persona tools. See [docs/sleep.md](../docs/sleep.md).
- **`primer.ts`** is her self-primer, routed like a persona topic.
- The factory throws unless `thread.view` came from `openThreadView` for the
  thread's pool.
- With `debugPrompt: true`, each turn shows the routed topics, section sizes,
  and the full system prompt plus the turn message (a TUI notification, or stderr in
  print mode).

- **`workspace.ts`**: `createWorkspaceExtension(tools)` registers `read`,
  `write`, `edit` and `bash` (and `proxmox`, `add_repository` and
  `propose_plan` where the thread has them), routed to the thread's
  execution target (see
  [docs/workspace.md](../docs/workspace.md)). It enforces the thread's
  permission mode in `tool_call`, sends `!` commands to the same target, and
  adds a short `workspace` prompt section. `LyricaOptions.folders()` carries
  the thread's folders to Memory.
- **`images.ts`**: `createImageExtension` adds the one `image` tool (create,
  edit, upscale), checks portrait consent before each routed attempt, saves
  results through `Workspace.imageFiles` and returns Pi image content. Its
  parameters are one object with `action`, never a top-level union, which
  LM Studio refuses and small models can't read; a failed call names the
  model or recipe it reached. The
  workspace's Images switch and Plan mode gate it. See
  [docs/workspace.md](../docs/workspace.md#images-and-portrait-photos).
  Exact layouts and diagrams use HTML/SVG and the sandbox's offline Chromium
  command from that doc. Its image description and guidance stay short:
  principle 8 charges every context token on every turn.
- **`models.ts`**: `modelRuntimeFor(models, call)` builds the Pi
  `ModelRuntime` for a thread from the router, and `piModelFor` resolves a
  task to a Pi model. See [docs/models.md](../docs/models.md). Local
  servers' and model hosts' streams go through `inline-thinking.ts` and
  `tool-stream.ts`, which sends every tool's parameters as an object and
  stops a reply with more than 32 tool calls.
- **`session.ts`**: `openThreadSession` hosts one thread in process: its
  stored entries, the given extensions, Pi's built-in tools off, the router's
  runtime and chat model, and entries recorded as turns end.
- **`delegate/`**: `new Delegation({ users, memory, models, workspace, cwd })`,
  one per process, runs subagents and emits their events.
  `createDelegateExtension(thread, delegation)` registers `delegate` for a
  thread. See [docs/delegation.md](../docs/delegation.md).

The one command is `/sleep`, registered when the host passes `sleep` (the
bench does).

## Running it: `bin/lyrica`

In a checkout it's `bin/lyrica`. On a machine set up with install.sh it's
`lyrica`, which runs as the `lyrica` user with her state folder.

```sh
bin/lyrica admin setup-code            # first run: the setup page's code, addresses and fingerprint
bin/lyrica admin init                  # self.db passphrase, first administrator
bin/lyrica admin user add <login> [--admin]
bin/lyrica admin user list | set-admin <login> on|off | passwd <login> | profile <login>
bin/lyrica dev --init <dir>            # development runtime with test administrator "tester"
bin/lyrica dev --runtime <dir> --user <login> [--private | --local-only] [--debug-prompt]
bin/lyrica admin grants add|remove --user <login> --pool general|private <path>
bin/lyrica admin grants list --user <login>
bin/lyrica admin ssh add --user <login> <name> <account>@<host>[:<port>] [--root <path>] [--pool general|private] [--limit ask|acceptEdits|auto]
bin/lyrica admin ssh list|remove --user <login> [<name>]    # every machine, Proxmox ones too
bin/lyrica admin proxmox add --user <login> <name> https://<host>[:<port>] [--pool general|private] [--limit ask|acceptEdits|auto]
bin/lyrica admin net show --user <login>
bin/lyrica admin net set --user <login> --pool general|private internet|services on|off
bin/lyrica admin net hosts add|remove --user <login> --pool general|private <host>
bin/lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
bin/lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
bin/lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
bin/lyrica admin models profile show|set|default … --user <login>
bin/lyrica serve [--port <port>]       # lyricad (default 7340)
bin/lyrica version [--json]
bin/lyrica smoke-test <empty dir> [--port <port>]
```

- Admin commands use `--runtime <dir>`, else `LYRICA_HOME`, else `./runtime`.
- Passwords and passphrases are read only at a hidden terminal prompt.
- `dev` is a developer bench. It refuses any directory without the
  `LYRICA_DEVELOPMENT_RUNTIME` marker that `dev --init` writes.
  - Each run is a new thread in the development runtime (`bin/bench.ts`),
    general by default, private with `--private`, or local-only with
    `--local-only`. Its entries are recorded there, so `remember` and
    `recall` carry over between bench sessions.
  - It runs Pi's TUI on a session from `openThreadSession`: the router's
    model runtime (never Pi's own model config, `auth.json` or environment
    keys), no Pi session files, context files, skills, prompt templates, MCP
    or other extensions. It prints the model and endpoint chosen for each
    task at startup.
  - It loads Lyrica's routed tools and `delegate`, mounts the user's home
    workspace and grants every folder the user may grant in that pool,
    read-write.
- `chat` and `mem` print that they aren't built yet.
