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
| **User** | One account with its own login and data: one of Li's, or another person's. Either an administrator or a normal user. Linked users belong to the same person. |
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
saveUserKey(userId) / forgetSavedKey(userId) / hasSavedKey(userId)   // "save credentials"
saveSelfPassphrase(p) / forgetSelfPassphrase() / hasSavedPassphrase()
unlockSaved(): Promise<void>                              // at start: the saved passphrase and keys
hasUserKey(userId: string): boolean
subkey(userId: string, purpose: "pool:general" | "pool:private" | "home"): Buffer  // HKDF-SHA256
lockUser(userId: string): void
```

- Pool databases (Memory) and the encrypted home workspace (Workspace) each
  use their own `subkey`. Never use the raw data key for them.

- Each user has a random 256-bit data key, wrapped by Argon2id of their
  password. Changing the password rewraps the key. The data is never
  re-encrypted for a password change.
- Keys live only in daemon memory, or in systemd credentials when saved:
  sealed with `systemd-creds encrypt --user` (systemd 256 or later), the
  secret on stdin, loaded by the unit with `LoadCredentialEncrypted=`.

## core/users

```ts
class Users {
  createUser(login, password, profile: Omit<Profile, "previousNames">, { admin }): Promise<User>  // first user must be admin
  authenticate(login, password): Promise<User>               // also unlocks the user's key; Argon2 runs for unknown logins too
  changePassword(user, oldPassword, newPassword): Promise<void>  // rewraps the same data key
  setAdmin(actor: User, target: User, admin: boolean): void  // refuses to demote the last admin
  updateProfile(actor: User, target: User, change): Profile  // self, or an admin; a rename appends to previousNames
  listUsers(actor: User): User[]                             // admins see everyone, others themselves
  link(a: User, aPassword, otherLogin, otherPassword): Promise<void>  // the same person's users; both passwords
  unlink(actor: User, other: User): void
  linked(userId): string[]
  stayUnlocked(userId): boolean / setStayUnlocked(userId, on)   // in user.db, default on
  get(id): User | undefined; find(login): User | undefined; all(): User[]
}

