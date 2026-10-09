# Contracts

**Status: proposed.** These are the interfaces between components. Feature
threads build against them. If a thread needs a contract to change, it says so
in its pull request, and the design thread updates this page. Signatures are
sketches; names may move, but the boundaries may not.

## Stack and layout

- TypeScript (ESM) on Node 22 LTS, using npm workspaces.
- Pi pinned exactly: `@earendil-works/pi-coding-agent@1.1.0`.
- SQLCipher through `better-sqlite3-multiple-ciphers`. Argon2id through
  `@node-rs/argon2`.
- Tests with `vitest`. Type checks with `tsc --noEmit`.
- The web UI is React with TypeScript, built with Vite.

```text
core/        keyring, users, stores, model router (no Pi dependency)
extension/   the Lyrica Pi extension (depends on core)
daemon/      lyricad: auth, session hosting, HTTP/SSE API, scheduler
web/         web chat, control panel, memory browser, sleep sidebar
persona/     seed, imported into self.db on first run
bin/         launchers and admin commands
```

## Vocabulary

| Term | Meaning |
|---|---|
| **User** | One of Li's personas, with its own login. Either an administrator or a normal user. |
| **Pool** | `general` or `private`. Each user has one of each. |
| **Interface** | Where a thread lives: `web`, `cli`, `matrix`, `forum` or `sleep`. |
| **Thread** | One conversation. It belongs to one user, one pool and one interface. |
| **Entry** | One stored Pi session entry in a thread. |
| **Note, page, WAKE, journal** | Memory layers (see [memory.md](memory.md)). |

IDs and citations:
- An entry is `e:<thread>#<n>`, a whole thread is `t:<thread>`, a note is
  `n:<ulid>`, and a page is `p:<slug>`.
- A citation into the other pool carries its pool: `[general/n:…]`. Only
  private memory may cite general memory, never the reverse.

## core/keyring

```ts
unlockSelf(passphrase: string): Promise<void>            // self.db only
unlockUser(userId: string, password: string): Promise<void>
saveUserKey(userId: string): Promise<void>                // "save credentials"
forgetSavedKey(userId: string): Promise<void>
hasUserKey(userId: string): boolean
subkey(userId: string, purpose: "pool:general" | "pool:private" | "home"): Buffer  // HKDF-SHA256
lockUser(userId: string): void
```

- Pool databases (Memory) and the encrypted home workspace (Workspace) each
  use their own `subkey`. Never use the raw data key for them.

- Each user has a random 256-bit data key, wrapped by Argon2id of their
  password. Changing the password rewraps the key. The data is never
  re-encrypted for a password change.
- Keys live only in daemon memory, or in systemd credentials when saved.

## core/users

```ts
class Users {
  createUser(login, password, profile: Omit<Profile, "previousNames">, { admin }): Promise<User>  // first user must be admin
  authenticate(login, password): Promise<User>               // also unlocks the user's key
  changePassword(user, oldPassword, newPassword): Promise<void>  // rewraps the same data key
  setAdmin(actor: User, target: User, admin: boolean): void  // refuses to demote the last admin
  updateProfile(actor: User, target: User, change): Profile  // self, or an admin; a rename appends to previousNames
  listUsers(actor: User): User[]                             // admins see everyone, others themselves
  get(id): User | undefined; find(login): User | undefined; all(): User[]
}

interface Profile {
  displayName: string;                       // changeable at any time
  pronouns: { subj: string; obj: string; poss: string; possPro: string; refl: string };
  previousNames: { name: string; until: string }[];   // appended on rename
  accent?: string;                           // persona colour in the web UI, "#rrggbb"
  monogram?: string;                         // one or two letters
}
```

- **Where things live.** `self.db` holds a `users` index: login, admin flag,
  profile and wrapped key.
  - The wrapped key has to be readable before the user's own databases can
    open.
  - The profile and admin flag must stay readable and editable while the user
    is locked, so the admin panel and `render` keep working.
  - Each user's `user.db` holds that user's settings. Their memory lives in the
    pool databases.
- The theme (device, light or dark) is a display setting in `user.db`.
- The **login name** is separate from the display name, so renaming never
  affects signing in.
