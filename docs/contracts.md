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
THREAD_MENTION                                                // [t:<id>], [e:<id>#<n>], [general/t:<id>]
renderThreadMentions(text, titleOf: (id, pool?) => string | undefined): string   // each mention → current title, or "a forgotten thread"
```

- **Thread mentions** stay IDs in everything stored; only display swaps in
  the title. The web shows the title as a link; text with no link (Read aloud) goes
  through `renderThreadMentions`. A mention in a general thread never
  resolves a private thread.

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
| Threads | `createThread({ interface, parent?, subagent?, child?, unlogged?, title?, project?, goal? })` (a child of a child is refused), `setProject`, `setGoal`, `projectOf`, `projectThreads`, `listThreads({ includeHidden?, parent?, children? })` (`children: true` lists the non-subagent daughters), `getThread` (`Thread.child`), `setHidden`, `setUnlogged`, `appendEntry(threadId, { piId, role, data, text })`, `loadEntries`, `entryWindow`, `entryPage` (entries carry `pinned`), `setTitle`, `exportThread`, `forgetThread(id, author, { children? })` (forgets its subagents' threads; other daughters go too with `children`, else they are kept with no parent and `child` cleared), `branchThread(threadId, n, { title? })`, `truncateThread(threadId, fromN, author)` → `{ removed, pins, subagents }`, `subagentsSince(threadId, fromN)`, `copyEntries(from, to, { upTo? })` (a thread's entries into another, for forks and branches), `entriesMentioning(needle)` → `{ thread, n }[]` (where an upload is still mentioned) |
| Pins | `pinEntry(threadId, n, pinned)`, `pins(threadId?)` → `PinnedEntry[]` (one thread's, or the pool's), oldest first |
| Projects | `pageForProject(threadId)`, `projectNotes(threadId, since?)` |
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
paths or machine locations (`<machine>:<root>`). Sleep sets it. `forFolders(paths)` returns the pages
whose folders contain or equal any of the given paths, which is how opening a
folder brings back what she knows about it.

**Unlogged threads** (see [memory.md](memory.md#threads-that-arent-logged))
are enforced in the store:
- `create` with an unlogged `parent` always makes an unlogged child, and
  `setUnlogged(false)` is refused on a thread whose parent is unlogged.
- Entries record whether they were written while unlogged. Search, sleep and
  catch-up never see those entries.
- **Removing turns.** `truncateThread` deletes entries from `fromN` on the
  way forgetting does: index rows go, notes whose sources are all gone are
  deleted with tombstones, pages citing them are flagged, and subagent
  threads started in those turns are forgotten. An entry that still has a
  copy in a branch keeps its notes and search rows, and `entryWindow` finds
  it through the copy. Entry numbers are never reused: `threads.cut` holds
  the highest removed number and `appendEntry` numbers past it.
- **Branches.** `branchThread` makes a child thread (not a subagent) holding
  the entries up to and including `n`, plus that reply's tool results,
  copied as an export copies them (`orig` keeps the source ID). The source
  is unchanged; a branch of an unlogged thread is unlogged.
- Notes can't be written from an unlogged thread.

**Pins** are a column on the entry (`entries.pinned`), so they live in the
thread's pool: a branch's `copyEntries` copies them, `truncateThread`
removes and counts them, and `sleepMaterial` lists each thread's new pinned
entries (`threads[].pinned`).

**Projects.** `createThread({ ..., project: true, goal? })` and
`setProject(id)` make a project of a top-level thread (a child or subagent
is refused, and there is no way back). `Thread.project` and `Thread.goal`
(the user's text, so in the pool with the title; `setGoal`, at most 2,000
characters). A project's threads are its child threads; `projectOf(id)`
gives the project chat for the chat or any of its threads, and
`projectThreads(id)` the chat and its threads.
- `projectSlug(projectId)` names the project's page, `p:project-<id>`;
  `pageForProject(threadId)` returns it once it exists. Its instructions
  part is written by the user, so the user-text rule above keeps it.
- `projectNotes(threadId, since?)`: current notes that cite the project chat
  or one of its threads, oldest first. Found by citation, never stored apart.
- `branchThread` of the project chat or one of its threads makes a thread of
  the project (`child`, parent the project chat), so depth stays 1.
- `forgetThread` on a project with `children` also forgets the project page
  and the notes that came only from it.
- `sleepMaterial` marks each thread of a project with `project`.

**Planned (Projects,** [briefs/projects.md](briefs/projects.md)**):** a
branch of a project's thread is anchored at its source's anchor; a branch of
the project chat where it branched (anchors live in `user.db`).

## core/models: the cloud boundary lives here

```ts
type Task = "chat" | "subagent.cheap" | "subagent.strong" | "compaction" | "title" | "embedding"
          | "sleep.consolidate" | "sleep.dream" | "sleep.wake" | "image.create" | "image.edit"
          | "speech.transcribe" | "speech.speak";
type ThinkingLevel = "off" | "low" | "medium" | "high";

interface Endpoint {
  id: string;                               // permanent (UUID); the name is a label
  name: string;
  kind: "cloud" | "local";                  // declared by whoever adds it, never inferred
  api: "openai-compatible" | "host";        // a paired model host; always local
  baseUrl: string; apiKey?: string;         // a host: its first address's /v1, and no key
  shared: boolean;
  addresses?: string[]; fingerprint?: string;   // a host's addresses, in order, and its pinned key
  unencrypted: boolean;                     // local, plain HTTP, outside this machine and the tailnet
  downSince?: string; stale: boolean;       // stale: unreachable for STALE_DAYS (14)
}
interface Capabilities { contextWindow?; tools?; vision?; embedding?; image?; edit?; reasoning?: ("low" | "medium" | "high")[];
                         transcribe?: boolean; speak?: { voices: Voice[] } }
interface Voice { id; language }                             // language: a primary tag, "en" or "zh"
interface Offering extends Capabilities {   // one model on one endpoint, with a permanent id
  id; endpointId; modelId; manual: boolean;
  status: "listed" | "missing" | "gone"; missingSince?;      // gone: missing for GONE_DAYS (30)
  digest?; identity?: ModelIdentity; downloaded?; size?; recipe?; separate?;   // reported by a host
}
type ModelRef = { offeringId: string } | { groupId: string };
interface Group { id; name; shared; members: string[] }      // offering IDs, in order, one per endpoint
type ProfileName = "cloud" | "local" | "custom";
type Entry = ModelRef[] | { same: Task };                   // an ordered list, or another task's list
type Profiles = Partial<Record<Task, Entry>>;

