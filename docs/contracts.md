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
- An entry is `e:<thread>#<n>`, a note is `n:<ulid>`, and a page is
  `p:<slug>`.
- A citation into the other pool carries its pool: `[general/n:…]`. Only
  private memory may cite general memory, never the reverse.

## core/keyring

```ts
unlockSelf(passphrase: string): Promise<void>            // self.db only
unlockUser(userId: string, password: string): Promise<void>
saveUserKey(userId: string): Promise<void>                // "save credentials"
forgetSavedKey(userId: string): Promise<void>
hasUserKey(userId: string): boolean
lockUser(userId: string): void
```

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
openThreadView(userId: string, pool: Pool): PoolView
// general: { own: general (read/write), reads: [] }
// private: { own: private (read/write), reads: [general (read-only)] }
```

`openThreadView` is the **only** place that hands out store handles for
conversation work. Context assembly, tools and sleep receive a `PoolView` and
nothing else. No code path gives a general view a private handle.

`PoolStore` methods, grouped by area:

| Area | Methods |
|---|---|
| Threads | `create({ parent?, unlogged? })`, `list({ includeHidden })`, `get`, `setHidden`, `setUnlogged`, `appendEntry`, `loadEntries`, `forget` |
| Notes | `add`, `get`, `update(author)`, `archive`, `delete` |
| Pages | `index()` (titles and summaries), `get`, `put(author)` (sleep only), `delete` |
| WAKE and journal | `getWake`, `putWake`, `addJournal`, `listJournal` |
| Search | `search(query, { kinds, limit })`, returning `{ id, kind, snippet, score }` |
| Lineage | `cameFrom(id)`, `usedIn(id)`, `revisions(id)`, `isTombstoned(entryId)` |
| Sleep | `watermark()`, `recordSleepRun(run)`, `listSleepRuns()` |

Authors are `lyrica`, `sleep` or `user:<id>`.

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

interface CallContext {
  userId: string;
  pool: Pool;
  localOnly: boolean;       // thread checkbox; always true for private
  overrides?: Partial<Record<Task, string>>;
}

resolveModel(task: Task, ctx: CallContext): Model         // throws CloudModelForbidden
modelRuntimeFor(ctx: CallContext): ModelRuntime           // Pi runtime with only the allowed models
probe(endpointId: string): Promise<"up" | "down">
```

- Every endpoint is declared `cloud` or `local`. Its API type never decides
  this.
- When `ctx.pool === "private"` or `ctx.localOnly` is set, Pi sessions are
  built with `modelRuntimeFor(ctx)`, which contains **no cloud models at all**.
  Even Pi's own compaction then has nothing cloud-based to pick. Asking for a
  cloud model throws `CloudModelForbidden`. Nothing falls back across the
  local/cloud line.
- Each user has settings for their endpoints, task-to-model defaults in a
  cloud profile and a local profile, and the list of models allowed for
  automatic delegation.

## extension

The extension is created with a `ThreadContext`:
`{ user, pool, interface, threadId, view: PoolView, call: CallContext }`.

- The factory is `createLyricaExtension(thread: ThreadContext, opts:
  LyricaOptions)`. The options are:
  - `persona()` and `profile()`, read every turn;
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
  - `delegate` (Models thread);
  - `calendar` and `sort` (Integrations thread);
  - `web_search` and `web_fetch` (research, carried over from v1 or taken from
    a Pi package).
- **Commands:** `/sleep`, and others only within the budget.
- Lyrica's sessions **never** load project context files (`AGENTS.md`,
  `CLAUDE.md`). Her self-primer is a routed topic.

## daemon

- **Session hosting:** `createAgentSession` with
  `SessionManager.inMemory(cwd, opts, view.own.loadEntries(threadId))`, the
  router's `modelRuntimeFor`, and a `DefaultResourceLoader` that has the inline
  Lyrica extension and context-file discovery turned off.
  - Pi's built-in tools are disabled with `noTools: "builtin"`. Lyrica
    registers her own `read`, `write`, `edit` and `bash`, built with Pi's
    `create*Tool(cwd, { operations })` and routed to the thread's execution
    target ([workspace.md](workspace.md)). Never use `noTools: "all"`, which
    also removes extension tools.
  - Sessions run in-process, with no `pi` subprocesses.
  - Each `message_end` calls `appendEntry`.
- **Unlocking:** when started as a service, `lyricad` starts locked, and the
  API serves only the unlock endpoint until `self.db` is unlocked.
- **HTTP/SSE API** (detailed by the Web thread):
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
interface ExecutionTarget {               // "sandbox" | "ssh:<name>"
  ops(): { read: ReadOperations; write: WriteOperations; edit: EditOperations; bash: BashOperations };
}
targetFor(ctx: ThreadContext): ExecutionTarget
grantsFor(ctx: ThreadContext): Grant[]    // from the user's per-pool allowed paths
mountHome(userId): Promise<string>        // gocryptfs; called when the user's key becomes available
unmountHome(userId): Promise<void>
```

- Every sandbox run receives exactly `grantsFor(ctx)`, the thread's folder in
  the home workspace, and a read-only system.
- The network is unshared unless the thread allows it.
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