- Pronoun presets are she/her, he/him and they/them, plus a custom option that
  fills in all five forms.
- `subj` is used only in live prompts (for example, "Li's pronouns are
  they/them"). It is never substituted into stored memory.

## core/mentions

```ts
toStored(text: string, speaker: UserId): string              // {user}, {user:obj}… → [[u:ID]], [[u:ID:obj]]…
render(text: string, profiles: (id) => Profile | undefined): string   // tokens → current names and pronouns
queryTokens(query: string, profiles: Map<UserId, Profile>): …  // see below
```

- Every write of a note or page goes through `toStored`, and every read path
  goes through `render`. See [memory.md](memory.md#names-and-pronouns).
- **Search must keep the literal words.** A user's name in a query (current or
  previous) adds that user's token as an *alternative*. It never replaces the
  word.
  - Example: "Li-ion battery" must still match notes that say "Li-ion".
  - `queryTokens` returns the name matches found in the query, as names and
    user IDs. The Memory thread builds the full-text query from them, as
    word OR token.

## core/store: the privacy boundary lives here

```ts
class Memory {                                // new Memory(keyring, users)
  openThreadView(userId, pool): PoolView      // conversations, tools and sleep
  openOwnerView(userId): OwnerView            // memory browser and lyrica mem only
}
interface PoolView { pool; own: PoolStore; reads: PoolReader[]; close() }
// general: own = general.db, reads = []
// private: own = private.db, reads = [general.db through a read-only connection]
searchView(view, query, opts) / resolve(view, id) / readView(view, id)   // across a view's pools
```

`openThreadView` is the **only** place that hands out store handles for
conversation work. Context assembly, tools and sleep receive a `PoolView` and
nothing else. No code path gives a general view a private handle.
`createLyricaExtension` refuses any view that `openThreadView` didn't make.

`PoolReader` (read-only) and `PoolStore` (adds writes) methods, by area:

| Area | Methods |
|---|---|
| Threads | `createThread({ interface, parent?, subagent?, unlogged?, title? })`, `listThreads({ includeHidden?, parent? })`, `getThread`, `setHidden`, `setUnlogged`, `appendEntry(threadId, { piId, role, data, text })`, `loadEntries`, `entryWindow`, `exportThread`, `forgetThread` |
| Writing memories | `addNotes(notes, { author, thread? })`, `putPage` (sleep and user pages), `putWake`, `addJournal` |
| Any memory, by ID | `get`, `edit`, `restore`, `archive`, `delete`, `deleteMany` |
| Reading for the prompt | `getWake`, `pageIndex`, `forFolders(paths)`, `listJournal`, `userIntroduced` |
| Search | `search(query, { kinds, limit })`, returning `{ id, kind, snippet, score }` |
| Lineage | `cameFrom`, `usedIn`, `revisions`, `isTombstoned(entryId)`, `editedSince(since)` |
| Sleep (Sleep thread) | `watermark`, `recordSleepRun`, `listSleepRuns` |

IDs:
- `e:<thread>#<n>` for an entry, `t:<thread>` for a thread;
- `n:<ulid>` for a note, `p:<slug>` for a page;
- `j:<date>-<hex>` for a journal entry, `wake` for WAKE;
- from a private view, general memories carry `general/`.

The extension extracts each entry's searchable `text`, which keeps core free
of Pi. Calls to the memory tools, their results, and the per-turn message
aren't indexed, so recall doesn't echo itself.

Authors are `lyrica`, `sleep` or `user:<id>`.

**Editing.** Every `edit` stores a revision. `restore(id, revisionId, author)`
brings back an earlier version as a new revision. Each edit:
- keeps or creates mention tokens: the input is stored form, or `{user}`
  placeholders;
- re-derives citations;
- updates the search index in the same transaction.

Sleep reads `editedSince(watermark)` so it can treat user edits as
authoritative.

**User-introduced memories.** Through the owner view, `notes.add` and
`pages.add` accept `author: user:<id>` and text with any inline links (`t:`,
`e:`, `n:`, `p:`) or none. Each memory records its origin (`lyrica`, `sleep`
or `user`), and the browser filters on it. Sleep may cite user memories but
never edits or deletes them.

**Owner view.** `openOwnerView(userId)` gives the signed-in user read and write
access to both of their own pools, for the memory browser and `lyrica mem`.
It is never passed to the extension, a Pi session or sleep.

**Pages can describe folders.** A page has an optional `folders` list of host
paths or SSH locations. Sleep sets it. `forFolders(paths)` returns the pages
whose folders contain or equal any of the given paths, which is how opening a
folder brings back what she knows about it.

**Unlogged threads** (see [memory.md](memory.md#threads-that-arent-logged))
are enforced in the store:
- `create` with an unlogged `parent` always makes an unlogged child, and
  `setUnlogged(false)` is refused on a thread whose parent is unlogged.
- Entries record whether they were written while unlogged. Search, sleep and
  catch-up never see those entries.
- Notes can't be written from an unlogged thread.

## core/models: the cloud boundary lives here

```ts
type Task = "chat" | "subagent.cheap" | "subagent.strong" | "compaction"
          | "title" | "embedding" | "sleep.consolidate" | "sleep.dream" | "sleep.wake";

interface Endpoint {
  id: string;                              // "<name>" for a user's own, "shared.<name>" for a shared one
  name: string;
  kind: "cloud" | "local";                 // declared by the user, never inferred
  api: "openai-compatible";                // OpenRouter, LM Studio, KoboldCpp, llama-server
  baseUrl: string; apiKey?: string;
  shared: boolean;
}
interface ModelRef { endpointId: string; modelId: string }   // same model on two endpoints = two refs

interface CallContext {
  userId: string;
  pool: Pool;
  localOnly: boolean;       // thread checkbox; always true for private
  overrides?: Partial<Record<Task, ModelRef>>;
}

class Models {                                              // new Models(keyring, users)
  addEndpoint(actor, input, { shared? }) / removeEndpoint(actor, id)   // shared: administrators only
  endpoints(userId) / models(userId, endpointId) / addModel(actor, endpointId, m) / discover(actor, endpointId)
  probe(userId, endpointId): Promise<{ state: "up" | "down"; warning?: string }>
  profile(userId, "cloud" | "local") / setProfile(userId, name, task, ref?)
  setThreadModel(userId, pool, threadId, task, ref?) / setLocalOnly(userId, pool, threadId, on)
  callContext(userId, pool, threadId): CallContext
  childContext(parent, childThreadId, { tier } | { model }): CallContext   // a child under its parent's rules
  resolveModel(task, ctx): ModelRef                         // throws CloudModelForbidden
  allowed(ctx): { endpoint, models }[]
}

// extension/, because core has no Pi dependency:
modelRuntimeFor(models, ctx): Promise<ModelRuntime>       // Pi runtime with only the allowed models
openThreadSession({ thread, models, cwd, extensions, settings? })  // one thread's Pi session, in process
```

- When `ctx.pool === "private"` or `ctx.localOnly` is set, Pi sessions are
  built with `modelRuntimeFor(models, ctx)`, which contains **no cloud models at all**.
  Even Pi's own compaction then has nothing cloud-based to pick.
- Asking for a cloud model throws `CloudModelForbidden`. Nothing falls back
  across the local/cloud line.
- A task with no model set uses the same profile's chat model (except
  `embedding`), never the other profile's.
- A local endpoint is still declared, not inferred. `probe` warns, without
  blocking, when one resolves outside loopback, private or tailnet ranges.
- **Shared endpoints** live in `self.db`. Only an administrator can change
  them, and their API keys are encrypted with the rest of `self.db`. Every
  user can use them in their profiles. A user's own endpoints live in their
  `user.db`.
- **What each user stores** in `user.db`:
  - endpoints;
  - a cloud profile and a local profile, mapping each task to a model;
  - per-thread model overrides and the local-only flag.

  Workspace's thread settings live in `user.db` too, in separate tables.

## delegate

One model-facing tool: `delegate({ action?, ... })`.
- The default action runs work: `task` with an optional `role` and `tier`;
  or `tasks: [...]` (parallel), `chain: [...]`, `loop`, `council`, or
  `workflow: name`. Any of these can be `background: true`.
- The other actions are `status`, `wait`, `stop`, `steer` and `answer`, each
  on a run ID.

Every run:
- creates a child thread with `createThread({ parent, interface })`, recorded
  as a subagent;
- calls `workspace.inheritSettings` with any narrowing;
- resolves its model through the router with the child's `CallContext`;
- runs in-process in `lyricad`;
- emits events (started, output, question, finished, stopped, interrupted)
  for the web UI's live view.

Full feature list: [delegation.md](delegation.md).

## extension

The extension is created with a `ThreadContext`:
`{ user, pool, interface, threadId, view: PoolView, call: CallContext }`.

- The factory is `createLyricaExtension(thread: ThreadContext, opts:
  LyricaOptions)`. The options are:
  - `persona()` and `profile()`, read every turn;
  - `folders()`: the thread's granted folders, also read every turn. It
    defaults to none. Workspace supplies it, and Memory uses it to load
    `forFolders` pages. This is the only link between the two components, so
    neither imports the other;
  - `debugPrompt`;
  - `budgets`.
- **`before_agent_start`** never replaces the whole system prompt. It does two
  things:
  - It edits `event.systemPromptOptions`. The persona core goes in
    `customPrompt`. Topics, WAKE, the page index, and "who you're talking
    with" go in `sections`. Pi appends only what changed, so the prompt
    prefix stays cacheable (DeepSeek's prefix cache, a local model's KV cache).
  - In Pi 1.1.0, setting `customPrompt` also drops Pi's default tool list and
    rules. The extension therefore rebuilds them from each tool's own snippets
    and guidelines (`toolGuidance`) into a `tools` section. Any tool
    registered with a snippet and guidelines appears there automatically.
  - It returns content that changes every turn, namely recall hits and the
    time, as the result's `message`. That way it sits in the transcript, not
    in the prefix.
  - Each section has a size budget.
- **Tools** (budget: 30; see principle 8):
  - `read`, `write`, `edit` and `bash` (Workspace thread; see
    [workspace.md](workspace.md));
  - `remember`, `recall` and `read_memory` (Memory thread);
  - `delegate` (Delegation thread; see [delegate](#delegate));
  - `calendar` and `sort` (Integrations thread);
  - `web_search` and `web_fetch` (research, carried over from v1 or taken from
    a Pi package).
- **Commands:** `/sleep`, and others only within the budget.
- Lyrica's sessions **never** load project context files (`AGENTS.md`,
  `CLAUDE.md`). Her self-primer is a routed topic.

## daemon

- **Session hosting:** each thread through `openThreadSession`. It uses
  `SessionManager.inMemory` with the thread's stored entries, the router's
  `modelRuntimeFor`, and a resource loader with discovery of context files,
  skills and extensions turned off, so only the extensions passed in load.
  - Pi's built-in tools are disabled with `noTools: "builtin"`. Lyrica
    registers her own `read`, `write`, `edit` and `bash`, built with Pi's
    `create*Tool(cwd, { operations })` and routed to the thread's execution
    target ([workspace.md](workspace.md)). Never use `noTools: "all"`, which
    also removes extension tools.
  - Sessions run in-process, with no `pi` subprocesses.
  - Entries are recorded with `appendEntry` as each turn ends (`recordEntries`).
- **Startup:** `lyricad` builds `Workspace` with its own listening ports as
  `excludePorts`, and calls `selfTest()` before serving threads.
- **Unlocking:** when started as a service, `lyricad` starts locked, and the
  API serves only the unlock endpoint until `self.db` is unlocked.
- **HTTP/SSE API**, detailed by the Daemon thread in `daemon/src/api.ts`.
  The web UI imports its types from there:
  - auth;
  - threads (list, create, hide, forget);
  - messages (send, stream);
  - settings (endpoints, model profiles);
  - users and admin;
  - memory browser;
  - sleep runs.
- **Local socket:** a Unix socket (mode `0600`, owned by the service user)
  serves the same API to `lyrica chat` and `lyrica mem`. The user still logs in
  with a password over the socket. Being on the machine isn't enough.
- **Scheduler:** at `sleep.time`, for each user with a key available and each
  pool with activity past its watermark, run sleep.

## bin/lyrica

One entry point with subcommands: `serve`, `chat`, `admin`, `mem` and `dev`
(see [DESIGN.md](../DESIGN.md#runtime)).
- `dev` refuses to start unless it is pointed at a development runtime: a
  directory with a marker file, created by `lyrica dev --init`.
- No subcommand reads a password from arguments or the environment.

## sleep

```ts
runSleep(userId: string, pool: Pool, reason: "scheduled" | "manual"): SleepRun
// status: "complete" | "partial" | "skipped"
// skipReason: "no-key" | "endpoint-down" | "no-activity"
```

## core/workspace

```ts
new Workspace(keyring, users, { excludePorts })  // excludePorts: lyricad's own ports; required, [] for none
interface WorkspaceThread { userId; pool; threadId }
interface Network { internet: boolean; services: boolean; hosts: string[] }
interface ExecutionTarget {               // name: "sandbox" | "ssh:<name>"
  cwd(): Promise<string>;
  ops(): { read; write; edit; bash };     // Pi's tool operations
  folders(): string[];                    // host folders, or "<ssh name>:<root>"
}
forThread(t)  // { target(), settings(), network(), folders() }, each read fresh
targetFor(t): ExecutionTarget
grantsFor(t): Grant[]                     // { path, writable }
folders(t): string[]
network(t): Network
inheritSettings(parent, childThreadId, narrower?)  // subagents: same or stricter, never wider
settings(userId): WorkspaceSettings       // per-pool defaults, per-thread overrides, SSH targets
allowedPaths.allow(actor, userId, pool, path) / disallow(...) / list(userId)
saveUpload(t, name, bytes): Promise<string>
mountHome(userId) / unmountHome(userId)   // gocryptfs; mount when the user's key becomes available
selfTest(): Promise<string | undefined>   // lyricad calls this at startup
```

- Every sandbox run receives exactly the thread's grants, the thread's folder
  in the home workspace, and a read-only system.
- **Workspace settings live in the user's `user.db`:** each thread's grants,
  network switches, permission mode and target, and the SSH targets. Allowed
  paths are the exception (below). Workspace never adds tables to the pool
  databases, which belong to Memory.
- **Network:** every thread has two switches (internet, and this machine's
  services) and an **allowed hosts** list. Each has per-user, per-pool
  defaults and a per-thread override.
  - Nothing on, list empty: `--unshare-net`.
  - Otherwise `pasta` wraps the sandbox in its own network namespace, with
    default-deny output rules set inside it before the command runs. They
    allow the internet if that switch is on, the host's loopback if the
    machine's-services switch is on, and each allowed host (IP, CIDR, or a
    hostname resolved at start, each with an optional port).
  - Never the host's network namespace. `excludePorts` are rejected on every
    address, and so are the host's Unix sockets.
  - Allowed hostnames are written to the sandbox's `/etc/hosts`. With
    internet off there is no DNS resolver inside the sandbox.
  - `inheritSettings` may only shrink the list.
  - If `selfTest()` finds that a sandbox could undo its firewall, or can't
    start one, every thread runs with network off and the reason is kept in
    `networkRefused` for the UI.
- **Allowed paths** live in `self.db` (`workspace_paths`, keyed by user ID)
  and change only with an administrator actor.
- See [workspace.md](workspace.md).

## integrations

```ts
interface CalendarProvider {          // google, icloud, caldav
  listEvents(range): Event[]; createEvent(e): Event; updateEvent(e): Event; deleteEvent(id): void;
}
interface SourceProvider {            // files, notes, downloads, email (IMAP)
  list(query): Item[]; read(id): Content; move(id, dest): void; tag(id, tags): void;
}
```

Credentials are stored in the user's `user.db`. Providers are reached only
through the `calendar` and `sort` tools.

## UI rules that cross components

- The current model and endpoint, with a cloud or local badge, are always
  visible in a thread.
- **Show general**, **Show private** and **Show hidden threads** are per-user
  display filters.
- The sidebar has a Sleep section.