interface CallContext {
  userId; pool; localOnly: boolean;         // always true for private
  profile?: "cloud" | "custom";             // general threads only; ignored where localOnly
  overrides?: Partial<Record<Task, ModelRef[]>>;   // the thread's own lists, which beat the profile
  thinking?: ThinkingLevel;
  voiceCloud?: boolean;                     // Voice to cloud; absent is off
}
interface Need { tools?: boolean; tokens?: number }        // what the call needs from a model
interface Resolution { ref: { offeringId }; endpoint; offering; label; profile: ProfileName;
                       source: "thread" | "profile"; skipped: { label; reason }[]; remaining: number }
interface Pace { promptTokens; outputTokens; window; ttftMs; genMs; processed }   // counts and times only
interface CallRecord { at; pool; threadId; task; offeringId; label; endpointName; kind; fallback?; note?; pace?: Pace; audioSeconds? }
interface AnswerSettings { temperature?; topP?; topK?; minP?; repeatPenalty?; presencePenalty?;
                           frequencyPenalty?; maxTokens?; seed?; stop?: string[];
                           voices?: Record<language, voiceId>; speed? }   // the last two for speak models
type SettingSource = "shared" | "yours";                   // absent: the server's default
type Hub = "huggingface" | "modelscope";
interface ModelIdentity { basename?; sizeLabel?; finetune?; baseModels?: { name?; organization?; repoUrl? }[]; card?: { baseModel?: string[]; baseModelRelation? } }
interface LibraryEntry { key; name; base?: { key; name }; starred; groups: string[]; copies: { offeringId; label; rawName;
                         endpointId; endpointName; kind; shared; status; downloaded; capabilities; groups; flagged?; size? }[] }
type Use = { where: "profile"; profile; task } | { where: "thread"; pool; threadId; task }
         | { where: "workflow"; name } | { where: "group"; groupId; name };
interface CleanupItem { endpoint?; offering?; group?; label; usedIn: Use[]; otherUsers: number; suggestion?: { offeringId; label } }

