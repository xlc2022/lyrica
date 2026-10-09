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
createUser(login, password, profile, { admin }): User     // first user must be admin
authenticate(login, password): User                       // also calls unlockUser
setAdmin(actor: User, target: User, admin: boolean): void // refuses to demote the last admin
listUsers(actor: User): User[]
updateProfile(actor: User, target: User, change: Partial<Profile>): Profile  // self, or an admin

interface Profile {
  displayName: string;                       // changeable at any time
  pronouns: { obj: string; poss: string; possPro: string; refl: string; subj: string };
  previousNames: { name: string; until: string }[];   // appended on rename
}
```

- The **login name** is separate from the display name, so renaming never
  affects signing in.
- Pronoun presets are she/her, he/him and they/them, plus a custom option that
  fills in all five forms.
- `subj` is used only in live prompts (for example, "Li's pronouns are
  they/them"). It is never substituted into stored memory.

## core/mentions

```ts
toStored(text: string, speaker: UserId): string  // {user}, {user:obj}… → [[u:ID]], [[u:ID:obj]]…
render(text: string): string                     // tokens → current names and pronouns
queryTokens(query: string, userIds: UserId[]): string  // names (current or previous) → tokens
```

Every write of a note or page goes through `toStored`. Every read path goes
through `render`. See [memory.md](memory.md#names-and-pronouns).

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
| Threads | `create`, `list({ includeHidden })`, `get`, `setHidden`, `appendEntry`, `loadEntries`, `forget` |
| Notes | `add`, `get`, `update(author)`, `archive`, `delete` |
| Pages | `index()` (titles and summaries), `get`, `put(author)` (sleep only), `delete` |
| WAKE and journal | `getWake`, `putWake`, `addJournal`, `listJournal` |
| Search | `search(query, { kinds, limit })`, returning `{ id, kind, snippet, score }` |
| Lineage | `cameFrom(id)`, `usedIn(id)`, `revisions(id)`, `isTombstoned(entryId)` |
| Sleep | `watermark()`, `recordSleepRun(run)`, `listSleepRuns()` |

Authors are `lyrica`, `sleep` or `user:<id>`.

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

- **`before_agent_start`** builds the prompt sections, in order: persona core,
  routed topic addenda, WAKE, page index, recall hits, time since last talk,
  and "who you're talking with": the user's current display name, pronouns,
  and previous names with dates. Each section has a size budget.
- **Tools** (at most 8 in total; see principle 8):
  - `remember`, `recall` and `read` (Memory thread);
  - `delegate` (Models thread);
  - `calendar` and `sort` (Integrations thread);
  - `web_search` and `web_fetch` (research, carried over from v1 or taken from
    a Pi package).

  That uses all 8.
- **Commands:** `/sleep`, and others only within the budget.
- Lyrica's sessions **never** load project context files (`AGENTS.md`,
  `CLAUDE.md`). Her self-primer is a routed topic.

## daemon

- **Session hosting:** `createAgentSession` with
  `SessionManager.inMemory(cwd, opts, view.own.loadEntries(threadId))`, the
  router's `modelRuntimeFor`, and a `DefaultResourceLoader` that has the inline
  Lyrica extension and context-file discovery turned off.
  - Built-in tools are disabled with `noTools: "builtin"`, so only the
    extension's tools exist. `noTools: "all"` would remove the extension's
    tools too.
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