interface Profile {
  displayName: string;                       // changeable at any time
  pronouns: { subj: string; obj: string; poss: string; possPro: string; refl: string };
  previousNames: { name: string; until: string }[];   // appended on rename
  accent?: string;                           // the user's colour in the web UI, "#rrggbb"
  monogram?: string;                         // one or two letters
}
```

- **Where things live.** `self.db` holds a `users` index: login, admin flag,
  profile and wrapped key. It also holds global `settings` (such as
  `sleep.time`), the persona's revisions, `user_links`, and the
  `persona_proposals` that users have sent on (`PersonaStore.proposals`,
  `decide`).
  - The wrapped key has to be readable before the user's own databases can
    open.
  - The profile and admin flag must stay readable and editable while the user
    is locked, so the admin panel and `render` keep working.
  - Each user's `user.db` holds that user's settings. Their memory lives in the
    pool databases.
- The theme (device, light or dark) is a display setting in `user.db`.
- **Persona proposals start in the originating user's `user.db`**, encrypted
  with that user's key, where only they can read, edit, drop or send them on:
  `PersonaProposals.propose(view, threadId, …)` (the owner comes from the
  thread view), `drafts`, `edit`, `drop`, `send`. Sending copies the proposal
  to `self.db` with `sent_by`, `edited` and its base revision, and `decide`
  refuses a stale one unless told to overwrite. A proposal from an
  administrator's own conversation is sent at once. There is no other way to
  write a proposal into `self.db`.
- **A browser session holds only linked users.** Logging in as a user not
  linked to the session's users ends the session first. Each user's "stay
  unlocked after logout" choice lives in their `user.db` (default on).
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
| Threads | `createThread({ interface, parent?, subagent?, unlogged?, title? })`, `listThreads({ includeHidden?, parent? })`, `getThread`, `setHidden`, `setUnlogged`, `appendEntry(threadId, { piId, role, data, text })`, `loadEntries`, `entryWindow`, `entryPage`, `setTitle`, `exportThread`, `forgetThread` (also forgets its subagents' threads) |
| Writing memories | `addNotes(notes, { author, thread? })`, `putPage` (sleep and user pages), `putWake`, `addJournal` |
| Any memory, by ID | `get`, `edit`, `restore`, `archive`, `delete`, `deleteMany` |
| Reading for the prompt | `getWake`, `pageIndex`, `forFolders(paths)`, `listJournal`, `userIntroduced` |
| Search | `search(query, { kinds, limit })`, returning `{ id, kind, snippet, score }` |
| Lineage | `cameFrom`, `usedIn`, `revisions`, `isTombstoned(entryId)`, `editedSince(since)` |
| Sleep runs | `startSleepRun`, `updateSleepRun`, `recordSleepRun` (a skip), `listSleepRuns`, `getSleepRun`, `watermark`, `sleepMaterial(since, until)`, `sleepChanges(from, to)` |
| Sleep items | `addItem`, `listItems`, `getItem`, `startItem(id, threadId)`, `dismissItem`, `itemForThread` |

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
never edits or deletes them. On a page a user wrote or edited, the store
refuses a sleep edit that doesn't keep the latest user-written text word for
word: sleep can only add around it.

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
          | "title" | "embedding" | "sleep.consolidate" | "sleep.dream" | "sleep.wake"
          | "image.create" | "image.edit" | "image.upscale";    // the image tasks come with the Images thread

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
- **Planned (Models 2):**
  - Endpoints get a permanent `id` (a UUID), with the name as a label.
  - Each model an endpoint offers gets a permanent `offeringId` (a UUID).
    `ModelRef` becomes `{ offeringId }`, and existing `{ endpointId, modelId }`
    pairs are migrated. An offering the endpoint no longer lists is kept and
    marked `missing`.
  - Editing an endpoint never changes its IDs.
  - **Redirects and tombstones** (`offering_redirects`, from → to or
    `removed`) live where the endpoint lives: `self.db` for shared, `user.db`
    for personal. `resolveModel` follows them.
    - Each user's references (profiles, overrides, saved workflows) are
      rewritten when that user unlocks.
    - A redirect is deleted once no user still refers to it, which is
      tracked per user.
  - Endpoint states: `stale` (unreachable for 14 days) and `gone` (missing for
    30 days). Gone offerings nothing refers to are pruned.
  - `resetIds(endpoint)` and `merge(from, into)` work through redirects.
  - Call records keep the name and endpoint label with the ID.
  - **Model groups:** `{ groupId, name, members: offeringId[] }`, shared in
    `self.db` or personal in `user.db`.
    - `ModelRef` is `{ offeringId } | { groupId }`. A group expands in place,
      in order, filtered by the thread's allowed kinds and by each member's
      fitness for the call (tools, context window).
    - Redirects and tombstones apply to members.
  - A profile entry becomes an ordered list or a pointer to another task's
    list: `Partial<Record<Task, ModelRef[] | { same: Task }>>`, in three
    profiles: `local`, `cloud` and `custom`. `same` must name a task with its
    own list and the same capability, so it is one level deep. A task with
    neither follows `chat`, as now. `resolveModel` returns the first model
    whose endpoint is up, and the thread shows which one answered.
  - Local and cloud lists never mix kinds. Custom may, and is never offered
    to private or local-only threads.
  - Offerings carry capabilities (`tools`, `vision`, `embedding`, `image`,
    `edit`), and pickers filter by the task.
  - Downloads go through a paired host's management API (`host/API.md`):
    list a repository's files, start, progress, cancel, and delete a file
    under `lyrica/`. Shared hosts need an administrator. A gated
    repository's token comes with each request from the hub tokens: a
    user's in `user.db`, or a shared one in `self.db`, encrypted like
    endpoint keys.
  - Deleting an offering leaves a `removed` redirect, like Clean up.
  - An offering for `image.create` or `image.edit` on a host is a **recipe**:
    `{ arch, template, parts: { role, slot?, file }[], loras: { file,
    strength }[], defaults }`, stored on the host. Parts are files the host
    reports by role, slot, architecture, precision and size. A proposed
    recipe is listed but never resolves until it is confirmed. Capabilities
    gain `upscale`. Swapping a part keeps the role, slot and architecture;
    adding a LoRA makes a new recipe linked to its base unless the user
    chooses otherwise.
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

```ts
new Delegation({ users, memory, models, workspace?, cwd, limits? })  // one per lyricad
createDelegateExtension(thread, delegation, budget?)   // adds `delegate` (and `ask_parent` in a subagent)
delegation.events                                      // typed EventEmitter for the live view
delegation.store                                       // roles and saved workflows, in user.db
delegation.forget(userId, pool, threadId)              // before forgetThread: stops its runs
delegation.stopAll(userId?)                            // Lock and shutdown
```

One model-facing tool: `delegate({ action?, ... })`.
- The default action runs work: `task` with an optional `role` and `tier`;
  or `tasks: [...]` (parallel), `chain: [...]`, `loop`, `council`, or
  `workflow: name`. Any of these can be `background: true`. She picks a tier,
  never a model; only saved workflows, which users write, may name one.
- The other actions are `status`, `wait`, `stop`, `steer` and `answer`, each
  on a run ID, and only on runs the calling thread started.
- A subagent also has `ask_parent`, and read-only memory
  (`registerMemoryTools({ readOnly: true })`).

Every run:
- creates a child thread with `createThread({ parent, subagent: true })`;
- calls `workspace.inheritSettings` with any narrowing;
- resolves its model with `models.childContext`, from the parent's current
  `CallContext`, and stops (`parent_changed`) if the parent turns
  local-only, unlogged or forgotten;
- runs in-process in `lyricad`;
- emits `started`, `output`, `tool_call`, `question`, `finished`, `stopped`,
  `interrupted` and `usage`.

`user.db` gains `delegate_roles`, `delegate_workflows` and `subagent_runs`
(no conversation text). Full details: [delegation.md](delegation.md).

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
  - `budgets`;
  - `memoryTools`: `"read"` gives `recall` and `read_memory` without
    `remember` (sleep). The default is `"full"`;
  - `hide(id)`: memories this thread must not see, in recall and
    `read_memory` alike. The wake phase hides the journal and sleep's own
    threads;
  - `sleep`: the `/sleep` command, where the host offers it (the bench).
- Memory sections include `opening`: the sleep item a thread was started
  from. It comes from `itemForThread`, so no other thread ever has it.
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
  - `delegate`, and `ask_parent` in subagents (Delegation thread; see
    [delegate](#delegate));
  - `calendar` and `sort` (Integrations thread);
  - `image`, with `create` and `edit` (Images thread);
  - `web_search` and `web_fetch` (research, carried over from v1 or taken from
    a Pi package);
  - in sleep sessions only: `write_page`, `write_journal`, `write_wake`,
    `raise` and `propose_persona` (Sleep thread; see [sleep.md](sleep.md)).
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
- **Startup:** once unlocked, `lyricad` builds `Workspace` with its own
  listening ports as `excludePorts` and its front door as `frontDoor`, and calls
  `selfTest()` before serving threads. It builds one `Delegation`, adds
  `createDelegateExtension` to each thread's session, forwards
  `delegation.events` to the parent thread's stream, and calls `stopAll` on
  Lock and shutdown. It builds one `Sleep` and calls `stop(userId)` on Lock
  and shutdown, before the key goes.
- **Permission prompts:** the workspace extension's `tool_call` hook calls
  `ThreadTools.approve?(request)`; `lyricad` supplies it and waits for an
  answer from any open view, denying on timeout or Stop.
- **Web access** (`LyricadOptions.web`): built-in Caddy, configured through
  its admin socket `/run/lyrica-caddy/admin.sock`, or an external proxy, with
  an extra listener whose settings and TLS key are in
  `<runtime>/web-external.json` (0600) and which opens before unlock. Settings
  and DNS credentials live in `self.db`. See [daemon.md](daemon.md).
- **Unlocking:** when started as a service, `lyricad` starts locked, and the
  API serves only the unlock endpoint until `self.db` is unlocked.
- **HTTP/SSE API**, defined in `daemon/src/api.ts` and described in
  [daemon.md](daemon.md). The web UI imports its types from there:
  - auth;
  - threads (list, create, hide, forget);
  - messages (send, stream);
  - settings (endpoints, model profiles);
  - users and admin;
  - memory browser;
  - sleep: overview, run detail, items (start a chat, dismiss), `sleep.mode`,
    start a run, and an event stream. `/sleep` typed in a thread is
    `SendRequest.confirm` and `SendResponse.sleep`.
- **Local socket:** a Unix socket (mode `0600`, owned by the service user)
  serves the same API to `lyrica chat` and `lyrica mem`. The user still logs in
  with a password over the socket. Being on the machine isn't enough.
- **Scheduler:** at `sleep.time` (default 04:00), for each user not in manual
  mode, sleep each pool, one run at a time.

## bin/lyrica

One entry point with subcommands: `serve`, `chat`, `admin`, `mem` and `dev`
(see [DESIGN.md](../DESIGN.md#runtime)).
- `dev` refuses to start unless it is pointed at a development runtime: a
  directory with a marker file, created by `lyrica dev --init`.
- No subcommand reads a password from arguments or the environment.

## sleep

```ts
new Sleep({ users, memory, models, persona, proposals, hasKey, cwd, limits? })
sleep.run(userId, pool, reason: "scheduled" | "manual"): Promise<SleepRun>  // queued: one run at a time
// status: "complete" | "partial" | "skipped"
// skipReason: "no-key" | "endpoint-down" | "no-activity"
sleep.check(userId, pool)          // what would stop a run now, without recording anything
sleep.stop(userId)                 // Lock: the run is marked partial
sleep.mode(userId) / setMode(userId, "scheduled" | "manual")   // user.db
sleep.events                       // started, phase, finished: IDs only, never text
```

- Each phase is a thread in the pool's `sleep` interface, opened through
  `openThreadSession` with that pool's `CallContext` and its
  `sleep.<phase>` model, so private sleep is local-only.
- The pool's `sleep_runs` and `sleep_items` tables hold runs and items. A
  `no-key` skip is recorded once the key is back, since the pool can't be
  written without it.
- Full details: [sleep.md](sleep.md).

## core/workspace

```ts
new Workspace(keyring, users, { excludePorts, frontDoor? })
// excludePorts: lyricad's own ports, refused on every address; required, [] for none
// frontDoor(): FrontDoor { ports, hosts, exclude }, read at each sandbox start:
//   the proxy's ports, refused on this machine's addresses, on every address
//   `hosts` has ever resolved to, and on the proxy's addresses
resolveAddresses(hosts): Promise<string[] | undefined>   // undefined: never resolved, so no network
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
saveUpload(t, name, bytes): Promise<string>  // cleans the name (cleanUploadName), never overwrites
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
  - This machine's own addresses (LAN, Tailscale; read when each sandbox
    starts) count as this machine: reachable only with the services switch,
    never through internet or an allowed host.
  - The front door (`frontDoor()`) is refused wherever it answers. If Lyrica's
    name has never resolved, that sandbox run gets no network at all.
  - Allowed hostnames are written to the sandbox's `/etc/hosts`. With
    internet off there is no DNS resolver inside the sandbox.
  - `inheritSettings` may only shrink the list.
  - If `selfTest()` finds that a sandbox could undo its firewall, or can't
    start one, every thread runs with network off and the reason is kept in
    `networkRefused` for the UI.
- **Allowed paths** live in `self.db` (`workspace_paths`, keyed by user ID)
  and change only with an administrator actor. Paths overlapping
  `NEVER_GRANTED` (`/run/lyrica-caddy`) are refused, because sandboxes run with
  `lyricad`'s groups.
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