class Models {                                              // new Models(keyring, users)
  // Endpoints and IDs
  addEndpoint(actor, { name, kind, baseUrl, apiKey? }, { shared? }): Endpoint   // shared: administrators only
  editEndpoint(actor, id, { name?, baseUrl?, apiKey?: string | null }): Endpoint   // never touches an ID; not a host's URL or key
  removeEndpoint(actor, id)                                 // each model leaves a tombstone; for a host, this is unpairing
  endpoints(userId) / endpoint(userId, id) / offerings(userId, endpointId) / offering(userId, offeringId)
  label(userId, id) / find(userId, idOrLabel): ModelRef? / findEndpoint(userId, idOrLabel)
  addModel(actor, endpointId, { modelId } & Capabilities): Offering
  setCapabilities(actor, offeringId, { [cap]?: value | null }): Offering   // by hand wins over discovery
  // Discovery and health
  discover(actor, endpointId): Promise<Offering[]>          // GET /v1/models; a host's /host/v1/models and confirmed recipes
  probe(userId, endpointId, timeoutMs?): Promise<{ state: "up" | "down"; warning? }>
  pageStatus(userId, endpointId, budgetMs = 3000): Promise<{ state; warning?; status?; error? }>
  reportUp(userId, endpointId) / reportDown(endpointId)     // the health cache: HEALTH_MS = 30 s
  sameModel(userId, offeringId): { offeringId }[]           // same base name and kind, other endpoints
  // Redirects and clean-up
  replace(actor, fromId, toId) / removeOffering(actor, offeringId) / resetIds(actor, endpointId): string / merge(actor, fromId, intoId)
  cleanup(userId): CleanupItem[] / prune(now?) / notice(userId): string[] / dismissNotice(userId)
  workflowSpec(userId, spec) / reindex(userId)              // Delegation: labels to offering IDs; re-index shared_refs
  // Groups
  groups(userId) / group(userId, id) / addGroup(actor, { name, members }, { shared? }) / editGroup(actor, id, { name?, members? }) / removeGroup(actor, id)
  groupDetail(userId, id): { group; members: (Offering & { label; kind; stale })[]; warnings: string[] }
  groupSuggestions(userId): { name; members; strength: "strong" | "weak" }[]   // never made automatically
  // Profiles, thread choices and resolve
  profile(userId, name): Profiles / setProfile(userId, name, task, value?: Entry | ModelRef)   // a single ref is a one-model list
  defaultProfile(userId) / setDefaultProfile(userId, "cloud" | "custom")
  setThreadModel(userId, pool, threadId, task, list?: ModelRef[] | ModelRef) / checkThreadList(ctx, task, list): ModelRef[]
  setThreadProfile(userId, pool, threadId, "cloud" | "custom" | null) / threadProfile(userId, threadId)
  setLocalOnly(userId, pool, threadId, on) / forgetThread(userId, pool, threadId)
  callContext(userId, pool, threadId): CallContext
  childContext(parent, childThreadId, { tier } | { model }): CallContext   // a child under its parent's rules
  inheritContext(parent, childThreadId, { chat? }): CallContext          // a branch: the parent's local-only, profile, thinking and lists
  resolve(task, ctx, need?, { evenIfDown?, except? }?): Resolution   // throws CloudModelForbidden, NoModel or Offline
  resolveLive(task, ctx, need?, { probeMs?, probeLast? }): Promise<Resolution>   // probes first when there is a fallback; asks again before Offline
  callWithFallback(task, ctx, need, call: (r) => Promise<T>, { probeMs? }?): Promise<T>   // the next model on isUnreachable; Offline when none answers
  resolveModel(task, ctx, need?): { offeringId }             // resolve(…).ref
  allowed(ctx): { endpoint; offerings }[]                   // local endpoints only when restricted
  // Thinking and call records
  defaultThinking(userId) / setDefaultThinking(userId, level) / setThinking(userId, threadId, level | null)
  thinkingFor(resolution, asked): { level; note? }
  recordCall(userId, { pool, threadId, task, resolution, note?, audioSeconds? }, { retry? }) / recentCalls(userId, { limit?, threadId?, speech?: false }): CallRecord[]
  recordPace(userId, pool, threadId, task, pace) / speedsByOffering(userId): Map<offeringId, { tokPerS?; promptTokPerS? }>   // medians over the last 20 calls
  // Hosts and pairing
  pairHost(actor, { name, addresses, code }, { shared?, endpointId? }): Promise<Endpoint>   // endpointId: pair again, IDs kept
  setHostAddresses(actor, id, addresses): Endpoint / fetchFor(endpoint): typeof fetch | undefined   // undefined for a plain endpoint
  hostStatus(userId, id) / hostControl(actor, id, "pause" | "resume" | "restart")
  // Speech: the only way audio reaches a model
  transcribe(ctx, wav, { language?, signal? }): Promise<{ text; resolution; audioSeconds? }>   // VoiceCloudOff, CloudModelForbidden, NoModel, Offline
  speak(ctx, text, { voice?, speed?, language?, signal? }): Promise<{ audio: ReadableStream<Uint8Array>; resolution; voice? }>   // raw PCM, SPEECH_FORMAT
  speechModel(task, ctx): { label; kind } | { reason: "none" | "voiceCloud" | "down"; problem }
  defaultVoiceCloud(userId) / setDefaultVoiceCloud(userId, on) / threadVoiceCloud(userId, threadId) / setThreadVoiceCloud(userId, threadId, on | null)
  // Settings
  offeringSettings(userId, offeringId): { values: AnswerSettings; sources: Partial<Record<keyof AnswerSettings, SettingSource>>;
                                          dropped: (keyof AnswerSettings)[]; contextWindow?: { value; source: "host" | "hand" | "discovered" } }
  setOfferingSettings(actor, offeringId, change, scope: "shared" | "mine" = "mine")   // null clears a value
  // Library, tokens, downloads, delete
  textLibrary(userId, { search?, kind?, endpointId?, capability?, groupsOnly?, offset?, limit? }): { total; entries: LibraryEntry[] }
  star(userId, offeringId, on) / notThisModel(actor, offeringId, separate = true)
  hubTokens(userId): { hub; shared; last4 }[] / setHubToken(actor, hub, token, { shared? }) / removeHubToken(actor, hub, { shared? })
  hubFiles(actor, hostId, { source, repo, revision? }) / startDownload(actor, hostId, body) / downloads(actor, hostId) / cancelDownload(actor, hostId, downloadId)
  deleteCopy(actor, offeringId, { confirm? }): Promise<{ usedIn: Use[]; deleted?: string[]; left?: { files; reason } }>
  imageLibrary(userId, hostId): { recipes; parts (by role) } / recipe(actor, hostId, recipeId, action)
  // Host management and serving
  manageHost(actor, hostId, method, path, body?)            // only models/load|unload|pin|reload, gpus/<n>, scan, usage
  servingSettings(userId, offeringId) / setServingSettings(actor, offeringId, settings) / reloadModel(actor, offeringId)
  hostDashboard(userId, hostId): string                     // a direct link, at the address that last answered
}
// Also exported: CloudModelForbidden, NoModel, Offline (a NoModel: code "offline", task, tried), isUnreachable(err),
// HostRefused (with `code`), PairingFailed, HostIdentityChanged, VoiceCloudOff;
// SPEECH_FORMAT (s16le, 24 kHz, mono), SPEECH_CONTENT_TYPE, MAX_CLIP_SECONDS (600), MAX_CLIP_BYTES, MAX_SPEAK_CHARS, wavData, wavSeconds, pcmSeconds, LANGUAGE;
// STALE_DAYS, GONE_DAYS, HEALTH_MS, CAPABILITIES, ANSWER_SETTINGS, TASKS, TASK_NAMES (each task in words, for messages), THINKING_LEVELS; isRestricted, profileFor,
// checkTask, refId, baseName, acceptedSettings(endpoint), payloadFields(…); fingerprint, normaliseCode, pairingProofs,
// hostOrigin; probeUrl(baseUrl, apiKey, timeoutMs?, fetchImpl?), discoverModels, addressesOutside.
```

- **The boundary.** `isRestricted(ctx)` is `pool === "private" || localOnly`,
  and a private thread is always local-only (`setLocalOnly(…, false)` and
  `setThreadProfile` on one throw). In a restricted context `allowed`
  returns local endpoints only, `resolve` uses the local profile whatever
  `ctx.profile` says, a group's cloud members are skipped, and a cloud model
  named directly throws `CloudModelForbidden`. Nothing falls back across the
  local/cloud line: outside Custom a list keeps to one kind (local where
  restricted, cloud in the cloud profile, else its first model's).
- **Offline** is the one shape for "every model in a task's list is away",
  for chat, images and speech alike: `Offline extends NoModel` with
  `code: "offline"`, the `task`, and `tried` (labels and reasons, in list
  order, never text). `resolve` throws it when the list is set and a model
  was skipped only because its machine is down (health cache) or stale;
  a list where nothing fits the call stays `NoModel`. `resolveLive` asks
  the down machines again, once, in order, before throwing it, so one that
  has come back answers. `callWithFallback` runs a call on each model in
  turn: an `isUnreachable` failure (connection refused, reset or timed out,
  a reply cut off, a host's `unreachable`, `paused`, `busy`, `restarting`,
  `unavailable`, `unpaired` or `identity_changed`) marks it down and tries
  the next (a host's `model_unavailable` marks only that model down, for
  HEALTH_MS, and the host stays up for its others); any other failure is thrown as is; when none answers it throws
  `Offline` naming every model tried, and never goes round twice.
- **Kind is pinned** where an endpoint is made: `addEndpoint` takes it as
  declared, `pairHost` makes a host local, `editEndpoint` can't change it,
  and `replace` and `merge` refuse to cross kinds. `probe` only warns when a
  local endpoint resolves outside loopback, private or tailnet ranges.
- **What never crosses.** API keys stay in core (`EndpointInfo.hasApiKey`).
  Hub tokens leave core only as `X-Hub-Token` to a host, never in a response,
  log or call record. Call records hold model metadata, never prompt text.
- **Lists.** The entry that decides a task is the thread's list, else the
  profile's after one level of `same`, else chat's (not for `embedding` or
  the image tasks). `resolve` expands groups in place, follows redirects,
  drops tombstoned entries, and skips a model that is gone, on a stale or
  down endpoint, or unfit for the `need` (tools, context window, image or
  edit). `checkThreadList` and `setProfile` refuse a list the router would
  refuse, before anything is written.
- **Hosts** are called only through `fetchFor`: undici, with a connector that
  checks the pinned key before any byte is sent, no session resumption,
  addresses tried in order. A changed key ends the call with
  `HostIdentityChanged`'s message and marks the host down; `paused`, `busy`,
  `restarting`, `unavailable` and `unpaired` answers mark it down too. A
  host's refusal is a `HostRefused` carrying the host's own `code`. Lyrica's
  key and certificate live in `self.db` (`host_identity`). `undici` 8.10.2
  is a direct dependency of core for this.
- **Settings** per offering are layered: a shared offering's values in
  `self.db` (administrators), the user's own in `user.db` over them. Only
  values that are set are sent, and only those the endpoint's API takes
  (`acceptedSettings`: everything for local endpoints, hosts and OpenRouter;
  OpenAI's set for other cloud endpoints); `dropped` names the rest.
  Settings follow redirects and are pruned with their offerings.
- **Where things live.** In `self.db`: `endpoints`, `offerings`,
  `model_groups`, `offering_settings`, `hub_tokens` (shared), plus
  `offering_redirects`, `redirect_pending`, `shared_refs`,
  `shared_refs_indexed`, `legacy_refs` and `host_identity`. In each
  `user.db`: the same first five (the user's own), `model_profiles`,
  `thread_models`, `thread_choices`, `local_only_threads`,
  `starred_offerings` and `model_calls`, with the default profile, default
  thinking level and the notice in its `settings`. Shared rows change only
  with an administrator actor. A `user.db` is migrated, has pending shared
  redirects applied, and is indexed into `shared_refs` the first time it is
  opened in a process.
- **Speech.** `speech.transcribe` and `speech.speak` have lists of their
  own (neither follows chat) and take models with the `transcribe` or
  `speak` capability, reported by a host or set by hand. `transcribe` and
  `speak` follow the same boundary as `resolve`; `transcribe` also refuses
  a cloud model unless `ctx.voiceCloud` (`VoiceCloudOff`, nothing sent).
  Both run through `callWithFallback`: an endpoint that can't answer is
  marked down and the next model in the list answers; a list with nothing
  that can answer throws `Offline`.
  Voices and speed are layered shared then yours, per language. Never audio
  or text in a record or log; records carry `audioSeconds`.
- **The speech wire** (lyricad to an endpoint, OpenAI's shapes; a host
  passes them through, host/API.md): `POST /v1/audio/transcriptions`,
  multipart `file` (`audio/wav`), `model`, `language?`, `response_format:
  "json"` → `{ text }`; `POST /v1/audio/speech`, JSON `{ model, input,
  voice?, speed?, response_format: "pcm" }` → raw s16le mono 24 kHz PCM,
  streamed. A host's `/host/v1/models` entry has `kind` `transcribe` or
  `speak`, with `capabilities.transcribe: true` or `capabilities.speak:
  { voices: [{ id, language }] }`. Away (`isUnreachable`): no answer, a
  host's away codes, or 5xx or 429 from a plain endpoint; a host's
  `model_unavailable` (one model's server is off) skips only that model.
- **Planned:** `X-Lyrica-Priority: background` for sleep and cheap subagents
  (not sent; hosts use their defaults; it needs the task in Pi's request
  preparation), and clearing `redirect_pending` rows when a user is deleted,
  once users can be.

## delegate

```ts
new Delegation({ users, memory, models, workspace?, cwd, limits? })  // one per lyricad
createDelegateExtension(thread, delegation, budget?)   // adds `delegate` (and `ask_parent` in a subagent)
delegation.events                                      // typed EventEmitter for the live view
delegation.store                                       // roles and saved workflows, in user.db
delegation.forget(userId, pool, threadId)              // before forgetThread: stops its runs
delegation.forgetSubagents(userId, pool, threads)      // before truncateThread: stops runs with a subagent among them
delegation.stopAll(userId?)                            // Lock and shutdown
```

One model-facing tool: `delegate({ action?, ... })`.
- The default action runs work: `task` with an optional `role` and `tier`;
  or `tasks: [...]` (parallel), `chain: [...]`, `loop`, `council`, or
  `workflow: name`. Any of these can be `background: true`. She picks a tier,
  never a model; only saved workflows, which users write, may name one.
- The other actions are `status`, `wait`, `stop` and `message`, each on a
  run ID, and only on runs the calling thread started. `message({ id,
  message, thread? })` joins a working subagent's turn, answers its open
  question, or continues a finished, failed, stopped or interrupted one in
  its own thread, with its model and workspace worked out again from the
  parent's current settings. A task may set `fork: true` to start from a
  copy of the parent's conversation.
- A subagent also has `ask_parent({ question, wait? })` (`wait: false`
  sends a note and keeps working, up to `limits.notes` per stretch), and
  read-only memory (`registerMemoryTools({ readOnly: true })`).
- `new Delegation({ ..., approve? })`: a subagent's tool calls ask under the
  strictest mode of its thread and its ancestors, read at each call
  (`effective`), through `approve(SubagentApproval, signal)`, which
  `lyricad` shows in the subagent's thread and its parent's; the first answer
  wins, and a timeout, Stop or abort refuses. With no `approve`, the call is
  refused.
- `delegation.message(parent, runId, { text, from? }, { thread?, budget })`
  is also how a user's message reaches a subagent, from its card in the
  parent's chat; the parent gets a note. `subagent_runs` records `pick` and
  `narrowing` so a subagent can be continued.
- Subagents aren't listed in the thread list; child threads (forks, copies)
  nest under their parent.
- **Child threads** (`createThreadsExtension(thread, host?: ThreadsHost, meter?)`,
  never in a subagent's thread): one model-facing tool, `threads({ action,
  ... })`: `start` (`title`, `task`, optional narrower `folders`,
  `readOnly`, `internet`), `message` (to a child, by ID or current title
  (`pickThread`; a title two threads share is refused), or `to: "parent"`
  from a child), and `list` (`ChildInfo` with `ChildStatus`). Its results
  and guidance mention threads as `[t:<id>]`. A child thread is
  `createThread({ parent, child: true })`, hosted like any thread, with the
  parent's pool, models (`models.inheritContext`) and workspace
  (`inheritSettings`), which can only narrow. `ThreadsLimits`
  (`DEFAULT_THREADS_LIMITS`): 3 starts per request, 2 children working at
  once per user, checked on start and when a parent's message wakes an idle
  child. A parent's message is the child's next turn, marked with
  `fromParent(id)` (`FROM_PARENT`), which only `lyricad` writes; a child's
  update reaches the parent through `Delegation.deliver` as a notice with
  status `update`, and every delivery's details carry an `id`.
- **Modes:** a thread in Plan mode starts only read-only roles; anything
  else is refused before a thread is made. A read-only subagent there runs
  in Plan mode itself.
- **Planned (Projects):** in a project, `threads.start` records the anchor
  (the project chat's entry it hangs off) and returns `queued` past the
  at-once limit instead of refusing; `message({ to: "parent", text,
  needsYou? })`; `message({ id, text })` from a project's thread to another
  thread of the same project, marked `fromThread(id)` (`FROM_THREAD`, which
  only `lyricad` writes and `send` refuses from a user), at most 3 per turn;
  new actions `suggest({ threads: { title, task }[] })` (a card, no thread
  made), `resolve({ id? })` and `reopen({ id })` (in a project's thread,
  `resolve` with no `id` acts on itself). `user.db` `child_threads` gains
  `anchor`, `resolved` and `needs_you` (no text). Still one tool.

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

```ts
// extension/, because core has no Pi dependency:
modelRuntimeFor(models, ctx): Promise<ModelRuntime>       // Pi runtime holding only models.allowed(ctx), sealed
piModelFor(runtime, models, task, ctx, resolution?): { ref; model; resolution }
prepareTurn({ session, runtime, models, call, pool, threadId, task?, thinking?, retry? }): Promise<Resolution>
openThreadSession({ thread, models, cwd, extensions, settings? }): Promise<ThreadSession>
interface ThreadSession { session; runtime; chat: { offeringId }; prepare(opts?: { thinking?; retry? }): Promise<Resolution>; dispose() }
interface ContextMeter { report(): ContextInfo | undefined; contextLines(): string; pending?: { summary } }   // LyricaOptions.meter
```

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
- Memory sections include `pinned` (`pinnedOf(store, threadId)`: the
  thread's pinned user messages and replies, read from the store, so
  compaction can't summarise them). `pinnedBlock(pins, budgets.pinned)`
  keeps them word for word within the budget (8,000 characters): over it,
  the oldest are cut to their first line, then the oldest dropped, and it
  reports `shortened`. The context meter counts them as its `pinned` part.
- **`before_agent_start`** never replaces the whole system prompt. It does two
  things:
  - It edits `event.systemPromptOptions`. The persona core goes in
    `customPrompt`. Topics, WAKE, the page index, the thread's pinned
    messages, and "who you're talking with" go in `sections`. Pi appends only what changed, so the prompt
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
  - `threads`, in every hosted thread but a subagent's
    (`createThreadsExtension(thread, host?, meter?)`; Child threads; see
    [delegate](#delegate));
  - `calendar` and `sort` (Integrations thread);
  - `image`, with `create` and `edit` (Images thread);
  - `web_search` and `web_fetch` (research, carried over from v1 or taken from
    a Pi package);
  - in sleep sessions only: `write_page`, `write_journal`, `write_wake`,
    `raise` and `propose_persona` (Sleep thread; see [sleep.md](sleep.md)).
  - `propose_plan({ plan })`, only in Plan mode and never in a subagent
    (Modes; see [workspace.md](workspace.md));
  - compacting is `threads({ action: "compact", summary })`
    (`askCompaction`, `COMPACT_GUIDELINES`): it runs after the turn and
    answers Pi's `session_before_compact` with her summary. There's no
    separate `compact` tool.
- **Which tools are on** (`extension/src/gate.ts`): `setToolsOff(pi, ctx,
  reason, names)`. The unlogged rule, a subagent's role and the workspace's
  mode and switches each say which tools their reason has off; a tool is
  active only while no reason has it off, and comes back only if a reason
  took it away.
- **Workspace extension** (`createWorkspaceExtension(tools: ThreadTools)`):
  - `ThreadTools` is `{ target(machine?), settings(), network(),
    machines?(), allowedInThread?(machine, command), proxmox?(machine, action, vm?), approve?, setMode?,
    proposePlan?(PlanRequest), recordChange?(NewChange) }`.
    `settings()` is the thread's effective settings.
  - `read`, `write`, `edit` and `bash` take an optional `machine`. On a
    machine the call's mode is `stricterMode(settings().mode, limit)`; a
    suspect `bash` (`suspectCommand`) asks in every mode unless
    `allowedInThread`; the first call on a machine in a turn asks if
    anything earlier ran elsewhere. `ApprovalRequest` is `{ toolCallId,
    tool, input, machine?, cwd?, warning? }`, and the call runs only if its
    arguments are still exactly what was approved. With `proxmox`, the
    `proxmox` tool is registered, and offered only while `machines()` has a
    Proxmox machine.
  - `toolsOff(settings, registered)`: Plan mode leaves only `PLAN_TOOLS`
    (`read`, `recall`, `read_memory`, `web_search`, `web_fetch`,
    `delegate`, `ask_parent`, `threads`, `propose_plan`, `proxmox`, whose
    `tool_call` refuses all but its reading actions); outside Plan
    mode `propose_plan` is off. `SWITCHED_TOOLS`: `webSearch` turns off
    `web_search` and `web_fetch`, `images` turns off `image`. The gate runs
    on `session_start`, `before_agent_start` and right after a plan is
    approved, and `tool_call` refuses a tool that's off.
  - `propose_plan` asks `proposePlan`, which answers a `GoAhead` (one of
    `GO_AHEAD`: `ask`, `acceptEdits`, `auto`) or undefined to keep
    planning; then `setMode`. Without lyricad, Pi's UI asks; with no UI,
    she keeps planning.
  - A tool annotated `openWorldHint` and not `readOnlyHint` always asks,
    even in Auto.
  - `recording(target, ops, toolCall, record?)` wraps the `write` and
    `edit` operations so each change reaches `recordChange`.
- **Commands:** `/sleep`, and others only within the budget.
- Lyrica's sessions **never** load project context files (`AGENTS.md`,
  `CLAUDE.md`). Her self-primer is a routed topic.
- `openThreadSession` returns `prepare()`, which `lyricad` runs before every
  turn and Delegation once per subagent (with `thinking: false`, so a role
  keeps its own level). It calls `prepareTurn`: `resolveLive` for the chat
  model with the session's active tools and context usage as the `need`,
  `session.setModel` when the model changed, `setThinkingLevel` from
  `thinkingFor`, and `recordCall`. `prepare({ retry: true })` probes for at
  most one second and rewrites the turn's call record. Each successful
  assistant message calls `reportUp` for its provider.
- `modelRuntimeFor` wraps `ModelRuntime.prepareRequest`, an internal of Pi
  1.1.0 (as are `defaultBuiltins`, `builtins` and `rebuildProviders`, used to
  empty the catalog); re-check them when Pi is upgraded. The wrapper gives a
  host provider its `fetchFor` fetch, and for every offering adds an
  `onPayload` that merges `payloadFields(offeringSettings(…).values, …)` into
  the request: `repeat_penalty` for plain local servers,
  `repetition_penalty` for hosts and cloud; `max_tokens` or
  `max_completion_tokens` never above the room Pi left. Settings are read at
  each request, so a change applies without reopening the session.
- A host model whose only thinking level is a chat-template switch gets Pi's
  `thinkingFormat: "qwen-chat-template"`; any other model with levels gets
  `reasoning_effort`. Local endpoints and hosts are sent `system` and
  `max_tokens`.
- **Planned (Projects):** a `project` section in `assemble`, with its own
  `DEFAULT_BUDGETS.project` (2,000 tokens to start): the goal and
  instructions first, then project notes since the last sleep, then the
  project page, then (in the project chat only) its threads with their
  state. Filled for a project chat and each of its threads; empty elsewhere.

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
  - Before each turn `lyricad` awaits `prepare()`; on an
    `auto_retry_start` whose error looks like a connection failure it calls
    `reportDown` and `prepare({ retry: true })`, and a `message_end` error of that
    shape calls `reportDown`. The nightly tick calls `Models.prune()` before
    `sleepNight`.
- **Startup:** once unlocked, `lyricad` builds `Workspace` with its own
  listening ports as `excludePorts` and its front door as `frontDoor`, and calls
  `selfTest()` before serving threads. It builds one `Delegation`, adds
  `createDelegateExtension` to each thread's session, forwards
  `delegation.events` to the parent thread's stream, and calls `stopAll` on
  Lock and shutdown. It builds one `Sleep` and calls `stop(userId)` on Lock
  and shutdown, before the key goes. It builds one `ChildThreads`
  (`Services.children`, limits from `LyricadOptions.threads`), the
  `ThreadsHost` every hosted thread's `threads` tool uses: `user.db`
  `child_threads` (pool, thread, parent, working, unseen; no text). Lock
  stops working children and tells their parents; at unlock, children a
  restart left working are marked idle and their parents told.
- **Permission prompts:** the workspace extension's `tool_call` hook calls
  `ThreadTools.approve?(request)`; `lyricad` supplies it and waits for an
  answer from any open view, denying on timeout or Stop. `proposePlan`
  takes the same path: `PermissionAnswer { allow, mode?: GoAhead,
  allowInThread? }`, and approving a plan without `mode` is `400`. A
  request on a machine carries `machine` and `cwd`, a suspect one `suspect:
  true` and `warning`; `allowInThread` stores that exact command for the
  thread it runs in and is refused on any other request. A plan switching the mode, or a
  settings change, sends the thread a `{ type: "settings" }` event.
- **Sweep** (`Lyricad.sweep`, nightly, before sleep): `sweepUser(services,
  userId)` for each user whose home workspace is mounted clears snapshots
  and change records older than 30 days (`SWEEP_AGE_MS`), the folders of
  threads that no longer exist (younger than 60 s are left), and the
  worktrees of subagent runs that aren't live (`DelegationStore.liveRuns`)
  and haven't changed in 30 days. `forgetWorktree(path, allowed)` removes a
  worktree's git record only when it is in a folder the user may grant,
  reached with no symlinks, and names that worktree back. Logs counts only.
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
  - `ThreadSettings.context` (`ContextInfo`: used, window, parts, reserve,
    free, measured at), `CallInfo.pace`, the `context` and `compacted`
    thread events, and a `compacted` message part (the stored notice);
  - offline: an `offline` thread event (`task`, `tried`) when no model for a
    turn can be reached; a turn that hadn't started keeps its message in
    `queue` and sends it when a model answers. Any call that throws `Offline`
    answers `502` (503 is reserved for locked) with `{ error, code: "offline", task, tried }`;
  - child threads: `ThreadSummary.child`, `status` and `unseen`;
    `Message.from: { kind: "parent", threadId }` in a child thread only; a
    user's send or edit starting with the parent's mark is `400`;
    `ForgetThread` / `DELETE …?children=1`; `ThreadHost.status`,
    `delivered`, `HostedThread.waiting`, `send(text, { fromParent })` and
    `settled()`;
  - **planned (Projects):** thread pins, per user: `user.db`
    `pinned_threads` (pool, thread; no text), `PUT`/`DELETE
    threads/:id/pin`, `ThreadSummary.pinned`; Web UI 2's thread menu uses
    them. `POST threads` with `project` (and `PATCH` making one) also pins
    the thread; the sidebar's saved
    view gains `projects: "all" | "only" | "none"`; `PATCH
    threads/:id` with `project`, `goal`, `paused` and the threads model and
    thinking; `POST …/messages/:n/thread` (Start a thread) →
    `ThreadSummary`; `POST threads/:id/resolve` and `…/reopen`; `POST
    …/suggestions/:id/start` (one, or all with no id); `GET
    threads/:id/overview` (its threads by state, the waiting dot, total
    tokens); `models/calls?project=`. `ThreadSummary` gains `project`,
    `anchor`, `state` (`working`, `waiting`, `queued`, `idle`, `resolved`),
    `needsYou` and `outputs` (file names); a `child` event updates a card in
    place. A Notifications type `waiting`. The nightly tick resolves a
    project's threads idle for 7 days; Paused and Hide stop a project's
    working threads the way Lock stops children;
  - pins: `PUT`/`DELETE …/messages/:n/pin` (the user's messages and her
    replies only, `400` otherwise, `409` in a subagent's thread), `GET
    …/pins` → `Pins { pins: Pin[], shortened }`, `Message.pinned`,
    `RewindResponse.pins`;
  - messages (send, stream; `POST …/messages/:n/branch` → `ThreadSummary`;
    `POST …/messages/:n/rewind` with `RewindRequest` `delete`, `regenerate`
    with an optional `model`, or `edit` with `text`, `409` while a turn runs;
    `preview: true` answers a `RemovalPlan` (`messages`, `pins`,
    `subagents`, `files: PlanFile[]`, `branches: PlanBranch[]`, `commands`)
    and changes nothing; `skip` lists the plan items left as they are;
    `RewindResponse` gains `files` and `branches`, the counts undone
    (`removalPlan` and `applyRemoval` in `daemon/src/removal.ts`; uploads
    found with `PoolStore.entriesMentioning`); the `rewound` event carries
    `from` and `resend`, never text);
  - modes: `GET`/`PUT /api/u/:userId/mode` (`ModeDefault`), the mode new
    threads start in; `ThreadSettings` and `ThreadSettingsChange` gain
    `webSearch` and `images`, and their mode and switches are the effective
    ones;
  - models (paths under `/api/u/:userId/`):
    - **Endpoints:** `GET`/`POST endpoints`; `PATCH`/`DELETE endpoints/:id`;
      `POST endpoints/:id/discover`, `…/reset-ids`, `…/merge` (→ `EndpointInfo`),
      `…/models` (→ `OfferingInfo`); `GET …/probe`. Types: `EndpointInfo` (`api`,
      `addresses`, `fingerprint`, `hasApiKey`, `unencrypted`, `stale`,
      `downSince`, `models: OfferingInfo[]`), `OfferingInfo` (with `label`),
      `EndpointInput`, `EndpointChange`, `ModelInput`, `Probe`, `MergeInput`.
    - **Hosts:** `POST hosts` (pair, then discover); `POST hosts/:id/pair`
      (again, same addresses); `PUT …/addresses`; `GET …/status`; `POST
      …/pause|resume|restart`; `GET …/dashboard` (→ `{ url }`); `POST …/manage`;
      `GET …/hub/files`; `POST`/`GET …/downloads`, `DELETE …/downloads/:id`;
      `GET …/images`; `POST …/recipes/:recipeId`. Unpair is `DELETE
      endpoints/:id`. Types: `HostInput`, `HostRepair`, `HostAddresses`,
      `HostStatus`, `HostManage`, `DownloadInput`, `RecipeAction`.
    - **Offerings:** `PATCH`/`DELETE offerings/:id`; `POST …/replace`; `GET
      …/same`; `GET`/`PUT …/settings`; `PUT …/star`; `PUT …/separate`; `POST
      …/delete-copy`; `GET`/`PUT …/serving`; `POST …/reload`. Types:
      `CapabilitiesChange`, `ReplaceInput`, `AnswerSettings`, `OfferingSettings`
      (`sources`, `dropped`, `contextWindow` with its source),
      `OfferingSettingsChange` (`scope: "shared" | "mine"`), `DeleteCopy`
      (`usedIn`, `deleted`, `left`), `ServingSettings`.
    - **Groups and profiles:** `GET`/`POST groups`; `GET groups/suggestions`;
      `GET`/`PATCH`/`DELETE groups/:id`; `GET`/`PATCH profiles` (`default`,
      `thinking`); `PUT profiles/:profile/:task` with `{ models }`, `{ same }` or
      `{ model }`. Types: `GroupInfo`, `GroupInput`, `GroupChange`,
      `GroupDetail`, `GroupSuggestion`, `Profiles` (all three plus `default` and
      `thinking`), `ProfileEntryChange`, `ProfilesChange`.
    - **Models page, library, tokens:** `GET models/page` (→ `ModelsPage`:
      endpoints with `pageStatus`, hosts' status, profiles, the last 20 calls,
      the notice, the Clean up count); `GET models/cleanup`; `GET`/`DELETE
      models/notice`; `GET models/calls`; `GET library/text`; `GET hub-tokens`,
      `PUT`/`DELETE hub-tokens/:hub` (`?shared=1`). Types: `ModelsPage`,
      `CleanupItem`, `ModelUse`, `ModelsNotice`, `CallInfo`, `TextLibrary`,
      `LibraryEntry`, `HubTokenInfo` (last four characters), `HubTokenInput`.
    - **Threads:** `ThreadSettings` gains `profile`, `profileChoice`, `thinking`,
      `thinkingLevels` and `answered`; `TaskModel` gains `list`, `label` and
      `modelId`. `ThreadSettingsChange.models` takes a ref, a list or null, and
      gains `profile` and `thinking`. `DELETE` on a thread calls
      `Models.forgetThread` for it and each subagent thread under it.
    - **Errors from core** (`statusOf`): `CloudModelForbidden`, `NoModel` and
      `PairingFailed` are `400`; `Offline` is `502`; `Forbidden` is `403`. A `HostRefused` keeps the
      host's meaning by `code`: `invalid` 400, `refused` 403, `not_found` 404,
      `in_use` 409, `too_big` 413, `no_space` 507; any other code (`unreachable`,
      `paused`, `busy`, `unpaired`, `identity_changed`, …) is `502` with the
      host's plain message.
  - users and admin;
  - memory browser;
  - speech: `POST …/threads/:pool/:threadId/transcribe` and `POST
    /api/u/:userId/transcribe?pool=` (an `audio/wav` body, `?language=`) →
    `Transcription { text, seconds, model }`; `GET
    …/threads/:pool/:threadId/messages/:n/speech` (or `messages/live/speech`)
    streams raw PCM (`audio/pcm;rate=24000;encoding=s16le;channels=1`), with
    the message read from the store, never sent by the client;
    `ThreadSettings.speech` (`Speech`, also `GET /api/u/:userId/speech?pool=`)
    and `voiceCloud` (null follows `Profiles.voiceCloud`);
    `ThreadSettingsChange.voiceCloud`, `ProfilesChange.voiceCloud`;
    `Capabilities.transcribe` and `speak`, `AnswerSettings.voices` and
    `speed`, `CallInfo.audioSeconds`. `VoiceCloudOff` is `400`;
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
- Consolidate keeps each project's page (`p:${projectSlug(id)}`) for every
  project with new conversation, from its notes and threads; the user's
  instructions on it are kept by the store. `write_page` refuses a
  `project-…` slug that names no project in the pool (unless the page
  exists) or an unlogged project's.

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
new SshTarget(cfg, { transport: SshTransport, address?, connected? })  // the host key must be cfg.hostKey
interface SshTransport { connect(to: SshEndpoint, verify(fingerprint): boolean): Promise<SshSession> }
// SshEndpoint { host, port, username, privateKey }. SshSession: home, exec(command, { onData, signal?, timeout? }),
//   realpath, lstat (undefined when missing), readFile, readHead(path, n), check(path, "r" | "r+"),
//   writeFile(path, content, mode?), chmod, chown, rename (posix-rename where it can), unlink, close, onClose.
//   A missing path rejects with RemoteMissing (isMissing(err)).
sandboxedTransport(sandbox: () => HelperSandbox): SshTransport  // the only client; Workspace.sshTransport (WorkspaceOptions.sshTransport for tests)
// HelperSandbox { exclude, front?, frontHosts?, bwrap?, pasta?, refused? }: refused (the self-test's reason) fails the call
helperSandbox(address, port, sandbox): Sandbox           // the helper's sandbox: no workspace, that address and port only
forThread(t)  // { target(machine?), settings(), machines(), proxmox(machine, action, vm?), allowedInThread(machine, command), setMode(), network(), folders(), recordChange() },
              // each read fresh; settings() is effective
changes(userId): FileChanges              // her write and edit calls' changes, for removing turns
targetFor(t, machine?): ExecutionTarget  // the sandbox, or an SSH machine the thread may use now (a Proxmox one is refused)
machinesFor(t): ThreadMachine[]           // { name, kind, limit, root }: granted by it and every ancestor, of its pool
proxmox(t, machine, action, vm?): Promise<string>  // one PROXMOX_ACTIONS call on a thread's Proxmox machine, token sent only to the pinned certificate
callMode(t, machine?): PermissionMode     // on a machine, stricterMode(effective(t).mode, its limit)
probeMachine(userId, login, { kind?, name, address, draft? }): Promise<MachineProbe>
  // SSH: a key pair kept in memory for an hour (by `draft`), its keyLine and setup steps, the host key seen,
  // whether the login worked, offNetwork. Proxmox: the certificate's fingerprint and the pveum setup, no token sent.
  // Saves nothing.
addMachine(userId, { kind?, name, address, root, pool, limit?, draft? | token?, hostKey, offNetworkConfirmed? }): Promise<MachineConfig>
  // Proxmox: tries the token against the confirmed certificate and refuses the Proxmox running Lyrica (ownNode)
updateMachine(userId, name, { address?, root?, limit?, pool? }): Promise  // a new pool drops the machine from every thread; Proxmox: own-node address refused
setHostKey(userId, name, hostKey, token?): Promise / confirmOffNetwork(userId, name) / removeMachine(userId, name)
grantsFor(t): Grant[]                     // { path, writable }
folders(t): string[]                      // grants, and "<machine>:<root>" for its machines with a root
network(t): Network
inheritSettings(parent, childThreadId, narrower?)  // subagents and child threads: same or stricter (folders, network, mode, webSearch, images), never wider
settings(userId).detach(threadId)          // a kept child, once its parent is forgotten: no longer narrowed by it
// Planned (Projects): inheritSettings also grants a project's thread its project chat's folder (read-only for a read-only thread)
settings(userId): WorkspaceSettings       // per-pool defaults, per-thread overrides, machines
// MachineConfig { name, kind: "ssh" | "proxmox", host, port, username (Proxmox: token id), privateKey (Proxmox: the token),
//   root (Proxmox: null), hostKey (Proxmox: certificate fingerprint AB:CD:…), pool,
//   limit: "ask" | "acceptEdits" | "auto" (new machines "ask"), offNetwork, lastUsed,
//   state: { kind: "online" | "unreachable" | "keyChanged", since } | null }
// settings(userId).machines() / machine(name) / addMachine(m, confirmedHostKey) / updateMachine / setMachinePool(name, pool)
//   / setHostKey / setOffNetwork / confirmOffNetwork / machineState(name, kind) / removeMachine / allowInThread(threadId, machine, command) / allowedInThread(threadId)
// A thread's `machines: string[]` (the sandbox is always there); setThread refuses a machine of the other pool;
//   inheritSettings takes a subset; effective() keeps only machines every ancestor grants.
// SUSPECT_COMMANDS, suspectCommand(command), onFloor(path), cleanOutput(onData), maskKeys(buf),
//   authorizedKeysLine(publicKey), machineSetup(account, keyLine): core/src/workspace/machines.ts
// proxmox.ts: PROXMOX_ACTIONS (status, list, start, stop, shutdown, reboot, snapshots), PROXMOX_READS, PROXMOX_SUSPECT (stop, reboot),
//   suspectKey(tool, input) (what Allow in this thread stores), proxmoxAction(call, action, vm?), ownNode(call, addresses, self), ownAddress(addresses, self),
//   proxmoxSetup(), parseProxmoxAddress, tokenId, certFingerprint. ProxmoxTransport { fingerprint(host, port), call(endpoint, method,
//   path, verify(fingerprint)) }; `proxmoxHttps` is Node's TLS; WorkspaceOptions.proxmoxTransport and .self replace them.
settings(userId).defaultMode() / setDefaultMode(mode)  // the mode new threads start in (default auto)
settings(userId).startThread(threadId, pool)           // fixes the default mode on a new thread
settings(userId).effective(threadId): ThreadWorkspace  // strictest mode and switches of it and its ancestors
allowedPaths.allow(actor, userId, pool, path) / disallow(...) / list(userId)
saveUpload(t, name, bytes): Promise<string>  // cleans the name (cleanUploadName), never overwrites
mountHome(userId) / unmountHome(userId)   // gocryptfs; mount when the user's key becomes available
selfTest(): Promise<string | undefined>   // lyricad calls this at startup
```

- Every sandbox run receives exactly the thread's grants, the thread's folder
  in the home workspace, and a read-only system.
- **Workspace settings live in the user's `user.db`:** each thread's grants,
  network switches, permission mode, `webSearch` and `images` switches and
  machines and allowed suspect commands, and the machines. Allowed
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
- **Machines API:** `lyricad`'s `/api/u/:userId/machines` (`GET`; `POST
  …/machines/probe` for the Test step; `POST …/machines` to confirm;
  `PATCH …/machines/:name` for address, root, pool and limit; `POST
  …/machines/:name/key` with a confirmed host key; `POST
  …/machines/:name/confirm-off-network`; `DELETE`). A machine carries
  `state` (`online`, `unreachable` or `keyChanged`, with `since`) once a
  connection has been tried. Thread settings carry
  `machines`; permission events carry `machine`, `cwd`, and for a suspect
  command `suspect: true` and `warning`; an answer may carry
  `allowInThread: true`. Proxmox: `kind: "proxmox"` on probe and confirm,
  `token` in place of `draft`, the certificate's fingerprint as `hostKey`;
  `MachineInfo` has `tokenId` and no `keyLine`; `…/key` may take a new
  `token`; a `proxmox` permission event has no `cwd`.
- **The `proxmox` tool** (`extension/src/proxmox.ts`) is a schema plus one
  call to `ThreadTools.proxmox`; the workspace extension's `tool_call` does
  the asking (reads like `read`, start and shutdown like `bash`, stop and
  reboot suspect, Plan mode reads only). `destroy` is never offered.
- **SSH helper:** the SSH client runs in a sandboxed helper process per
  connection (`core/workspace/ssh-helper.ts`, behind `sandboxedTransport`),
  given one machine's key on its stdin and network to that one address and
  port through the existing nftables rules; it speaks length-prefixed frames
  (`ssh-frames.ts`). The host key decision stays in `lyricad`; strict key
  exchange is required. There is no in-process client.
- **Modes:** `PermissionMode` is `"auto" | "acceptEdits" | "ask" | "plan"`,
  strictest first plan, ask, acceptEdits, auto. Stored `ask-changes` and
  `ask-commands` migrate in place to `ask` and `acceptEdits`. A thread with
  no row is `auto`. A thread's ancestors changed later still narrow it, at
  any depth, because `effective` is read at each call.
- **File changes** (`FileChanges`, `FileChange`, `NewChange`, `sha256`):
  `user.db` `file_changes` holds each change's thread, tool call, target,
  path, whether it created the file and the hash it left, never content. A
  changed file's earlier content is a snapshot in the encrypted home
  workspace's `snapshots/`. Target operations' `writeFile` takes `string |
  Buffer`, so a snapshot is put back byte for byte.
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
