# Contracts

These are the interfaces between components, as built. Feature
threads build against them. If a thread needs a contract to change, it says so
in its pull request, and the design thread updates this page. Signatures are
sketches; names may move, but the boundaries may not.

## Stack and layout

- TypeScript (ESM) on Node 24 LTS (22.12 or later still runs it), using npm workspaces.
- Pi pinned exactly: `@earendil-works/pi-coding-agent@1.4.0`.
- SQLCipher through `better-sqlite3-multiple-ciphers`. Argon2id through
  `@node-rs/argon2`.
- Tests with `vitest`. Type checks with `tsc --noEmit`.
- The web UI is React with TypeScript, built with Vite.

```text
core/        keyring, users, stores, model router (no Pi dependency)
extension/   the Lyrica Pi extension (depends on core)
daemon/      lyricad: auth, session hosting, HTTP/SSE API, scheduler
host/        the model host: a Docker Compose stack for a GPU machine
web/         web chat, control panel, memory browser, sleep sidebar
persona/     seed, imported into self.db on first run
bin/         launchers and admin commands
evals/       continuity and tool-use scenarios, run with `npm run evals`
```

## Vocabulary

| Term | Meaning |
|---|---|
| **User** | One account with its own login and data: one of the owner's, or another person's. Either an administrator or a normal user. Linked users belong to the same person. |
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
new Keyring(home, argon2?, kdfIter?)                      // tests only pass cheap Argon2 and kdfIter 1
unlockSelf(passphrase: string): Promise<void>            // self.db only
unlockUser(userId: string, password: string): Promise<void>
saveUserKey(userId) / forgetSavedKey(userId) / hasSavedKey(userId)   // "save credentials"
saveSelfPassphrase(p) / forgetSelfPassphrase() / hasSavedPassphrase()
changeSelfPassphrase(current, next): Promise<void>        // rekeys self.db; wrong current is WrongPassword
unlockSaved(): Promise<boolean>                           // at start: the saved passphrase
loadSavedKey(userId): Promise<boolean>                    // at start: each saved user key
closeSelf(): void                                         // locks self.db again
// core/src/bootstrap.ts:
bootstrap(keyring, { passphrase, name?, seed, admin: { login, password, profile } }): Promise<User>
  // self.db, the persona seed, self.name, the first administrator (key in memory); admin init and
  // POST /api/setup both call it; on any failure self.db and users/ are removed
// core/src/persona.ts: selfName(self) (default "Lyrica"), setSelfName(self, name), checkName(name) (1–40, one line)
// CORE_LIMIT (12,000 characters of SOUL, STYLE and REGISTER as coreText joins them, measured with a 40-character name);
// PersonaStore.apply and PersonaProposals.propose refuse a core file that would go over it
hasUserKey(userId: string): boolean
subkey(userId: string, purpose: "pool:general" | "pool:private" | "home"): Buffer  // HKDF-SHA256
lockUser(userId: string): void
```

- Pool databases (Memory) and the encrypted home workspace (Workspace) each
  use their own `subkey`. Never use the raw data key for them.

- Each user has a random 256-bit data key, wrapped by Argon2id of their
  password. Changing the password rewraps the key. The data is never
  re-encrypted for a password change.
- self.db's passphrase goes through SQLCipher's own key derivation (PBKDF2,
  256,000 rounds). Tests set `kdfIter` (and `LyricadOptions.kdfIter`) to 1
  so each open is quick; a self.db opens only with the count it was made
  with. Nothing outside tests sets it.
- Keys live only in daemon memory, or in systemd credentials when saved:
  sealed with `systemd-creds encrypt --user` (systemd 256 or later), the
  secret on stdin. At start lyricad runs
  `systemd-creds decrypt --user --name=lyrica_<name> <file> -`, reading plaintext only from stdout into
  memory. Missing, failed or empty credentials stay locked; logs contain
  only the credential name/id and error class, never stderr or secrets.
- Wiping memory (`POST /api/u/:userId/admin/wipe` with `WipeRequest { password, understood, keepSkills? }`, administrators, the administrator's own password; `GET` the same path for what still runs; `lyrica admin wipe` while lyricad is stopped) answers `WipeResult { wiped, busy: WipeBusy[] }`. While anything runs it only sends stops (`wiped: false`); otherwise core's `wipePools(keyring, users)` deletes every pool and marks every user, `finishWipe(self, userId, userDb)` clears `WIPED_USER_TABLES` once their key is here, and `homeWiped` clears the home mark once their thread folders are gone (`wipePending`, `homeWipePending` read the marks). `KEPT_USER_TABLES` names the rest; a new user.db table goes in one of the two. `POST`/`GET /api/u/:userId/me/wipe` (any user, their own password) is the same for that user alone, through `wipePools(keyring, users, userId)`. With `keepSkills`, `wipePools(…, keepSkills)` sets each pool aside as `<pool>.keep.db` and `Memory.carrySkills(userId)` (called by lyricad's finish, at once or at the next unlock) copies its active skills into the fresh pool with `SkillLibrary.restore` and deletes it. See [daemon.md](daemon.md#wiping-memory).
- Deleting a user (`POST /api/u/:userId/admin/users/:targetId/delete` with `DeleteUserRequest { password, understood }`, administrators, the administrator's own password, never themselves; `GET` the same path for what of theirs still runs; `lyrica admin user remove <login>` while lyricad is stopped) answers `DeleteUserResult { deleted, busy: WipeBusy[] }`. While their work runs it only sends stops (`deleted: false`); otherwise lyricad locks them, `Users.deleteUser` removes every self.db row naming them, `Keyring.dropSavedKey` removes a saved key, and `Users.removeUserFiles` removes `users/<id>/`, retried at the next unlock if it fails. See [daemon.md](daemon.md#deleting-a-user).
- Changing the self.db passphrase (`POST /api/u/:userId/admin/passphrase/change` with `PassphraseRotate { current, next }`, administrators; `lyrica admin passphrase`) rekeys self.db in place and re-saves a saved passphrase (if the re-save fails, the saved copy is removed and the response carries a note to save it again); a wrong `current` is `403`. See [daemon.md](daemon.md).

## core/users

```ts
class Users {
  createUser(login, password, profile: Omit<Profile, "previousNames">, { admin }): Promise<User>  // first user must be admin
  authenticate(login, password): Promise<User>               // also unlocks the user's key; Argon2 runs for unknown logins too
  changePassword(user, oldPassword, newPassword): Promise<void>  // rewraps the same data key; clears passwordSetBy
  setPassword(actor: User, actorPassword, target: User, newPassword): Promise<void>  // admin, confirming their own password (AuthError); the key from its recovery copy, under the new password; NoRecoveryCopy if none yet
  checkPassword(user: User, password): Promise<boolean>     // is it theirs; unlocks nothing
  passwordSetBy(userId): { by?; at } | undefined             // an administrator set it and the user hasn't changed it since; no `by` once that administrator is deleted
  ensureRecoveryCopy(userId): void                           // writes the copy for a user from before, once their key is in memory
  setAdmin(actor: User, target: User, admin: boolean): void  // refuses to demote the last admin
  updateProfile(actor: User, target: User, change): Profile  // self, or an admin; a rename appends to previousNames
  listUsers(actor: User): User[]                             // admins see everyone, others themselves
  checkDelete(actor: User, target: User): User               // Forbidden unless an administrator deletes another user, so one always remains
  deleteUser(actor: User, target: User): void                // one self.db transaction, secure delete on: the row (wrapped key, recovery copy) and every row naming them; marks them in `delete.pending`
  pendingDeletes(): string[] / removeUserFiles(userId)       // deleted users whose `users/<id>/` is still on disk; removes it (home unmounted) and clears the mark
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
  timeZone?: string;                         // IANA name ("Europe/Vienna"), checked by checkProfile; unset: the server's
}
```

- **Where things live.** `self.db` holds a `users` index: login, admin flag,
  profile and wrapped key. It also holds global `settings` (such as
  `sleep.time`), the persona's revisions, `user_links`, and the
  `persona_proposals` that users have sent on (`PersonaStore.proposals`,
  `decide`).
  - The wrapped key has to be readable before the user's own databases can
    open. Beside it, `recovery_wrap`: the same data key under the server's
    recovery key (`settings` 'recovery.key', made once), so an administrator
    can set a new password without losing data (DESIGN.md, "Users"). A user
    from before gets theirs the next time their key is in memory.
    `password_set_by` and `password_set_at` record an administrator's reset
    until the user changes the password. Schema changes are migration steps
    (`core/migrations`, "Schema versions").
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
- `subj` is used only in live prompts (for example, "Sam's pronouns are
  they/them"). It is never substituted into stored memory.

## core/shares

```ts
class ThreadShares {                                          // thread_shares in self.db: a copy in transit between two users
  send({ from, to, title?, pool, unlogged, localOnly, entries: ExportedEntry[] }): string  // refuses from === to; a private thread is local-only
  forUser(to): PendingShare[]                                 // { id, from, to, title?, pool, unlogged, localOnly, entryCount, createdAt }, newest first
  get(id, to): ShareContents | undefined                      // with its entries; the recipient only
  remove(id, to): boolean                                     // accepted or declined
}
```

- `thread_shares` is self schema step 2 (`core/migrations`, expand only;
  `THREAD_SHARES_SCHEMA` in `core/src/db.ts`).
- The entries are what `exportEntries` gives: the conversation alone. The
  recipient's `lyricad` imports them into a thread of the pool they choose; a
  private share goes only to Private, and a local-only share's copy is
  local-only (`core/models.setLocalOnly`).

## core/mentions

```ts
toStored(text: string, speaker: UserId): string              // {user}, {user:obj}… → [[u:ID]], [[u:ID:obj]]…
render(text: string, profiles: (id) => Profile | undefined): string   // tokens → current names and pronouns; a deleted user → FORMER_USER ("a former user"), they/them
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
  - Example: with a user named Al, "Al-ion battery" must still match notes that say "Al-ion".
  - `queryTokens` returns the name matches found in the query, as names and
    user IDs. The Memory thread builds the full-text query from them, as
    word OR token.

## core/store: the privacy boundary lives here

```ts
class Memory {                                // new Memory(keyring, users)
  openThreadView(userId, pool): PoolView      // conversations, tools and sleep
  openOwnerView(userId): OwnerView            // memory browser only
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
| Threads | `createThread({ interface, parent?, subagent?, child?, unlogged?, title?, project?, goal? })` (a child of a child is refused), `setProject`, `foldThread(projectId, threadId, childrenOnly?)` (existing children become project siblings, preserving entries, steps and wake-ups), `setGoal`, `projectOf`, `projectThreads`, `listThreads({ includeHidden?, parent?, children? })` (`children: true` lists the non-subagent daughters), `getThread` (`Thread.child`), `setHidden`, `setUnlogged`, `appendEntry(threadId, { piId, role, data, text })`, `loadEntries`, `entryWindow`, `entryPage` (entries carry `pinned`), `setTitle`, `exportThread`, `forgetThread(id, author, { children?, keepMemories? })` (forgets its subagents' threads; other daughters go too with `children`, else they are kept with no parent and `child` cleared; `keepMemories` removes no notes or project page and leaves a text-free thread tombstone `t:<thread>` in each forgotten thread's place), `getThreadTombstone(id)` → `{ deletedAt } \| undefined`, `citingThread(id)` → the IDs of the notes and pages citing the thread or its entries, `branchThread(threadId, n, { title? })`, `truncateThread(threadId, fromN, author)` → `{ removed, pins, subagents }`, `subagentsSince(threadId, fromN)`, `copyEntries(from, to, { upTo? })` (a thread's entries into another, for forks and branches), `exportEntries(threadId)` → `ExportedEntry[]` (the conversation alone, for Share with: `conversationOnly` drops her context, memory tool calls and results and thinking, and strips citations; `MEMORY_TOOLS` names the tools), `importEntries(threadId, entries)` (into an empty thread of this pool, as its own, indexed, entries), `entriesMentioning(needle)` → `{ thread, n }[]` (where an upload is still mentioned), `countEntries(threadId, role)` (such as its compactions) |
| Pins | `pinEntry(threadId, n, pinned)`, `pins(threadId?)` → `PinnedEntry[]` (one thread's, or the pool's), oldest first |
| Reactions | `react(threadId, n, emoji, by, on)` → `Reaction[]` (`{ emoji, by: string[] }`, `by` user IDs or `LYRICA_REACTS`); `entryPage` entries carry `reactions`. Pool schema step 2 (`entries.reactions`, JSON) |
| Skills | `skills` → `SkillLibrary` for this pool (core/src/skills.ts): `all()`, `active()`, `read(name)`, `byCall(call)`; a store's also `put(input)` (the person's, active at once), `propose(input, thread, call, autoApprove)` (hers: active with auto-approve, else waiting beside the active one), `approve(name)`, `decline(name)`, `remove(name)`, `importSkill(draft)` (theirs and active; `{ name, duplicate }`, renaming to `name-2` rather than replacing anything). `exportSkills(skills)`, `parseSkills(text)` and `importSkills({ general, private }, texts, pool?)` move them as Markdown (docs/briefs/skills.md, "Export and import"); lyricad's `GET …/skills` → `Skills`, `POST …/skills` (`SkillChange`) → `SkillInfo`, `PUT …/skills/auto-approve` (`SkillsAutoApprove`), `POST …/skills/:pool/:name/approve|decline` and `DELETE …/skills/:pool/:name` (each → `Skills`) reach a shown pool's store through its thread view (docs/daemon.md, "Memory browser and settings"); `POST …/skills/export` → `SkillsExport` and `POST …/skills/import` (`SkillsImport`) → `SkillsImportResult` use them through the owner view. `checkSkill` and `SKILL_LIMITS` (name 64, description 200, body 8000, 100 per pool). Pool step 10 adds `skills` |
| Code tasks | `codeTask(threadId)` → `{ task, done, at }` or undefined; `setCodeTask(threadId, task, done = "")` replaces it (300 / 1,200 characters), with credential removal. Pool step 9 adds `code_tasks`, deleted with the thread; no task text enters user.db |
| Drafts | `draft(threadId)` → `{ text, updatedAt }` or undefined, `setDraft(threadId, text)` (empty deletes it); one per thread, gone with the thread. Pool schema step 3 (`drafts`) |
| Projects | `pageForProject(threadId)`, `projectNotes(threadId, since?)` |
| Current notes | `notesSince(since)`: notes not superseded or archived, written at or after `since`, oldest first (the wake phase's notes since the last WAKE) |
| Writing memories | `addNotes(notes, { author, thread? })`, `supersede(old, by, author)` (marks existing notes replaced by a current note and flags pages citing them; deletes nothing, so no tombstone; never a user's note unless a user does it), `pruneSuperseded(before)` → count (sleep removes superseded notes, not a user's, edited by one or archived, that nothing but their replacement cites, whose replacement was written before `before`; no tombstone), `putPage` (sleep and user pages), `putWake`, `addJournal`. Every write (notes, pages and edits, WAKE, journal, sleep items, project instructions) passes text, title, summary and tags through `removeSecrets` (core/src/secrets.ts) first; matches become `[secret removed]` |
| Any memory, by ID | `get`, `edit`, `restore`, `archive`, `delete`, `deleteMany` |
| Reading for the prompt | `getWake`, `pageIndex`, `forFolders(paths)`, `listJournal`, `journalHistory({ limit, offset, q })` → `{ entries, total }`, `userIntroduced` |
| Search | `search(query, { kinds, limit, current, excludeThread, fromThread, only, skip, minWords, said, vector })`, returning `{ id, kind, snippet, score, at, origin }` (`vector: { model, values }`: the query's vector; hits by meaning from `nearest(model, values, limit)`, cosine at or above `VECTOR_FLOOR`, join the keyword hits by reciprocal rank fusion, `RRF_K`, docs/memory.md "Recall by meaning"; `origin`: who wrote a memory, or `user` or `lyrica` for a user or assistant entry, unset for a tool result; a user-role entry lyricad wrote, such as a message from another of her threads, a watch, a wake-up or a routine, is `lyrica`; `at`: when an entry was said or a memory last changed; `skip`: words left out of the query; `minWords`: when the query has more words than that, a hit holds at least that many of them, each as the same word, its stem or a longer word starting with it (`sameWord`), a user's name counting once, and enough of its words that aren't common in the index, a word in more than 2% of it and 20 items being common; `said`: leave out tool results and match a message on its text, not its tool calls);  a store's `unembedded(model, limit, excludeThreads?)` → `{ id, kind, text }[]` (indexed items with no vector from `model`, never sleep's entries nor those of `excludeThreads`; a message by its spoken words, empty for one with none), `putVectors(model, [{ id, kind, vec? }])` (float32 vectors; `vec` left out marks an item skipped; another model's rows are dropped), `vectorCount(model)` → `{ done, left }`; `searchMessages(query, { limit, before?, threads? })` → `MessageHit[]` (`thread`, `n`, `role`, `text`, `createdAt`): the user's messages and her replies from the same index, every word of `query` as a word or a word's start (`searchWords`), newest first, before `before`, in `threads`; an entry a rewind removed while a branch keeps its copy is found at the copy |
| Lineage | `cameFrom`, `usedIn`, `revisions`, `revisionHistory(id, { limit, offset, q })` → `{ entries, total }` (newest first), `isTombstoned(entryId)`, `editedSince(since)` |
| Sleep runs | `startSleepRun`, `updateSleepRun`, `recordSleepRun` (a skip), `listSleepRuns`, `sleepRunHistory({ limit, offset, q })` → `{ entries, total }`, `getSleepRun`, `watermark`, `sleepMaterial(since, until)`, `sleepChanges(from, to)` |
| Sleep items | `addItem`, `listItems`, `getItem`, `startItem(id, threadId)`, `dismissItem`, `itemForThread`. Items, like the journal and WAKE, store `{user}` as a mention token, and the readers give it back as the name |

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
access to both of their own pools, for the memory browser.
It is never passed to the extension, a Pi session or sleep.
`exportMemories(owner, refs)` and `importMemories(owner, files, { pool?,
author })` move notes and pages in and out as Markdown, only through it;
`PoolStore.importMemory(id, body, author, createdAt?)` refuses a thread
view and a taken ID.

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
is refused; a branch of a plain thread counts as top-level, as it does in the
thread list; there is no way back). `Thread.project` and `Thread.goal`
(the user's text, so in the pool with the title; `setGoal`, at most 2,000
characters). A project's threads are its child threads; `projectOf(id)`
gives the project chat for the chat or any of its threads, and
`projectThreads(id)` the chat and its threads.
- `projectSlug(projectId)` names the project's page, `p:project-<id>`;
  `pageForProject(threadId)` returns it once it exists. A page's
  `instructions` (at most 2,000 characters) are kept apart from its text:
  only the user changes them (`setProjectInstructions(id, text, author)`
  makes the page if needed), and
  an edit by `lyrica` or `sleep` that changes them is refused. The user-text
  rule counts only user revisions that changed the text.
- `projectNotes(threadId, since?)`: current notes that cite the project chat
  or one of its threads, oldest first. Found by citation, never stored apart.
- `branchThread` of the project chat or one of its threads makes a thread of
  the project (`child`, parent the project chat), so depth stays 1.
- `forgetThread` on a project with `children` also forgets the project page
  and the notes that came only from it, unless `keepMemories` is set.
- `sleepMaterial` marks each thread of a logged project with `project`.

`lyricad` anchors such a branch where its source hangs, or for a branch of
the project chat where it branched (anchors live in `user.db`).

`SearchOptions.only: { project?: boolean; about?: string }` keeps the union
of project items (using `fromThread` and the same membership as the project
boost) and notes with the whole `about` tag, as `listMemories` matches it.
Filtering precedes the `limit * 4` candidate cut; batches widen past unrelated
hits. `{ project: true, about: "working" }` supplies the code-mode filter.
An empty project membership matches nothing, including in the other pool
read through `searchView`; only matching notes then pass.

## core/models: the cloud boundary lives here

```ts
type Task = "chat" | "code" | "subagent.cheap" | "subagent.strong" | "compaction" | "title" | "watching"
          | "embedding" | "sleep.consolidate" | "sleep.dream" | "sleep.wake" | "vision" | "image.create" | "image.edit" | "image.upscale" | "video"
          | "speech.transcribe" | "speech.speak";
// vision (Look at images): its own list only, of models with vision; no task follows it. A subagent whose model can't see
// an image switches to its first model up (with tools), else to a local model with vision (visionList, extension/src/delegate/runs.ts).
// code (Coding) defaults to { same: "subagent.strong" } in new tables and
// populated saved presets missing it, subject to the one-level Same as rule.
// A thread's code list wins; its chat override never supplies code's fallback.
type ThinkingLevel = "off" | "low" | "medium" | "high";
const DEFAULT_THINKING: ThinkingLevel = "medium";  // threads think at it unless the person chooses

interface Endpoint {
  id: string;                               // permanent (UUID); the name is a label
  name: string;
  kind: "cloud" | "local";                  // declared by whoever adds it, never inferred
  api: "openai-compatible" | "host" | "chatgpt" | "grok";  // a paired model host: always local; a plan: always cloud, never shared
  baseUrl: string; apiKey?: string;         // a host: its first address's /v1, and no key; a plan: PLAN_URLS[api], and no key
  signedOut?: boolean;                      // a plan whose refresh its provider (OpenAI or xAI) refused; the router skips it
  shared: boolean;
  addresses?: string[]; fingerprint?: string;   // a host's addresses, in order, and its pinned key
  unencrypted: boolean;                     // local, plain HTTP, outside this machine and the tailnet
  downSince?: string; stale: boolean;       // stale: unreachable for STALE_DAYS (14)
}
interface Capabilities { contextWindow?; tools?; vision?; embedding?; image?; edit?; upscale?; video?; animate?; motion?; reasoning?: ("low" | "medium" | "high")[];
                         transcribe?: boolean; speak?: { voices: Voice[] }; useFor?: "fast" | "quality" | "both" }
interface Voice { id; language }                             // language: a primary tag, "en" or "zh"
interface Offering extends Capabilities {   // one model on one endpoint, with a permanent id
  id; endpointId; modelId; manual: boolean;
  status: "listed" | "missing" | "gone"; missingSince?;      // gone: missing for GONE_DAYS (30)
  digest?; identity?: ModelIdentity; downloaded?; size?; recipe?; separate?;   // reported by a host; useFor inherited from Capabilities
  extend?; longestSeconds?; sound?;                          // a host video recipe that adds to clips (and chains them), its longest video, and whether it renders sound
  upscalesClips?;                                            // a host upscale recipe that upscales whole clips too (its listing does `upscale_video`)
  opensThinking?;                                            // a host's chat template writes <think> itself
  alwaysThinks?;                                             // LM Studio or OpenRouter says it can't turn thinking off
  price?: { input; output; reasoning?; cacheRead?; cacheWrite?; free };   // OpenRouter's pricing, US dollars per million tokens
  retiresAt?;                                                // OpenRouter's expiration_date
  maxOutput?;                                                // OpenRouter's top_provider.max_completion_tokens
  lmStudio?;                                                 // LM Studio listed it on its own API at the last discovery
  llamaServer?;                                              // a plain llama-server described it on /props at the last discovery: its one level is the template's switch
}
type ModelRef = { offeringId: string } | { groupId: string };
interface Group { id; name; shared; members: string[] }      // offering IDs, in order, one per endpoint
type Entry = ModelRef[] | { same: Task };                   // an ordered list, or another task's list
type Profiles = Partial<Record<Task, Entry>>;              // a preset's or column's table
type Column = "private" | "general";                       // the Tasks table's two columns
type PresetScope = "private" | "general";                  // what a preset may hold
interface Preset { id; name; scope: PresetScope; builtin: "local" | "cloud" | null; entries: Profiles; updatedAt }
interface ColumnState { column; preset: Preset | null; fromPreset: Preset | null; entries: Profiles }

interface CallContext {
  userId; pool; localOnly: boolean;         // always true for private
  preset?: string;                          // the thread's own preset; absent is its column. Ignored in private and local-only threads unless the preset is private
  overrides?: Partial<Record<Task, ModelRef[]>>;   // the thread's own lists, which beat the preset
  thinking?: ThinkingLevel;
  thinkingUnset?: boolean;                  // nobody chose the level (thread or user default): it is DEFAULT_THINKING
  fallback?: boolean;                       // Fallback; false: only a list's first entry answers; absent is on
  contextLimit?: number;                    // the most context the thread plans for, below its model's window; inherited by children
}
interface Need { tools?; tokens?; imageTier?: "fast" | "quality"; imageMask?; imageReferences?; animate?; motion?; extend?; seconds?; loras?: string[];
               first?: string[]; after?: string[] }   // what the call needs from a model; first/after: offering IDs tried before/after the list for one call
interface Resolution { ref: { offeringId }; endpoint; offering; label; profile: string;   // the preset's name, or "Custom"
                       source: "thread" | "preset" | "column"; skipped: { label; reason }[]; remaining: number }
interface Pace { promptTokens; readTokens?; outputTokens; window; ttftMs; genMs; processed }   // counts and times only
interface CallRecord { at; pool; threadId; task; offeringId; label; endpointName; kind; fallback?; note?; pace?: Pace; audioSeconds? }
interface AnswerSettings { temperature?; topP?; topK?; minP?; repeatPenalty?; presencePenalty?;
                           frequencyPenalty?; maxTokens?; seed?; stop?: string[];
                           voices?: Record<language, voiceId>; speed? }   // the last two for speak models
type SettingSource = "shared" | "yours";                   // absent: the server's default
type Hub = "huggingface" | "modelscope";
interface ModelIdentity { basename?; sizeLabel?; finetune?; baseModels?: { name?; organization?; repoUrl? }[]; card?: { baseModel?: string[]; baseModelRelation? } }
interface LibraryEntry { key; name; base?: { key; name }; starred; groups: string[]; copies: { offeringId; label; rawName;
                         endpointId; endpointName; kind; shared; status; downloaded; capabilities; groups; flagged?; size? }[] }
type Use = { where: "preset"; presetId; name; task } | { where: "column"; column; task }
         | { where: "thread"; pool; threadId; task } | { where: "workflow"; name } | { where: "group"; groupId; name };
interface CleanupItem { endpoint?; offering?; group?; label; usedIn: Use[]; otherUsers: number; suggestion?: { offeringId; label } }

class Models {                                              // new Models(keyring, users)
  // Endpoints and IDs
  addEndpoint(actor, { name, kind, baseUrl, apiKey? }, { shared? }): Endpoint   // shared: administrators only; baseUrl: no scheme → http:// (local) or https:// (cloud), no path → /v1
  editEndpoint(actor, id, { name?, baseUrl?, apiKey?: string | null }): Endpoint   // never touches an ID; not a host's URL or key
  removeEndpoint(actor, id)                                 // each model leaves a tombstone; for a host, this is unpairing
  endpoints(userId) / endpoint(userId, id) / offerings(userId, endpointId) / offering(userId, offeringId)
  label(userId, id) / find(userId, idOrLabel): ModelRef? / findEndpoint(userId, idOrLabel)
  addModel(actor, endpointId, { modelId } & Capabilities): Offering
  setCapabilities(actor, offeringId, { [cap]?: value | null }): Offering   // by hand wins over discovery
  // Discovery and health
  discover(actor, endpointId): Promise<Offering[]>          // GET /v1/models; a host's /host/v1/models and confirmed recipes
  probe(userId, endpointId, timeoutMs?): Promise<{ state: "up" | "down"; warning? }>
  pageStatus(userId, endpointId, budgetMs = 3000): Promise<{ state; warning?; status?; error?; unpaired? }>   // a probed cloud endpoint is asked at most every 90 s
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
  // Presets, columns, thread choices and resolve
  presets(userId): Preset[] / preset(userId, id): Preset | undefined
  addPreset(userId, { name, scope }, from: Column): Preset  // a new preset copying a column's table; it does not make the column follow it
  editPreset(userId, id, { name }): Preset / removePreset(userId, id)   // built-ins can't be renamed or removed
  savePreset(userId, id, column) / useColumnPreset(userId, column, id)   // Save to, and following a preset
  column(userId, column): ColumnState / setColumnTask(userId, column, task, value?: Entry | ModelRef)   // editing a followed column makes it Custom
  setThreadModel(userId, pool, threadId, task, list?: ModelRef[] | ModelRef) / checkThreadList(ctx, task, list): ModelRef[]
  setThreadPreset(userId, pool, threadId, preset: string | null) / threadPreset(userId, threadId)
  setLocalOnly(userId, pool, threadId, on) / forgetThread(userId, pool, threadId)
  callContext(userId, pool, threadId): CallContext
  childContext(parent, childThreadId, { tier } | { model }): CallContext   // a child under its parent's rules
  inheritContext(parent, childThreadId, { chat? }): CallContext          // a branch: the parent's local-only, preset, thinking, context limit and lists
  resolve(task, ctx, need?, { evenIfDown?, except? }?): Resolution   // throws CloudModelForbidden, NoModel or Offline
  resolveLive(task, ctx, need?, { probeMs?, probeLast? }): Promise<Resolution>   // probes first when there is a fallback; asks again before Offline
  callWithFallback(task, ctx, need, call: (r) => Promise<T>, { probeMs? }?): Promise<T>   // the next model on isUnreachable; Offline when none answers
  resolveModel(task, ctx, need?): { offeringId }             // resolve(…).ref
  allowed(ctx): { endpoint; offerings }[]                   // local endpoints only when restricted
  textModels(ctx): { id; label; local; vision; paid }[]    // allowed listed chat models, for her to name; paid: a known price that isn't free
  nextImageModel(ctx, action, need, afterEndpoint, noCloud?): Resolution | undefined // current task list; no probes; next eligible endpoint
  // Images (memory only; caller stores and records results)
  image(ctx, request: ImageRequest, { signal?, beforeSend?: (resolution) => Promise<void> }?): Promise<{ images: GeneratedImage[]; resolution }>
  // ImageInput { bytes: Uint8Array; type: "image/png" | "image/jpeg" | "image/webp" }
  // ImageRequest: create { prompt, tier: "fast" | "quality", size?: { width, height }, count?, references?: ImageInput[], loras?: LoraAsk[] }
  //   | edit { prompt, image: ImageInput, mask?: ImageInput, replace?: boolean, count?, references?: ImageInput[], loras?: LoraAsk[] }
  //     LoraAsk { name; strength: -4 to 4 } (at most MAX_LORAS, 4): need.loras skips a model that lacks one ("it takes no LoRAs",
  //     "it has no LoRA called …", and passedOver says so); the host gets the files matchLora finds in the offering's loras (its takesLoras)
  //     replace (with a mask): what's under it becomes something new; host recipes get it, cloud providers ignore it
  //   | upscale { image: ImageInput, scale?, maxSize? }; each has action: "create" | "edit" | "upscale"
  // GeneratedImage { bytes: Uint8Array; type: "image/png"; width; height; seed? }; no prompt metadata
  // Create passes imageTier to resolution: recipes and cloud offerings skip a useFor tag of only the other tier.
  // Edit passes imageMask: the ChatGPT plan, and a host recipe whose listing says mask: false, are skipped for masks before any input is sent.
  // Create and edit pass imageReferences (how many): a host recipe whose listing takes fewer, or a cloud adapter without references, is skipped before any input is sent.
  // CLOUD_IMAGE_PROVIDERS selects by endpoint.api: openai-compatible (key, any marked model) or chatgpt (the user's own Codex, setCodexImages).
  // A chatgpt plan's only image offering is PLAN_IMAGE_MODEL ("chatgpt-images", recipe "ChatGPT Images"), made by codexImage.
  // Each adapter declares create/edit/mask/references/sizes/count and low/high tier mappings; upscale is host-only.
  // Content refusal throws HostRefused("image_refusal", fixed message; codexImage quotes Codex's declining reply) and stops fallback. Limits/outages fall back.
  // Cloud useFor/image/edit are offerings.hand JSON in self.db (shared) or user.db (personal); no schema step.
  // beforeSend runs on every resolved attempt, including fallbacks, before any image or prompt is sent; a refusal stops the call.
  // Videos (memory only; caller stores and records results)
  video(ctx, request: VideoRequest, { signal?, beforeSend?, onProgress?, first? }?): Promise<{ video: GeneratedVideo; resolution }>
  // onProgress (image() takes it too): JobProgress { queued; progress?: 0-1; busyWith?; loading? } as a model host's job goes (models/progress.ts withProgress, exported):
  // the call carries X-Lyrica-Job: <random token> and GET /host/v1/jobs/<token> is read every 2 s until it ends; a host that
  // hasn't known the job after 5 reads isn't asked again. Cloud models report none.
  // VideoRequest { prompt; image?: ImageInput (its first frame, or with drive the subject who moves); drive?: Uint8Array (an MP4 of at most 64 MB, MAX_DRIVE_BYTES); extend?: Uint8Array (a clip to add `duration` seconds to, an MP4 of at most 64 MB, with no image, drive or size); size?: { width, height } (multiples of 16, 256-2048) or aspectRatio?: "width:height" (the recipe's area in that shape); duration?: seconds, 1 to LONGEST_VIDEO_SECONDS (60); steps?: 1-150, in place of the recipe's; loras?: LoraAsk[], as for images }
  // GeneratedVideo { bytes (H.264 MP4); type: "video/mp4"; width; height; frames; fps; duration; audio; seed?; poster: GeneratedImage }
  // The `video` task's list; only a model host's recipe that does `video` (or `animate`, with an image; or `motion`, with drive; or `extend`,
  // with extend) answers, so no clip or first frame reaches a cloud model. A recipe whose `longestSeconds` is under `duration` is skipped
  // ("it makes videos of at most N s"); a host recipe that chains clips (MiniMax H3) answers up to 60 s as one clip.
  // POST /host/v1/videos/create with explicit fields only; two hours at most, per 5 s asked (videoTimeout), since a chain gives each clip two hours.
  upscaleVideo(ctx, request: VideoUpscaleRequest { video: Uint8Array (an MP4 of at most 64 MB); scale?: 1-4; maxSize?: 256-8192 }, { signal?, beforeSend?, onProgress?, first? }?): Promise<{ video: GeneratedVideo; resolution }>
  // The `image.upscale` task's list; only a host recipe that lists `upscale_video` (Offering.upscalesClips) answers ("it doesn't
  // upscale clips"). POST /host/v1/videos/upscale with explicit fields only; two hours at most (VIDEO_TIMEOUT_MS).
  firstVideoModel(ctx): { name; longestSeconds?; extend; sound } | undefined   // the Videos list's first usable model, for the image tool's duration and prompt; no call
  loraModels(ctx, "image.create" | "image.edit" | "video", asks: LoraAsk[]): { ids; names }   // local models taking every LoRA asked, list order first, for `first`; names: every LoRA they take (loraName); no call
  imageModels(ctx): { name; actions: ("create" | "edit" | "upscale")[]; references? }[]   // the models on the Images lists that can do their task, for the image tool's model field; no call
  // Thinking and call records
  defaultThinking(userId) / setDefaultThinking(userId, level) / setThinking(userId, threadId, level | null)
  thinkingFor(resolution, asked, unset?): { level; note? }   // asked defaults to DEFAULT_THINKING ("medium"), also the per-user default; unset (CallContext.thinkingUnset) drops the can't-think note
  mandatoryThinking(offering) / mustThink(offeringId)   // a model whose provider refused thinking off: medium or the nearest level; in memory for the run
  sawThinking(userId, offeringId, { pool, threadId, task })   // a model with no levels thought anyway: clears the can't-think note on that call and drops it from later ones; in memory for the run
  recordCall(userId, { pool, threadId, task, resolution, note?, audioSeconds? }, { retry? }) / recentCalls(userId, { limit?, threadId?, threadIds?, pool?, speech?: false }): CallRecord[]
  callHistory(userId, { limit, offset, q, pools, threadIds? }): { entries: CallRecord[]; total }
    // GET models/calls/history?project=&pool= restricts both pool and project threads; hidden project pool is 404.
  recordPace(userId, threadId, pace, task?, pool?) / speedsByOffering(userId): Map<offeringId, { tokPerS?; promptTokPerS? }>   // medians over the last 20 calls
  usage(userId, pool, threadIds): { threadId; label; kind?: "local" | "cloud"; tokens; input; output; gpuMs?; cached?; measured? }[]
    // Calls plus durable folded counts plus subagent runs at every depth; pool AND thread filtered.
  addCallTotals(userId, pool, threadId, label, kind, input, output): void   // adds one call to call_totals; Claude Code's, counted by its relay
    // (RelaySpec/SandboxSpec.onUsage({ inputTokens, outputTokens, model? }) → Workspace onClaudeCodeUsage(t, usage)), as label
    // "Claude Code/<model>" ("Claude Code" when the answer named none), kind cloud
  // Hosts and pairing
  pairHost(actor, { name, addresses, code }, { shared?, endpointId? }): Promise<Endpoint>   // endpointId: pair again, IDs kept
  setHostAddresses(actor, id, addresses): Endpoint / fetchFor(endpoint): typeof fetch | undefined   // undefined for a plain endpoint
  hostStatus(userId, id) / hostControl(actor, id, "pause" | "resume" | "restart")   // hostControl answers the whole status after
  hostUpdate(actor, id, tag): Promise<HostStatus>   // tag: Lyrica's running update/… tag; a shared host needs an administrator
  // editEndpoint(actor, id, { name?, baseUrl?, apiKey?, paused? }): paused pauses a plain endpoint or plan (Endpoint.pausedAt); the router skips it
  // Speech: the only way audio reaches a model
  embed(ctx, texts, { query?, signal?, timeoutMs? }): Promise<{ model; vectors: Float32Array[]; resolution }>   // the Embeddings list, POST /embeddings (OpenAI shape), at most EMBED_BATCH texts; query wraps each in queryText; model is the offering's model ID; CloudModelForbidden, NoModel, Offline
  embeddingModel(ctx): { model; local } | undefined   // the model ID the Embeddings list resolves to and whether its endpoint is local, without calling it
  localOnlyThreads(userId): string[]        // the user's general threads switched to local-only
  transcribe(ctx, wav, { language?, signal? }): Promise<{ text; resolution; audioSeconds? }>   // in voiceContext(ctx); CloudModelForbidden, NoModel, Offline
  speak(ctx, text, { voice?, speed?, language?, signal? }): Promise<{ audio: ReadableStream<Uint8Array>; resolution; voice? }>   // raw PCM, SPEECH_FORMAT
  speechModel(task, ctx): { label; kind } | { reason: "none" | "down"; problem }
  // Settings
  offeringSettings(userId, offeringId): { values: AnswerSettings; sources: Partial<Record<keyof AnswerSettings, SettingSource>>;
                                          dropped: (keyof AnswerSettings)[]; defaults: ModelDefaults;   // the sampling the model reports as its own
                                          contextWindow: { value; source: "host" | "hand" | "discovered" | "assumed" } }   // assumed: DEFAULT_CONTEXT, 131,072
  refreshServed(userId, offeringId, timeoutMs = 1500): Promise<void>   // LM Studio's loaded context, parallel slots, vision and thinking, read again (before each turn, on Settings)
  rereadLocal(actor): Promise<void>   // the user's local endpoints discovered again, once per daemon run (lyricad, on the first unlock); shared ones as an administrator
  rereadDaily(now?): Promise<void>   // each endpoint not read for a day discovered again, for unlocked users with readDaily on; shared ones by an administrator (lyricad, hourly)
  readDaily(userId): boolean / setReadDaily(userId, on)   // Read model lists daily; on by default
  setOfferingSettings(actor, offeringId, change, scope: "shared" | "mine" = "mine")   // null clears a value
  // Library, tokens, downloads, delete
  textLibrary(userId, { search?, kind?, endpointId?, capability?, groupsOnly?, offset?, limit? }): { total; entries: LibraryEntry[] }
  star(userId, offeringId, on) / starredIds(userId): Set<offeringId> / notThisModel(actor, offeringId, separate = true)
  hubTokens(userId): { hub; shared; last4 }[] / setHubToken(actor, hub, token, { shared? }) / removeHubToken(actor, hub, { shared? })
  hubFiles(actor, hostId, { source, repo, revision? }) / startDownload(actor, hostId, body) / downloads(actor, hostId) / cancelDownload(actor, hostId, downloadId)
  deleteCopy(actor, offeringId, { confirm? }): Promise<{ usedIn: Use[]; deleted?: string[]; left?: { files; reason } }>
  imageLibrary(userId, hostId): { recipes; parts (by role) } / recipe(actor, hostId, recipeId, action)
  // Recipes live in the host's recipes.json; optional useFor: "fast" | "quality" | "both", absent reads as both.
  // recipe action { do: "change", change: { op: "useFor", useFor } } forwards to the host's PATCH and refreshes offerings.
  // Discovery caches useFor in offerings' existing found JSON; no database schema change.
  // Host management and serving
  manageHost(actor, hostId, method, path, body?)            // only models/load|unload|pin|reload, gpus/<n>, memory, scan, usage
  servingSettings(userId, offeringId) / setServingSettings(actor, offeringId, settings) / reloadModel(actor, offeringId)
  // settings may carry stretch: { type: "yarn"; factor; originalContext } (host models only); servingSettings returns
  // recommended: { native, stretched?, factor?, originalContext?, source: { hub, repo, revision, at } } | null
  lookupRecommended(actor, offeringId, repo?)               // reads the card through the host's fetch service; administrator (shared) or owner
  // setServingSettings(…, { anyway: true }) saves a stretch above the card's factor (host code above_recommended otherwise)
  hostCopies(actor, ctx): { offering, name, host }[]       // host chat models the actor can manage; [] for a private or local-only ctx
  localCopies(actor, ctx): { offering, name, host }[]      // LM Studio chat models on local endpoints the actor can manage; [] likewise
  localContext(userId, offeringId): { served?, max? } | null   // an LM Studio model's loaded context and maximum; null if not LM Studio
  loadLocalContext(actor, offeringId, contextLength)        // LM Studio: unload, load with context_length, discover; restores on refusal
  setContextLimit(userId, threadId, tokens | null)          // a thread's own context limit (thread_choices.context); ≥ 1024
  downloadHosts(actor, ctx): { id, name }[]                 // hosts her model_files and download_model reach; [] for a private or local-only ctx
  hostDashboard(userId, hostId): string                     // a direct link, at the address that last answered
}
// Also exported: CloudModelForbidden, NoModel, Offline (a NoModel: code "offline", task, tried), PlanWaiting (endpointId, until), isUnreachable(err),
// HostRefused (with `code`), PairingFailed, HostIdentityChanged, voiceContext(ctx);
// SPEECH_FORMAT (s16le, 24 kHz, mono), SPEECH_CONTENT_TYPE, MAX_CLIP_SECONDS (600), MAX_CLIP_BYTES, MAX_SPEAK_CHARS, wavData, wavSeconds, pcmSeconds, LANGUAGE;
// STALE_DAYS, GONE_DAYS, HEALTH_MS, CAPABILITIES, ANSWER_SETTINGS, TASKS, TASK_NAMES (each task in words, for messages), THINKING_LEVELS; isRestricted,
// checkTask, refId, baseName, acceptedSettings(endpoint), payloadFields(…); fingerprint, normaliseCode, pairingProofs,
// hostOrigin; probeUrl(baseUrl, apiKey, timeoutMs?, fetchImpl?), discoverModels, addressesOutside.
```

- **The boundary.** `isRestricted(ctx)` is `pool === "private" || localOnly`,
  and a private thread is always local-only (`setLocalOnly(…, false)` and
  `setThreadPreset` to a general preset on one throw). In a restricted
  context `allowed` returns local endpoints only, `resolve` uses the Private
  column whatever `ctx.preset` says, a group's cloud members are skipped,
  and a cloud model named directly throws `CloudModelForbidden`. Nothing
  falls back across the local/cloud line: outside a general column a list
  keeps to one kind (local where restricted, cloud in the Cloud preset,
  else its first model's). A private preset, and the Private column's
  Custom entries, refuse any cloud model or a group with no local member
  (`CloudModelForbidden`) on every write path, including `savePreset`,
  `replace` and `merge`.
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
  HEALTH_MS, and the host stays up for its others; so does `too_big`, a
  model its GPU can never hold, whose reason says retrying won't help); any
  other failure is thrown as is; when none answers it throws
  `Offline` naming every model tried, and never goes round twice.
- **Kind is pinned** where an endpoint is made: `addEndpoint` takes it as
  declared, `pairHost` makes a host local, `editEndpoint` can't change it,
  and `replace` and `merge` refuse to cross kinds. `probe` only warns when a
  local endpoint resolves outside loopback, private or tailnet ranges.
- **Subscription plans** (ChatGPT, Grok). `addPlan(actor, { name, plan, credential })` (personal only),
  `planCredential(userId, id)`, `planAccount(userId, id)` (explicit email or
  account ID only; never tokens), `setPlanCredential(userId, id, credential |
  null)` (null signs it out), `setPlanCatalog(list)` (discovery, from Pi's
  catalogue; set by `lyricad`), `setCodexImages(run)` (ChatGPT Images'
  runner, installed by lyricad: `codexImage` in the user's
  `Workspace.codexBox`), `reportPlanLimit(id, until?)` (limited
  until `until`; without one, an hour, doubled each time the plan is still
  limited within 15 minutes of the guess running out, up to six; a refusal
  during the wait keeps the guess) and `installationId()` (self.db). The
  sign-in is kept in the plan's `api_key` column as JSON; its tokens never leave
  core except into Pi's credential store (`PlanCredentials`, extension);
  image calls consume the resolved access token inside core/models.
- **Endpoint display.** `EndpointInfo` adds optional `keyLast4` (only a
  key longer than four characters, never a plan), `planAccount` (an explicit
  email or account ID supplied by sign-in, not decoded from a token) and
  `cloudCapabilities: ("Text" | "Vision" | "Image")[]` for cloud rows.
  Gone offerings do not count; Image needs a marked image/edit offering,
  its provider adapter and a key for an OpenAI-compatible endpoint. Grok
  has no image adapter. A plan's facts hide `PLAN_URLS`. Endpoint names
  accept letters, digits and `-`, up to 40 characters, preserving case.
- **What never crosses.** Full API keys stay in core (`EndpointInfo.hasApiKey`
  and its optional masked-display suffix `keyLast4`).
  Hub tokens leave core only as `X-Hub-Token` to a host, never in a response,
  log or call record. Call records hold model metadata, never prompt text.
- **Lists.** The entry that decides a task is the thread's list, else the
  thread's preset, else its column's, after one level of `same`, else
  chat's (not for `embedding` or the image tasks). `resolve` expands groups
  in place, follows redirects, drops tombstoned entries, and skips a model
  that is gone, on a stale or down endpoint, or unfit for the `need`
  (tools, context window, image or edit). `checkThreadList` and
  `setColumnTask` refuse a list the router would refuse, before anything is
  written.
- **Hosts** are called only through `fetchFor`: undici, with a connector that
  checks the pinned key before any byte is sent, no session resumption,
  addresses tried in order. A changed key ends the call with
  `HostIdentityChanged`'s message and marks the host down; `paused`, `busy`,
  `restarting`, `unavailable` and `unpaired` answers mark it down too. A
  `/v1` POST is tagged with `X-Lyrica-Job` (a random token unless the
  caller set one), so the host keeps it queued up to 15 minutes before
  `busy`; it and an image or video job have no limit on waiting
  for the answer's headers. A
  host's refusal is a `HostRefused` carrying the host's own `code`. Lyrica's
  key and certificate live in `self.db` (`host_identity`). `undici` 8.12.3
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
  `user.db`: the same first five (the user's own), `model_presets`,
  `model_columns`, `thread_models`, `thread_choices`, `local_only_threads`,
  `starred_offerings`, `model_calls` and `call_totals`, with the default thinking level
  and the notice in its `settings`. The legacy `model_profiles` and
  `thread_choices.profile` stay one release, kept in step by `syncLegacy`, so
  a rollback keeps the user's choices. Shared rows change only with an
  administrator actor. A `user.db` is migrated, has pending shared redirects
  applied, and is indexed into `shared_refs` the first time it is opened in
  a process.
- **Watching.** `watching` ("Watching threads") is a text task: a new
  preset starts it following `subagent.cheap`, and a stored preset with
  no entry for it reads as following `subagent.cheap` too (unless that
  itself follows another task). It is a thread task (`THREAD_TASKS` in
  daemon/src/api.ts) for project chats only: the project chat can choose
  its own, and `PATCH …/settings` choosing it for any other thread is 400.
- **Images in a thread.** `image.create`, `image.edit`, `image.upscale`
  and `video` are thread tasks too: a thread can choose its own model for
  each, as for the text tasks, and a private or local-only thread only
  local ones. The drawer's `video` row shows the first recipe that makes
  any kind of clip; each call still passes over one that can't make its
  kind.
  `TaskModel.name` is what to call the model (a recipe's name, else its
  model ID). `TaskModel.fallbacks` counts the models after the shown one
  in its list that could still answer (0 while Fallback is off); a thread's
  own pick is a list of one, so it replaces the preset's whole list.
  `ThreadSettings.thinkingSet` says whether the thread chose its
  `thinking`; false follows the user's default.
- **Speech.** `speech.transcribe` and `speech.speak` have lists of their
  own (neither follows chat) and take models with the `transcribe` or
  `speak` capability, reported by a host or set by hand. `transcribe` and
  `speak` follow the same boundary as `resolve`; `transcribe` runs in
  `voiceContext(ctx)`, so only the thread's own pick can be a cloud model.
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
  preparation).

## delegate

```ts
new Delegation({ users, memory, models, workspace?, cwd, limits? })  // one per lyricad
createDelegateExtension(thread, delegation, budget?)   // adds `delegate` (and `ask_parent` in a subagent)
delegation.events                                      // typed EventEmitter for the live view
delegation.store                                       // roles and saved workflows, in user.db
delegation.forget(userId, pool, threadId)              // before forgetThread: stops its runs
delegation.forgetSubagents(userId, pool, threads)      // before truncateThread: stops runs with a subagent among them
delegation.stopAll(userId?)                            // Lock and shutdown
delegation.stopRuns(userId, pool, threadId)            // Stop in a project chat: the runs it started
```

One model-facing tool: `delegate({ action?, ... })`.
The built-in coder comes first in its role list (strong, writes, high
thinking; read/write/edit/bash/recall/read_memory). It uses the parent's
`code` model list, preset and context limit, and project/filtered recall
through its existing thread view, without persona. A step's optional
`done` accompanies its task in the Code task section, and its optional
`title` (at most 60 characters) names its thread `<role>: <title>` in place
of the task's first line. Without a role, a
write-capable step in a repository thread selects coder; otherwise worker.
Custom roles override built-ins by name, except `claude`.
- The built-in `claude` role is Claude Code, not a Pi session
  (`extension/src/delegate/claude.ts`; docs/delegation.md, "Claude Code"):
  listed and allowed only where `delegation.claudeCode(thread)` (the
  thread's `claudeCode()`, and a `workspace.claudeDir`), refused with
  `internet: false`, always in the background. A `Subagent` works through a
  `SubagentBody` (`send`, `steer`, `abort`, `reply`, `dispose`): a Pi
  session's, or `claudeBody`'s one `claude -p --output-format stream-json` run
  per turn through `ExecutionTarget.run`, resumed with `--resume`, with
  `--model <alias>` and the asked role's prompt in its brief when it stands
  in for a step that named Claude (`SubagentRecord.pick` `{ claude }`).
- The default action runs work: `task` with an optional `role` and `tier`;
  or `tasks: [...]` (parallel), `chain: [...]`, `loop`, `council`, or
  `workflow: name`. Any of these can be `background: true` (always, in a
  project chat), and a run can set `workers` (1 to 8) when the person asked
  for more or fewer at once. A foreground run still working after
  `limits.foregroundMs` carries on in the background.
  She picks a tier; a step's `model` is only one the person or a saved
  workflow named, resolved by `Models.find`, else `matchModel` over
  `Models.textModels(ctx)`; a name that fits no one model fails with the
  closest; a cloud one with a local `sameModelName` twin runs on the twin unless
  `singledOut(the person's latest message, it, all)`. A name that
  `meansClaude` in words and isn't `namedOutright` runs on Claude Code where
  `delegation.claudeFor(thread, name)` says so, in the step's role; a cloud
  `isClaudeModel` named in words fails unless the person's latest message
  singles it out. `action: "models"` lists
  them local first, each local or cloud, with vision and paid where they apply,
  and Claude Code where the thread's runs have it.
  `folders` narrows granted host folders only, not sandbox repository paths;
  an invalid folder returns that distinction and advises omitting `folders`
  to read the parent's checkouts. Read-only roles, narrowed runs and writers
  in a worktree share those clones read-only, with the parent's repositories
  marked `readOnly` (the relay refuses a push or an API write); an
  unnarrowed writer keeps the parent's repositories. This does not change
  repository inheritance.
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
- **Routine tool** (`threads` in hosted threads): `action: "routine"`
  with `routineAction: "add" | "list" | "pause" | "resume" | "remove"`.
  Add takes `schedule`, `note`, optional `newThread` (false by default).
  `parseSchedule` validates it; `every` gets its `from` at creation.
  List returns only the calling thread's IDs, schedule descriptions, next
  times for active routines, paused state and destination choice, without
  notes. Pause, resume and remove take numeric `routineId`; tool mutations always include the
  calling thread ID. Add refuses more than 10 routines including paused
  ones. Errors return plain text with `isError: true`.
- **Routine storage and firing** (`core/src/routines.ts`,
  `daemon/src/routines.ts`): `parseSchedule`, `nextRun(schedule, after,
  zone?)` and `describe` supply wall-time schedule maths in the user's time
  zone (`core/src/zone.ts`: `zoneOf(profile)`, the server's when unset;
  `wall`, `zonedTime`, `localDate`, `localTime`). `addRoutine` and
  `pauseRoutine` take the zone; `rezoneRoutines(zone)` moves every
  non-`every` routine's next run when the user changes zone. Expand-only pool step 6 adds `routines`
  (`id`, `thread`, JSON `schedule`, `note`, `new_thread`, `paused`,
  `next_at`, `last_at`, `created_at`), encrypted with the thread's pool;
  forgetting its thread deletes it. `PoolReader.routines` includes paused
  routines; `PoolStore.addRoutine`, `pauseRoutine`, `removeRoutine` and
  `advanceRoutine` store and advance them. A fire sets `last_at` and adds a
  note-free fired row to `wakeups`, the shared rolling-day ledger:
  `wakeupsFired` counts both kinds against `WAKEUP_LIMITS.perDay`
  (24 per source thread). Expand-only pool step 11 adds nullable
  `wakeups.source`: `addWakeup(…, source?)` and `settleWatch` store CI and
  review wakes as `forge`, `Wakeup.source` carries it,
  `wakeupsFired(thread, since, source?)` counts one kind (unset: hers and
  routines'), forge wakes fire under their own `FORGE_WAKES_PER_DAY` (48),
  and `removeWakeups(thread)` without an id keeps them.
  `Routines.load` / `drop` enable / disable a user's firing at unlock / Lock;
  the daemon tick calls both schedulers unless an update drains. It sends
  `HostedThread.send(note, { routine: "[Routine, <describe>]\n\n" })`;
  ordinary messages cannot carry `ROUTINE`. A fresh thread stays in the
  same pool and project or thread list, inheriting source workspace and
  model privacy plus project new-thread choices. Queued threads, paused
  routines and paused or hidden projects wait. Routine turns share the
  child at-once budget; a working last run or daily cap advances without
  firing. Missed runs otherwise fire once with their due count. Wake-ups
  at the cap wait. Last-run destination tracking is in memory and is cleared on
  Lock or restart; interrupted turns do not resume after a restart.
- **Routine web routes**: `GET /api/u/:userId/routines` lists that signed-in
  user's routines across both own pools, sorted in the UI by pool and thread.
  `GET /api/u/:userId/threads/:pool/:threadId/routines` lists one thread;
  `PATCH …/routines/:id` with `{ paused: boolean }` pauses or resumes;
  `DELETE …/routines/:id` removes it. Both mutations return the thread's
  remaining list. `RoutineInfo` carries `id`, `pool`, `threadId`,
  `threadTitle`, `schedule` (the `describe()` text), `nextAt`, `paused`,
  never notes. Each route uses session/key checks and only the requested
  user's own thread view; an absent thread or a routine from another
  thread is 404; non-boolean `paused` is 400. `ThreadSettings.routines`
  carries the same metadata; web mutations publish the existing `settings`
  event to refresh open thread views. Stored routine messages have
  `from: { kind: "routine", schedule }` and their note as the text part,
  with the daemon's mark removed; live messages carry the mark until stored.
- **CI wakes** (`core/src/forge/{types,github,forgejo,decide}.ts`,
  `daemon/src/forge-watch.ts`, `core/src/workspace/relay.ts`): a pull
  request a run opens through its relay is watched and wakes its thread.
  `SandboxSpec` and `RelaySpec` gain `onPullCreate(pr: { repo, number })`,
  called once after a relayed `POST /repos/{owner}/{repo}/pulls` (GitHub)
  or `POST /api/v1/repos/{owner}/{repo}/pulls` (Forgejo/Gitea) succeeds,
  or a GitHub GraphQL `createPullRequest` mutation (`gh pr create`) whose
  answer's `pullRequest.url` is the credential's repository, passing only
  those two facts — never the request or response body. The relay asks
  upstream for an uncompressed answer on these requests, since gh's client
  asks for gzip.
  `Workspace.onPullCreate` routes it to `ForgeWatcher.record`, which stores
  a watch in pool step 7's `watches` table (thread, repo, kind, host,
  account, number, head, head_since, notified_heads, seen_reviews,
  webhook_at, created_at) through `PoolStore.addWatch`, at most 10 per
  thread (an eleventh is not watched; the thread is told once). A run in
  a subagent's thread records it for the thread that delegated to it, and
  a pull request already watched isn't added twice. `threads watch` with
  `pr` calls `ThreadsHost.watch(from, repo, number)` → `ForgeWatcher.watch`,
  which accepts only an open pull request of one of the thread's
  repositories with a usable account, and returns the line she is told;
  the action is offered only while `ThreadsHost.watchable(from)` is true.
  `notified_heads` holds keys `head:hash` of the finished checks' ids and
  results (or `head:none`), the last 50, so a re-run that finishes on the
  same head wakes again (a GitHub re-run is a new check-run id; a commit
  status, `gh:status:<context>`, keeps its id and counts only when its
  result changes); a bare head stored before counts
  as the set it next finds. GitHub snapshots also read
  `/commits/{sha}/check-suites`: a suite not yet completed that has runs
  is a pending check, and a `stale` conclusion reads as cancelled.
  `ForgeWatcher.load` / `drop` enable / disable polling at unlock / Lock;
  the daemon tick calls it unless an update drains. Each poll turns the
  forge's API pages into one snapshot with `githubPullRequest` or
  `forgejoPullRequest`, then `decideWatch({ number, account, now, last, poll })`
  returns `{ next, stop, note }`; `PoolStore.settleWatch` saves the next
  state (or removes the watch) and records the note's wake-up in one
  transaction, and the note fires as `HostedThread.send(note, { wakeup:
  wakeupMark(setAt) })` through the existing wake-up guards — never a body,
  never comment or log text. A merged or closed pull stops the watch
  with one note (`ended`), or silently when the watching account merged
  it (`mergedBy`). One request at a time per token; `Retry-After` and
  GitHub's `x-ratelimit-reset` are honoured; polling slows to 10 minutes
  while fewer than a fifth of the token's hourly requests remain, or after
  a webhook for that repository in the last 24 hours.
- **Forge webhook** (`daemon/src/lyricad.ts`): a Forgejo or Gitea account
  whose host resolves into her own network (10/8, 172.16/12, 192.168/16,
  100.64/10, fd00::/8 (with loopback and RFC 1918, as inOwnNetwork) — re-checked at each use) gets a Webhook row in its
  Settings drawer: `POST https://<tailnet-name>/hooks/forge/<account>` and a
  per-account random secret, stored like its token
  (`git_accounts.webhook_secret`). The route answers only on the
  `tailscale serve` listener (`Request.via === "tailnet"`), verifies
  `X-Forgejo-Signature` / `X-Gitea-Signature` (HMAC-SHA256, constant time)
  against that account's secret, reads the repository name from the body
  and drops it, then nudges `ForgeWatcher.webhook` to poll that
  repository's watches at once. Anything unsigned gets 401 and does
  nothing; a forged or replayed hook can at worst cause one extra poll.
- **Child threads** (`createThreadsExtension(thread, host?: ThreadsHost, meter?)`,
  never in a subagent's thread): one model-facing tool, `threads({ action,
  ... })`: `start` (`title`, `task`, optional narrower `folders`,
  `readOnly`, `internet`, `base: true` for a project’s original checkout, and `code: true` to start it in code mode; in a project a title matching an open thread's, or naming the same `#number`, is refused, naming it), `message` (to a child, by ID or current title
  (`pickThread`; a title two threads share is refused), or `to: "parent"`
  from a child; a child's message with no `to` and no `id`, or whose `id`
  names its parent, goes to the parent), `list` (`ChildInfo` with `ChildStatus`, and `worktrees` (branch and path) for a project thread's own worktrees), `read` (`id`,
  `last`: the latest messages of a listed, logged thread, or of one of her own subagents' threads (`PoolReader.latestEntries`), `READ_DEFAULT`
  10, `READ_MAX` 30, formatted by `formatEntry`; a parent's read of a child still working ends with `CHILD_WAKES`, as does `turn-tools`' refusal of a third identical `threads read`) and `stop` (`id`: a
  parent's child, `ThreadsHost.stop`), and `routine` (above). `later` (`minutes`, clamped to 1 to
  `WAKEUP_LIMITS.maxMinutes`, and `note`; or `cancel: true`) sets a
  wake-up for the calling thread through `ThreadsHost.later` /
  `cancelLater`: pool step 4's `wakeups` table (thread, due, note, set and
  fired times; a fired one keeps no note and goes after a day),
  `PoolStore.addWakeup`, `fireWakeup`, `removeWakeups`, `PoolReader.wakeups`
  and `wakeupsFired`. It fires as `HostedThread.send(note, { wakeup:
  wakeupMark(setAt, dueAt?) })`, marked `[Wake-up, set …Z(, due …Z)]`
  (`WAKEUP`), which only `lyricad` writes; `Message.from.kind` is
  `wakeup`. `ThreadSettings.wakeups`, `ThreadSummary.wakeAt`, the
  `wakeups` thread event and `DELETE …/threads/:pool/:id/wakeups/:id`
  carry times and IDs, never the note. A user's message that starts with
  the mark is refused (400). `steps` (`steps: ThreadStep[]`,
  `{ text, state: "todo" | "doing" | "done" }`, through `cleanSteps` and
  `STEPS_LIMITS`) replaces the calling thread's checklist in pool step 5's
  `thread_steps` (`PoolReader.steps`, `PoolStore.setSteps`) and calls
  `ThreadsHost.stepsChanged`, which publishes the `steps` thread event and
  tells the parent's card; `ThreadSummary.steps` and `ChildInfo.steps`
  carry it. It is offered only while `ThreadsHost.checklistsOn` is true
  (`Display.checklists`, default on; changing it reloads the user's
  sessions). Each thread is sent only the actions it can use and their
  fields (`paramsFor`): `start` and `stop` where it can start children,
  `suggest`, `fold`, `draft` and `reopen` only in a project chat, `list` and
  `read` everywhere but an ordinary child, `resolve` in a project chat and a
  project's thread, and only `message` (with `to` and `question`) in an
  ordinary child; `needsYou` only in a project's thread.
  Any other action fails Pi's validation. Its results
  and guidance mention threads as `[t:<id>]`. A child thread is
  `createThread({ parent, child: true })`, hosted like any thread, with the
  parent's pool, models (`models.inheritContext`) and workspace
  (`inheritSettings`), which can only narrow. `ThreadsLimits`
  (`DEFAULT_THREADS_LIMITS`): 3 starts per request, 6 for a thread whose
  model runs in the cloud (`cloudPerRequest`, `ThreadsHost.perRequest(from)`),
  and at most 32 children working at once per user, checked on start and when
  a parent's message wakes an idle child; child-triggered parent turns share this budget with routines. A
  parent's message is the child's next turn, marked with
  `fromParent(id)` (`FROM_PARENT`), which only `lyricad` writes; a child's
  update reaches the parent through `Delegation.deliver` as a notice with
  status `update`, and every delivery's details carry an `id`. A child on
  a task from its parent whose turn ends idle with an error, or without an
  update since the task, gets the parent the same kind of notice
  (`ChildThreads.ended`, fed by `lyricad`'s turn events); without an
  update, the notice carries the child's last assistant message (clipped
  to 4,000 characters, never an unlogged thread's) marked as its report. A child's
  `message({ to: "parent", text, question: true })` (a string `question` is
  sent as the message, after any `text`, and asked, except true, false, yes
  or no in any case, which are that boolean), a project's `needsYou`,
  its report when its turn ends idle, and the daemon's failure or
  didn't-start notes wake an idle parent for one turn. Plain progress and
  subagent results don't wake an idle parent. Child deliveries carry
  `childDelivery: true` so `deliverVia` appends them with `triggerTurn: false`;
  during a child-triggered parent turn `joinRunning: true` steers a question,
  `needsYou` or failure note into that turn; a report that comes during it
  wakes the parent again after. A report's wake waits `CHILD_WAKE_MS`
  (60 s, `LyricadOptions.childWakeMs`) from the first one, so reports close
  together wake it once; a question, `needsYou` or failure note starts it at
  once. `ChildThreads` coalesces pending/running wakes per parent,
  reserves an at-once slot, waits through project pause/hidden, and invokes
  `HostedThread.wakeChild`: a hidden custom message with `triggerTurn: true`,
  through the ordinary model preparation, turn events and storage. Pending
  wake metadata is in memory only; stored notices survive a restart.
  `noticed` prevents repeated error wakes until a child reports or the
  user writes there. `ChildThreads.watchIdle(now)`, called by the daemon
  tick unless an update drains, wakes an idle project chat with
  `IDLE_NOTE` through `wakeChild` (see docs/delegation.md, Idle projects);
  `ChildThreads.personWrote`, from lyricad's onTurn on a turn the person
  started, resets its count for that project. A reply from a child-triggered parent to its source
  child goes through `HostedThread.appendParent`, saved after the child's
  current turn without a turn or steer; the next turn reads it.
  `message` returns a `Delivery`: `started`, `running`, `queued` (an idle
  thread past the at-once limit: saved, woken when a slot frees), `saved`
  (a child-woken parent past `MAX_WAKE_ROUNDS` replies to its source child),
  or, to a parent, `wakes` or `update`. `HostedThread.childWakeTurn` marks
  the child-started turn whose replies count as rounds.
  Pending child wakes also wait while `ThreadHost.draining` is true.
- **Question cards** (principles 1 and 6): `threads({ action: "ask",
  question, options: { label, consequence }[], recommended, context? })` is
  offered in every hosted thread except an ordinary child, which asks its
  parent with `message({ question: true })`. Subagents have no `threads` tool.
  `ASK_LIMITS` and pure `cleanAsk` (`core/src/threads.ts`) enforce a question
  of 1–300 characters, optional context up to 1200, 2–4 options with labels
  of 1–40 and consequences of 1–200 characters, case-insensitively unique
  labels, and an integer recommended index in range. Strings are trimmed.
  `normalizeThreadArguments` (core) runs in the tool's `prepareArguments`,
  before Pi validates, and in `cleanAsk` when a stored call is read back.
  It accepts only: `options` or `steps` as a JSON string of an array; a
  `recommended` naming exactly one option's label; a bare-string step as
  `{ text, state: "todo" }`; and step state aliases (ignoring case:
  in_progress, in progress, active, started → doing; pending, not started →
  todo; complete, completed, finished → done); and an option label over 40
  characters, cut at the last whole word within 40 when its whole wording,
  a period and the consequence fit in 200 characters as the new consequence.
  A string over its limit gets an error naming the field, its length and the
  limit. Any other malformed `ask` or `steps` call gets an error naming the
  field and position, the received type (never the text), what is allowed,
  and one valid example.
  When a reply ends with a question next to 2–4 list items (before or after
  it), the thread can ask, no question is open and the run made no `ask`
  call, the extension sends one hidden follow-up (`lyrica-ask-nudge`,
  `display: false`, `deliverAs: "followUp"`) asking her to use a card if the
  choice blocks her. Context assembly drops it at the next turn (`dropNudges`).
  Ask once on the card, recommend the first option, continue reversible work
  on that option, and end the turn before an irreversible step. Answers
  arrive in later turns. Routine and wake-up turns may ask in their thread.
  Pool step 8 adds `questions(thread, n, asked, closed, answer)`: only a
  pointer to the tool call's entry and its times and outcome. Words are read
  from the encrypted log with `PoolReader.readAsk` (`askOfCall`: a `threads`
  ask's own words, or `rootAsk` for a `run_as_root` call, which
  `isQuestionCall` also counts as a question card); `questions` lists the
  states and `openQuestion` returns the open one. `PoolStore.askQuestion`
  withdraws a previous question; `closeQuestion` records an option index,
  `"words"` or `"withdrawn"`. At most one question is open per thread.
  A question change briefly attaches encrypted user.db to the pool
  connection: its pointer and `child_threads.needs_you` change in the same
  transaction. A project's ask sends its existing waiting notice and wakes
  the project chat; answering or withdrawal updates the parent's card at
  once. Resolve, the person's Stop and a parent's `threads stop` withdraw a
  question (`HostedThread.stop(true)`); lock, project pause, disposing an
  idle session and restarting the daemon preserve it. `needs_you` moves
  only when a question opens or closes, or when the parent messages the
  thread while no question is open (`ChildThreads.message`), so a status
  message's `needsYou` survives an edit or rewind. Removing its tool call removes the
  pointer with the turn.
  `ThreadSummary.question?: { n: number; asked: string }` carries only the
  open pointer. `MessagePage.questions?: QuestionState[]` carries the saved
  states (`n`, `asked`, optional `closed` and `answer`), including closed
  ones, so a log card can show its outcome. A new ask or close publishes
  settings/child refreshes to open views.
  `POST /api/u/:userId/threads/:pool/:id/questions/:n/answer { option }`
  returns 204, 404 for an unknown question or one in another thread, 409
  once closed, and 400 for an option out of range. It sends the chosen
  `<label>` as a user message prefixed `[Answer to q:<n>]` and starts a
  turn normally. `ANSWER`, beside `FROM_PARENT` and `WATCHING`, guards that
  prefix: only lyricad writes it, and typed/API messages starting with it
  are refused with 400 or `MarkedText` by `HostedThread.send`. The reader
  strips the mark for display; `Message.from.kind` remains `user`. A typed
  message closes an open question as `"words"` and keeps the text unchanged.
  `NotificationType` gains `question`, with id
  `question:<pool>/<thread>/<n>` and `decision: true`. Title is the question,
  detail the recommended option's consequence. Its actions POST to that
  answer route with `{ option }`, recommended first, then the others in
  order; its `thread` supplies Open thread. There is no bulk question action.
  Display filters apply as to other decisions, including the private pool.
  `NotificationType` gains `limit` (daemon/src/plan-waits.ts): id
  `limit:<endpoint>/threads` for the threads waiting on a limited plan (its
  `thread` when there is one, else `threads: { pool, id, title }[]`) and
  `limit:<endpoint>/sleep/<pool>` for sleep, each with `until` (the reset)
  and one action, **Fall back** (with a `title` tooltip; `NotificationAction.title?` is new): `POST …/endpoints/:id/fall-back` →
  `{ ok }` (404 for no such plan, 409 when it isn't limited), which makes
  the router skip the plan until it resets (`Models.fallBackFromLimit`,
  `planFallingBack`) and carries the waiting turns (`Wakeups.resumeNow`)
  and sleep (`Sleep.resumeWaiting`) on at once. `WakeupInfo.planLimit` marks
  a turn waiting for its plan; `ThreadSettings.planWait { endpointId,
  name, until, next?, claudeCode? }` names the plan and the model the thread would use.
  The user's Claude plan, which only Claude Code uses, has no endpoint: its
  limit is kept under `claudePlanId(userId)` (`claude-code:<user>`), set by
  the relay (`RelaySpec.onLimit`, a 429 with
  `anthropic-ratelimit-unified-status: rejected`; `Workspace` option
  `onClaudeCodeLimit`) or by a stopped claude run (`DelegationOptions.onClaudeLimit`).
  A thread waits for it with `WakeupInfo.claudeCode` (`CLAUDE_LIMIT_RESUME`);
  its wait and notification are named "Claude Code" with `next` "the coder
  role" and `claudeCode: true`, and its fall-back resumes only those
  wake-ups. `DelegationOptions.claudeRefused` refuses the claude role while
  the plan is limited.
  While a plan is limited and not falling back, `prepareTurn` throws
  `PlanWaiting(endpointId, until)` (core models) before any request; the
  hosted thread says the wait once, holds wakes and messages until just
  after `until`, and tells its parent through
  `ThreadsHost.planWaiting(userId, pool, thread, plan, until)`, once and
  with no wake.
- **Modes:** a thread in Plan mode starts only read-only roles; anything
  else is refused before a thread is made. A read-only subagent there runs
  in Plan mode itself.
- **Thread worktrees:** `StartRequest.base?: boolean` keeps a project child's
  original checkout. `children.ts` refuses a second open base holder (queued
  starts count), naming it, and guards reopening too: `ChildThreads.baseHeld`
  lets the message and answer routes refuse (409) before anything is sent. Resolved queued threads
  do not start until reopened. Code children, including those requested outside projects, use
  shared `makeWorktrees`, `worktreeGrants`, `removeWorktrees` in
  `core/src/workspace/worktree.ts`. `ThreadWorkspace.threadWork?: ThreadWork`
  holds `{ base?, worktrees: { repo, path, branch }[], reason?, cleaned? }`,
  saved only through `WorkspaceSettings.setThreadWork` in encrypted `settings`
  keys `workspace.threadWork.<id>`; no schema change. It is internal placement,
  never accepted from a settings request. `folderThread` stops at this child,
  so its folder holds the uniquely named sandbox alias
  `/thread-workspaces/<child>/worktrees/<repo>`; a subagent still shares
  its parent's folder. `SandboxSpec.workdirAlias` mounts the same folder at
  that unique path; `ExecutionTarget.worktreeRoot?()` returns it for placement
  (otherwise `cwd()`). Git’s repository-wide records then distinguish threads.
  Original checkouts are read-only with writable `.git`
  grants, the one permitted grant nesting; most-specific grants govern access
  and ancestor narrowing. `prepareWorktrees` restores resolved parts on their
  saved branches before tools run (from current HEAD if a merged branch was
  deleted), waiting for `Workspace.removeThreadWorktrees` if an earlier cleanup
  is still running. `Workspace.unsavedWork` lists a project thread's
  checkouts (its worktrees, or the base checkout it holds) with files not
  committed or commits on no remote (`unsaved` in worktree.ts); her
  `resolve` (`ThreadsHost.resolve(from, id, resolved, force?)`) refuses while
  it lists any, unless forced. Resolution runs cleanup (deferred to the end of a running
  turn) and keeps dirty checkouts; forgetting runs it with `force`, removing
  dirty ones too, silently.
  `ProjectThreadInfo.worktreeReason` and `ThreadSummary.worktreeReason` expose
  fallback reasons in the project chat's card. The coordinator starts a base
  merge thread after the parts; it gets no merge tool of its own. Outside a
  project the plain parent keeps the base and merges its children’s branches
  itself; it starts a merge thread only if the user asks.
- **Projects:** in a project chat, `threads.start` records the anchor (the
  first entry the calling turn writes; the card goes under the first
  message at or after it) and returns `queued` past the at-once limit
  instead of refusing; a queued task is held in memory only, and a restart
  tells the project chat it didn't start. `message({ to: "parent", text,
  needsYou?, question? })`; `message({ id, text })` from a project's thread to another
  thread of the same project, marked with the same `[From t:<sender>]` line
  (`HostedThread.send(text, { fromThread })`; only `lyricad` writes it, and
  `Message.from.kind` is `thread`), at most `ThreadsLimits.siblingMessages`
  (3) per request to any one thread; each sent one says how many more that
  thread can take this request, and the refusal past it points to one message
  on the next request or the project chat. It bounds one request flooding one
  thread; it counts per thread because a turn with news for several (a new head for
  two reviewers) was cut off by a total, and the threads waiting on it
  stalled. A `message` text is at most `MESSAGE_MAX` (8,000)
  characters, and a `message` or `start` text holding a run of 400 base64
  characters (line breaks aside) is refused (`checkWords`): the refusal
  sends files to `/shared` or a shared repository. `read` of a project
  thread's own project chat is refused with the route that works (`message`
  with `to: "parent"`); `list` in a project's thread lists the project's other
  threads with `ChildInfo.state` (`ThreadState`) and `needsYou`; new actions
  `suggest({ threads: { title, task }[] })` (a card, no thread made),
  `fold({ ids: string[] })` (up to ten existing threads; a card, no move),
  `draft({ goal?, instructions? })` (`ThreadsHost.draft`, unsaved project settings),
  `resolve({ id? })` and `reopen({ id })` (`ThreadsHost.resolve`; a
  project's thread resolves only itself). Guidance:
  `PROJECT_CHAT_GUIDELINES` and `PROJECT_THREAD_GUIDELINES`. `user.db`
  `child_threads` gains `anchor`, `resolved_at`, `needs_you` and `queued`
  (no text). Still one tool.
- The pure parts (`ChildInfo`, `ThreadState`, `StartRequest`,
  `ThreadsLimits`, `fromParent`, `pickThread`, the guidance, `threadLine`
  and `projectSection`) live in `core/src/threads.ts`; the extension keeps
  the tool.

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

Code-mode options are `code(): boolean` and optional
`codeRepositories(): Promise<string | undefined>`, read once per turn, and
`repoRules(): Promise<string | undefined>`, the stable `repo_rules` section:
`repoRules(target, checkouts)` reads each checkout's root AGENTS.md (or
CLAUDE.md, `@file` lines inside the repository expanded once), at most
6,000 characters each and 12,000 in all, cut at a line end naming the file,
plus up to 20 nested instruction paths; `checkoutsOf(settings, clones,
worktrees?)` lists worktrees, clones and writable grants no worktree
replaces. Coder subagents get the same section
(`createSubagentExtension(…, codingTask?, repoRules?)`).
`createChecksExtension({ checks(), code(), plan(), checkouts(), target(), exhausted? })`
runs the project's checks with `sh -c` in each checkout (10 minutes each)
when a code-mode reply without tool calls ends a run in which `edit`,
`write`, `bash` or `delegate` succeeded, and not in Plan mode, once her tools
are off, or after a Stop (the turn's signal also stops a running check). The
output is masked with the target's `secrets()`.
It shows a `lyrica-checks` notice ("Checks passed: …" or "Checks failed: …",
with `ChecksResult` details that the daemon turns into a `delegation` part
with status `checks-passed` or `checks-failed`)
and, on a failure, sends the last 60 lines (4,000 characters) of each
failing output as a hidden `lyrica-checks-failed` follow-up, at most 3
rounds a run. On the last failing round it calls `exhausted(report)` with each
failing command, its checkout and short head commit, and the last 20 lines
(1,500 characters) of its output; the daemon passes it to
`ThreadsHost.checksExhausted?(userId, pool, thread, report)`, and
`ChildThreads` delivers it to a child's parent when the turn ends, waking
it at once, in place of the turn's other end notice.
Code turns use SOUL only, no topic routing, WAKE, about-user, page index or
sleep opening; project, folders and pins remain. `setToolsOff` with reason
`code` removes `models`, `download_model`, `model_files`, `image`, `react`.
Code task/progress is stable prompt text from pool.db; repository status
is per-turn. The thread's model task callback selects `code` instead of
`chat`, including initial open, prepare and retry, retaining context limits.
Automatic recall and `recall` use `only: { project: true, about: "working" }`;
`recall` accepts optional `everywhere: true` for one unrestricted search
through the same thread view. Working preferences are tagged on remember
and retained by consolidation.

The extension is created with a `ThreadContext`:
`{ user, pool, interface, threadId, view: PoolView, call: CallContext }`.

```ts
// extension/, because core has no Pi dependency:
modelRuntimeFor(models, ctx, { onGpuWait? }?): Promise<ModelRuntime>   // Pi runtime holding only models.allowed(ctx), sealed
// onGpuWait(GpuWait { busyWith?; loading? } | null), passed for a thread's own turns (HostedThread; not sleep, subagents or watching): a host's chat requests go through waitingFetch(fetch, origin, onWait), tagged with
// X-Lyrica-Job, and their job is read every 2 s while queued; onWait hears the latest one waiting and null once none does.
// Every /v1 request to a host (sleep, subagents and watching too) waits for the GPU up to 15 minutes: hostFetch tags it.
piModelFor(runtime, models, task, ctx, resolution?): { ref; model; resolution }
prepareTurn({ session, runtime, models, call, pool, threadId, task?, thinking?, retry? }): Promise<Resolution>
openThreadSession({ thread, models, cwd, extensions, settings?, task?: () => Task, onGpuWait? }): Promise<ThreadSession>
interface ThreadSession { session; runtime; chat: { offeringId }; prepare(opts?: { thinking?; retry? }): Promise<Resolution>; dispose() }
interface ContextMeter { report(): ContextInfo | undefined; contextLines(): string; pending?: { summary }; onProgress?(): void }   // LyricaOptions.meter; onProgress runs after each request that goes on with tools
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
  - `sleep`: the `/sleep` command, where the host offers it (the bench);
  - `skills`: `{ index(), read(name), propose?(input, toolCallId) }`.
    `index()` gives the stable `skills` section for the turn
    (`skillsIndex(ListedSkill[])`, at most 40 skills and `SKILLS_IN_ALL`,
    4,000 characters, reported with the project's sections). `read(name)` gives
    a library skill's body for `read_memory` `s:<name>`. `propose` registers
    `save_skill({ name, description, body })`, which is turned off with
    `remember` in an unlogged thread. lyricad lists the active skills of the
    thread view's own pool, then of the pools it reads (a name once), then Lyrica's own `model-host`
    (`BUILTIN_SKILLS`, extension/src/model-host.md) while the thread has an SSH machine and no library skill
    takes the name, then `repoSkills(target, checkouts, cache?)`, cached per thread by checkout and HEAD.
    `read(name)` falls back to a built-in skill's body;
  - `name()`: her name for this deployment, read every turn. Automatic
    recall leaves it out of the query (`skip`), asks for two shared
    words (`minWords: 2`) and finds only what was said (`said`); `lyricad` passes `selfName`.
- Every thread's and subagent's session registers `registerVisionGuard`:
  when its model has no vision, a tool result holding an image (or a `read`
  of an image carrying Pi's "does not support images" note) gets `NO_VISION` appended, telling her she
  saw nothing and must not describe it; a `read` of an image then fails.
  A subagent's guard gets a `VisionFallback` (`createSubagentExtension`'s
  `vision`): the subagent's thread takes `visionList(models, its context)`
  as its list (the first model up in the Look at images list, task
  `vision`, else the local chat models with vision it may use), and the
  first whose machine is up becomes its model, in its record and card too; the guard switches to it with `pi.setModel`,
  keeps the image and drops Pi's note, appending `SWITCHED`. With none, or
  a switch that fails, it warns as above.
  `NO_VISION` and the delegate guideline tell her to delegate a look
  without naming a model, so the subagent switches by that list.
- Memory sections include `opening`: the sleep item a thread was started
  from. It comes from `itemForThread`, so no other thread ever has it.
- Memory sections include `pinned` (`pinnedOf(store, threadId)`: the
  thread's pinned user messages and replies, read from the store, so
  compaction can't summarise them). `pinnedBlock(pins, budgets.pinned)`
  keeps them word for word within the budget (8,000 characters): over it,
  the oldest are cut to their first line, then the oldest dropped, and it
  reports `shortened`. The context meter counts them as its `pinned` part.
- **`before_agent_start`** never replaces the whole system prompt. It runs
  for every run: one the user's prompt starts, and one a hidden message
  starts (a child's report waking its parent, a nudge, a subagent's task),
  whose text then stands in for the prompt when routing topics and recalling
  memory (`startText`). Per-request limits (the delegate budget, child
  threads started, messages to sibling threads) reset only on a run a
  prompt starts (`startsRequest`). It does two things:
  - It edits `event.systemPromptOptions`. The persona core goes in
    `customPrompt`. WAKE, the page index, the thread's pinned messages, and
    "who you're talking with" go in `sections`.
  - In Pi 1.4.0, setting `customPrompt` also drops Pi's default tool list and
    rules. The extension therefore rebuilds them from each tool's own snippets
    and guidelines (`toolGuidance`) into a `tools` section. Any tool
    registered with a snippet and guidelines appears there automatically.
    For her own prompt only (never a subagent's), `toolGuidance` is also
    given operational continuation rules: act before
    the final reply (which ends the turn), fall back to available direct tools
    after failed delegation, name a successfully started or queued background
    mechanism and its actual status, or report the stopping point and idle.
    Recurring routines are created only at the user's request. These are
    conduct guidance, not a runtime continuation guarantee. Both her prompt
    and subagents' get `WORK_GUIDELINES` (independent tool calls together in
    one reply; no re-reading a file that hasn't changed; long output to a
    file).
  - It returns content that changes every turn as the result's `message`
    (`lyrica-turn`): the opening, recall hits, the time, and each topic
    routed for the first time since the top was built (`freshTopics`, the
    topics told kept as hashes in the message's `details`). That way it sits
    in the transcript, not in the prefix.
  - Each section has a size budget.
- **The top stays as the model has it** (`createTopExtension()` in
  `extension/src/top.ts`, registered after every extension that sets
  sections). A local model folds every changed section into the leading
  system message, so any change made it re-read the whole conversation. On
  each turn it puts back the sections the transcript's system message holds,
  so Pi sends no change, and returns what changed since she was last told as
  a `lyrica-top` message in `<prompt-update>` ("These sections of your system prompt changed…",
  each changed section in full, `<name> no longer applies.` for one that
  went), with what she was told as hashes in its `details`, so a reopened
  session knows. A new thread, the first turn after a compaction, and a turn
  whose persona core or tools changed (which the model re-reads anyway)
  build the top from the sections as they are then, and record what she has
  then as a `lyrica-top` custom entry (`pi.appendEntry`, not sent to the
  model), so those sections aren't sent again as updates. Pi's own sections (`preamble`,
  `cwd`) follow its options as before.
- **Turn tool limits** (`extension/src/turn-tools.ts`, installed first by
  `openThreadSession`): one prompt/agent run, including model continuations
  and nested tool calls, permits at most 100 attempted tool calls. Invalid
  calls count too. Subagent sessions have independent budgets. A call to
  the same tool with identical JSON arguments (object keys sorted
  recursively; array order preserved) whose last two such calls returned
  the same result, or of which two run together in the same batch, returns
  an error telling the model it already has the result and should answer
  or try something different; while the result keeps changing (a running
  job's output, say) the call runs. Only a digest
  of each result is kept, in memory, for the run. A plain `sleep` (a `bash` call that only sleeps) starts the
  count over for every call, so polling isn't refused. Two replies in a row
  cut off at the reply limit with a tool call in them also stop the turn (Pi
  refuses a cut-off call and asks for it again, which on a full window is
  only cut again): that turn's notice reads `CUT_OFF`
  and its wrap-up `CUT_WRAP_UP`. Calls beyond either limit in a batch are refused. After the
  batch's results her tools turn off and a hidden `lyrica-tool-limit-wrap-up`
  message (`WRAP_UP`) asks for one reply on what she did, where things
  stand and what's left, so the person never gets only the notice; if that
  reply calls tools anyway the turn aborts. Her tools come back when the run
  ends. A stored
  `lyrica-tool-limit` message shows “Turn stopped after 100 tool calls.”
  (the count in mono, under the heading Tool limit) in the thread, live and after reload. Counters reset on the next agent run.
  Pi validates tool schemas before execution and returns validation errors
  naming missing fields. These limits serve principles 1 and 2: real
  runaway turns stop structurally.
- **Replies with only thinking** (same extension): a reply that isn't an
  error or a stop and has no text and no tool call would end the run with
  nothing said or done. The first in a run gets one hidden follow-up
  (`lyrica-empty-reply-retry`, `CARRY_ON`, dropped at the next turn like
  `lyrica-ask-nudge`) asking her to carry on. If that reply ran into the
  reply limit while thinking (`stopReason: "length"`), the retry goes with
  thinking off, and the run's level comes back at its end. A second stores a
  `lyrica-empty-reply` message (`EMPTY_REPLY`); the daemon emits it as the
  turn's `error` event, so a project's thread fails as it would on a model
  error, and after reload it shows as that reply's error.
- **Tool calls written as text** (same extension): a local server can
  leave a tool call in the reply's text, outside fenced or inline code:
  closed in any format (Qwen's
  `<tool_call><function=…>…</function></tool_call>`, Hermes' JSON in
  `<tool_call>`, or a bare `<function=…>…</function>`), GLM's
  `<arg_key>…</arg_key><arg_value>…` pairs wrapped or not, or a call cut
  off unclosed (`<tool_call>` then `{` or `<function=`, or
  `<function=…>` then `<parameter=`). The run would end on it as her
  reply.
  The first in a run, with no real tool call beside it, gets one hidden
  follow-up (`lyrica-text-tool-call-retry`, `CALL_THE_TOOL`, dropped at
  the next turn like the others) asking her to make the call. A second
  stores a `lyrica-empty-reply` message with `TEXT_TOOL_CALL`, so the
  turn fails visibly instead of sitting idle.
- **Exit codes** (`extension/src/exit-codes.ts`, threads and subagents):
  a bash result that ends "Command exited with code N" says what a
  well-known code means for the command that ended the line, such as
  "(rg: no matches, not a failure)" or gh pr checks' 8 for pending.
  The codes that aren't failures (rg or grep 1, diff 1, test 1, gh pr
  checks 8) clear the result's error.
- **Paid fallback** (`extension/src/models.ts`): when `Resolution.paidAfter`
  is set, `prepareTurn` appends a `lyrica-paid-fallback` custom entry
  (`PaidFallback`: `model`, `from`, `reason`), outside her context, and a
  retry that lands elsewhere appends `{ cleared: true }`; `toMessages` puts
  the turn's latest line (`paidLine`) on its last reply as `Message.paid`
  (docs/models.md, Prices).
- **Tool guards for OpenAI-compatible endpoints** (`extension/src/tool-stream.ts`,
  wrapped around every local server's and model host's stream in
  `modelRuntimeFor`): `objectTools` sends every tool's parameters with
  `"type": "object"` (an MCP server's schema may lack it, and LM Studio then
  refuses the whole request with a 400). `capToolCalls` ends a reply that
  streams more than `MAX_REPLY_TOOL_CALLS` (32) tool calls with an error
  naming the limit, stopping the request; none of its calls run. Calls run
  only once a reply ends, so without it a model repeating one call would run
  hundreds. Each call reaches the views as `tool_call` (`toolCallId`, `name`)
  as soon as the model starts writing it; the live view adds its marker then
  and fills in its arguments in place at `tool_start`.
- **Shared local models** (`extension/src/model-share.ts`, around every
  local endpoint's stream in `modelRuntimeFor`): `shareModel(scope, key, need,
  window, signal?, slots?, holder?)` waits until a request fits beside the ones running on
  that model (its tokens in the window, and at most `slots`, the offering's
  `parallel`, at once, kept slots counted; no limit when the server reports none) and returns its
  release, which an abort also calls. With `slots` and a `holder` (the
  session's model runtime), a released slot stays kept for that holder for
  `KEEP_WARM_MS` (15 s), with its room in the window, and the holder's next
  request takes it ahead of the queue; no slot is kept after an abort, or
  while the head of the queue has waited `MAX_PASSED_MS` (2 min); `scope` is the daemon's `Models`, so a
  daemon started again in the same process holds nothing; `markOverflow` adds a known
  overflow text to LM Studio's "Context size has been exceeded" so Pi
  compacts and retries (docs/models.md, Local servers).
- **Tool definitions are resent with every reply** (principle 8): a
  model-facing choice of strings is Pi's `StringEnum` (`"enum"`), not a union
  of literals, which is shorter and accepted by every provider; a tool's
  description says what each action is for once, and its parameters say how
  to call it.
- **Tools** (budget: 30; see principle 8):
  - `read`, `write`, `edit` and `bash` (Workspace thread; see
    [workspace.md](workspace.md));
  - `remember`, `recall` and `read_memory` (Memory thread);
  - `save_skill` (Skills; see `LyricaOptions.skills`);
  - `delegate`, and `ask_parent` in subagents (Delegation thread; see
    [delegate](#delegate));
  - `threads`, in every hosted thread but a subagent's
    (`createThreadsExtension(thread, host?, meter?)`; Child threads; see
    [delegate](#delegate));
  - `react({ emoji, message?, remove? })`, in every hosted thread but a
    subagent's (`createReactExtension(thread, { reacted(n, reactions) })`):
    writes through the thread's own view and tells lyricad, which publishes
    the `reactions` event. `LyricaOptions.reactions()` hands the extension
    the user's reactions since her last turn; `reactionLines` puts them in
    the turn message as `<reactions>`;
  - `image` (`createImageExtension(ImageTools)`), one tool with `create`, `edit`,
    `upscale`, `video`, `animate`, `motion`, `extend` and `upscale_video` (a workspace clip, optional
    `scale` and `maxSize`, through `Models.upscaleVideo`, in the background as other clips are, recorded as `image.upscale`). Create takes `prompt`, `tier` (`fast` or `quality`), optional
    `size: { width, height }` or `aspectRatio` (`width:height`), `count` and
    `references`; edit takes `image`, `instruction`, optional `mask`, `count`
    and `references`; upscale takes `image`, optional `scale` and `maxSize`.
    Create, edit, upscale and upscale_video take an optional `model`, a name she was asked
    for: `Models.namedImageModels` turns it into offerings tried before the
    list for that call (docs/models.md, "A model asked for by name"). The
    field's description lists the models on her image lists
    (`Models.imageModels`), and a name that matches none fails before any call.
    Create, edit, video and animate take an optional `loras: [{ name, strength }]`:
    `Models.loraModels` puts the models that take them all after any named one,
    a name none takes fails before any call with the LoRAs there are, and the result
    says `With <LoRA> at <strength>`; the field's description lists the LoRAs
    (docs/models.md, "LoRAs for one call").
    The parameters are one object (`action` plus every field, optional, each
    described with the actions it is for), not a union: LM Studio refuses
    tool parameters that aren't `"type": "object"`, and small models' chat
    templates show a top-level union no fields. The tool checks an action's
    required fields and names any missing. A failed call's error names the
    model label (a host recipe by its name) and error code it reached:
    `Image <action> failed with <label> [<code>]: <message>`. When the
    endpoint answers an error, the message is `image endpoint answered
    <status>` followed by a model host's own message whole (a `too_big` 413
    says how much GPU memory the recipe needs and has), or, from a cloud
    endpoint, only its error `code`, `type` and `parameter`, never its prose,
    which may quote the prompt.
    Inputs name workspace paths or `/photos-of-me/<file>`. `ImageTools` supplies
    `models`, fresh `call()`, `threadId`, `files: ThreadImages`, user `settings()`,
    `enabled()`, optional `approve(ApprovalRequest)` and injectable `now()`.
    It checks portrait consent in `Models.image.beforeSend` for the actual
    endpoint on each attempt, including fallbacks. Never is a plain refusal; Ask uses
    `Send photos of you to <endpoint>?` through the existing approval flow;
    its `tool: "image"` request's `input` (HTTP `PermissionRequest.args`)
    carries `{ question, provider, model }`, where `provider` is the resolved
    endpoint name and `model` its resolved model label. The web card asks
    "Send your portrait photos to <model> (cloud) for this image? A yes lasts
    until the end of the day.", with Send today and Not today, no thread-wide Allow.
    Always and local models allow. Ask's approval is per user through the end
    of that server-local day; a policy change clears it. No viewer means denial.
    Outputs save in the encrypted thread folder and return Pi image content
    (`{ type: "image", data: base64, mimeType: "image/png" }`) plus path text and “Made with <model> on <host or endpoint name>”,
    with a note when a named model matched none and `Passed over first: …` when it fell back.
    A content refusal returns `isError: true` with the refusal's message
    (fixed, or Codex's quoted reply) and details
    `{ imageRefusal: { code: "image_refusal", offeringId, endpointId } }`;
    stored tool markers and live `tool_end` carry `imageRefusal`. Later
    image calls in the same turn throw `REFUSED_THIS_TURN` before resolving
    a model; explicit retries (`executeImage`) are not affected.
    `GET …/threads/:pool/:threadId/image-calls/:toolCallId` returns
    `{ canEdit, userMessage?: { n, text }, next?: { offeringId, label } }`
    for a stored refusal, under the current routing and portrait policy.
    `POST` there with `{ next?: boolean }` repeats that stored call on its
    original model (false) or current next eligible endpoint (true), through
    `executeImage`; no caller-supplied prompt or model is accepted. Busy
    threads refuse it; Stop cancels it. Its encrypted `lyrica-image-retry`
    custom entry keeps the source user message number, args and result;
    messages project it as a tool marker and optional image part, without
    PNG bytes. Saved task lists are unchanged.
    `video` (`prompt`, optional `size` or `aspectRatio`, which goes to the host
    as it is, `duration`, and `steps`, only when the user asks for a number) and
    `animate` (also `image`, the first frame), `motion` (also `image`, the subject, and
    `video`, a workspace MP4 read with `ThreadImages.readClip`) and `extend` (`video`, the clip to
    make longer, and `prompt`; `duration` is the seconds to add) make one clip through
    `Models.video` and save it with `ThreadImages.saveVideo`. With
    `ImageTools.background(make, toolCallId)` (lyricad's `ClipJobs`, daemon/src/clips.ts)
    the call reads the first frame, hands `make(signal, onProgress) → ClipMade { text,
    video: VideoPart, args }` over (`args`: the call's arguments) and answers at once ("Making the clip in the
    background…", details `{ clip: "started" }`); lyricad delivers the result
    as a delegate notice with details `{ status: "clip", video, call: { toolCallId, args } }` (or
    `"clip-failed"`, its reason in the text), which messages show as an
    assistant message with the call's image tool part (ID `<toolCallId>:made`,
    the call's args, the notice's text as its result) and then the video part, and the `notice` event carries as
    `video` and `call`, and wakes an idle thread. While a clip is being made, the thread's
    `ThreadSummary.making` is `true` (`ThreadHost.makingClip`), and the user's events report a change
    when it starts and ends. A clip delivered before `call` existed shows alone. Without it (an explicit retry) the call
    answers with its facts and its poster as image content, so she sees the first frame;
    a host's progress (create, edit, upscale, video, animate, motion) goes to Pi as the call's update, details `{ progress: JobProgress }`;
    details `{ video: VideoPart }`, `VideoPart` being `{ type: "video", path,
    model, width, height, duration, audio }`. A video's error reads `Video
    failed with <label> [<code>]: …`. Saved messages carry the part beside its
    call and `tool_end` carries `video?: VideoPart`, never the bytes.
    Successful tool details are `{ image: ImagePart }`, where `ImagePart` is
    `{ type: "image", paths: string[], model: string, tier?: "fast" | "quality", picked?: true }`.
    `reject` (`images`: paths) moves the tool's own results in the thread's
    images folder (`images/` or a project chat's `shared/images/`) into its
    `rejected/`, all or none, calling no model; details `{ rejected: paths }`; from the turn's eighth rejected attempt its text adds
    `ASK_INSTEAD` (a nudge to pick the closest and ask, not a refusal).
    `pick` (`image`) brings one back from `rejected/` if needed and answers
    `{ image: { paths: [path], model: "", picked: true } }`: the web takes the
    facts from the part that first showed it. `clear_rejected` deletes the
    tool's results in `rejected/`; details `{ cleared: paths }`. The web reads
    which attempts are rejected from these calls' arguments.
    `model` is the answering model's label. Saved messages carry this part
    beside the originating tool call; `tool_end` carries `image?: ImagePart`.
    API messages and events carry paths, never the PNG's base64 bytes.
    The Images switch and Plan mode gate it; subagents also need the tool in
    their role and may not be read-only. It adds one tool within the budget;
  - `web_search({ query, count?, time?, category?, page? })` and
    `web_fetch({ url, maxChars?, offset? })`
    (`createWebExtension({ searxng(), kiwix?(), target(), canRender?() })`,
    `core/src/web.ts`, `core/src/kiwix.ts`), in
    every hosted thread and in a subagent whose role lists them (the
    researcher's), behind the Web search switch. `web_search` asks the
    server's SearXNG (`GET <address>/search?q=…&format=json`, plus
    `time_range` day|week|month|year, `categories`
    general|news|science|it|videos and `pageno` 1 to 10; 15 s) for up
    to `count` results (8 by default, 20 at most) as title, date (when
    SearXNG has `publishedDate`), URL and snippet, after its first answer
    or infobox line. Requests to SearXNG go at least a second apart
    (`SearchGate`, one for the daemon, in memory), and the same search
    (query, time, category, page) within a minute is answered from its
    last reply. No results while an engine failed passingly (`timeout`
    and the like): it asks once more. An engine SearXNG reports as
    `CAPTCHA`, `too many requests`, `access denied` or `Suspended: …`
    refused and is resting, so no retry; still nothing, it names the
    failed engines, why, and for how long each refusing one has been
    seen refusing (an engine seen in a result's `engines` is forgotten),
    says a rested engine gives the same answer when every failed engine
    refused, then SearXNG's corrections and suggestions. With a Kiwix
    address (the offline copy of Wikipedia, kiwix-serve), a plain search
    (page 1, no time, general or no category) also asks it
    (`kiwixSearch`: `GET <kiwix>/search?pattern=…&books.name=<book>&format=xml&pageLength=n`,
    one request per book since kiwix-serve refuses a search over books
    in different languages, 15 s, hits merged in turn, the same URL once,
    at most 5) and
    appends "Offline copy of <title> <YYYY-MM>:" with each hit as title,
    URL and snippet, after the web results. A hit of a book named
    `wikipedia_<lang>_…` is the page `https://<lang>.wikipedia.org/wiki/<path>`
    (the ZIM path without its `A/` and `.html`); any other book's hit is
    its `<kiwix>/content/<book>/<path>`. Either side failing is said after
    the other's results; both failing is the error. The books come from
    `GET <kiwix>/catalog/v2/entries` (`kiwixBooks`: id from the
    `text/html` link, name, title, language, date), read once and kept
    five minutes (`forgetKiwixBooks` drops them). `web_search` is offered
    only while a SearXNG or Kiwix address is set, read on every turn and
    call. A `user:password@` in the SearXNG address goes as basic auth.
    `web_fetch` reads from the offline copy first (`kiwixPage`): a
    `https://<lang>(.m).wikipedia.org/wiki/<title>` page when a book
    copies that language (`GET <kiwix>/raw/<book>/content/<path>` with
    the path `A/<title>`, `<title>`, with `.html`, then the path
    `GET <kiwix>/suggest?content=<book>&term=<title>&count=10` gives for
    that title), and any `<kiwix>/content/<book>/<path>` of its own. A
    page becomes Markdown as below, links absolute on wikipedia.org (so
    they are read offline too), then "Pictures, each readable with
    web_fetch:" listing up to 12 of its images by their `<kiwix>/content/…`
    addresses (a maxi copy has them, a nopic one none), and the result's
    "from" names the copy and its month. A listed picture (png, jpeg, gif
    or webp, 5 MB at most) comes back as an image part, WebP as PNG
    through ImageMagick on lyricad's PATH (`pictureForModel`; as WebP
    without it), so a model with vision sees it and the vision guard
    switches a subagent without. A page no book has, or any other URL,
    goes online: `web_fetch` runs
    curl (`fetchArgv`, the URL one argument, a browser's user agent, 10 MB
    at most) through the thread's sandbox
    target's `run`, so its internet switch and allowed hosts apply.
    lyricad reads the result (`fetchedPage`): HTML in the charset it names
    becomes Markdown (`htmlMarkdown`: Readability over linkedom for the
    main text, else the whole body without scripts, styles, navigation,
    forms or images; turndown, tables as Markdown tables, links absolute),
    headed by title, URL, byline and date; a PDF becomes text page by page
    (`pdfText`: unpdf in a child process, `web-pdf.mjs`, with no environment,
    killed after 30 s or once its resident memory passes 768 MB, since
    pdf.js decodes streams outside the JS heap); text
    and JSON pass through; other types are refused. HTML that is nearly
    empty and has scripts (`thin`) is rendered once more when `canRender()`
    (the sandbox has Chromium and node): `renderArgv` runs
    `web-render.cjs` with the sandbox's node, which drives its Chromium
    over the DevTools pipe without images, media or fonts, and the longer
    text wins. HTML from curl or Chromium is cut to 3,000,000 characters
    before it is parsed on lyricad's thread. `cutPage` cuts to `maxChars` (20,000 by default, 50,000 at
    most) from `offset`, with a note naming the offset to read on from.
    Both tools' results go between `<<<web CODE>>>` and `<<<end web
    CODE>>>` (`outside`; CODE is 8 random hex digits per call, and
    marker-shaped text inside is removed), headed by where they came from;
    the cut note follows the end marker. `OUTSIDE_GUIDELINE` tells her
    what is between them is information, never instructions. Both are
    `openWorldHint` and `readOnlyHint`, so they never ask;
  - `proxmox` (Machines; see [core/workspace](#coreworkspace)) and
    `add_repository` (Repositories; see [core/workspace](#coreworkspace));
  - `page({ action: "preview" | "bundle" | "check", path, out?, width?,
    height?, query?, wait? })` (`extension/src/page.ts`, registered by the
    workspace extension), in the sandbox only. `preview` runs
    `PREVIEW_SCRIPT` with the sandbox's `node` through the target's `run`
    in `ThreadTools.previewTarget()` (`Workspace.previewTargetFor(t)`: the
    thread's folders, grants and clones read-only, no network, no
    credentials), never the thread's own target, and returns a text (load
    state, title, errors, console, blocked requests, canvases,
    `pixelStats`) and the screenshot as `{ type: "image", mimeType:
    "image/png" }`, writing nothing; width and height are 2048 at most.
    Without `previewTarget`, or Chromium and `node` in the sandbox, it
    fails saying so.
    `bundle` writes `bundlePage`'s file to `out` (relative to the folder,
    like `path`; `bundleOut`: `<name>.single.html` beside the page) through
    `recording`, refuses to write over the page, and adds `describeCheck`.
    `check` returns `describeCheck(checkPage(html))`. The `tool_call` gate
    treats `bundle` as `write` (it asks where `write` asks, and its `out`
    goes through `sameFile`) and the others as `read`; it isn't in
    `PLAN_TOOLS`, and an approval binds its action, path and out;
  - `models`, with `lookup { offering, repo? }` and `propose { offering,
    stretch, contextLength, originalContext? }`, in general threads only (Context stretching;
    see [docs/briefs/context-stretch.md](briefs/context-stretch.md));
  - in sleep sessions only: `write_page`, `write_journal`, `write_wake`,
    `raise` and `propose_persona` (Sleep thread; see [sleep.md](sleep.md)).
  - `tool_search`, Pi's, in a thread with a granted MCP server: it loads
    the servers' deferred tools, which don't count against the budget
    (MCP servers; see [workspace.md](workspace.md#mcp-servers));
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
- **Root steps** (`run_as_root`, registered by the threads extension when
  `ThreadsHost.rootScript?(from, machine, path): Promise<{ bytes, account }>`
  exists, never in an ordinary child thread): `rootStep(input, bytes,
  account)` builds the `RootStep` `{ machine, path, sha256, command, script,
  why, sudoers?: { line, warning? }[] }` (`checkSudoers`, `rootCommand`,
  `ROOT_LIMITS`), returned as the result's `details.root`; the daemon passes
  it on as `root` on the tool part and the `tool_end` event (`rootPart`).
  See [workspace.md](workspace.md#root-steps).
- **Workspace extension** (`createWorkspaceExtension(tools: ThreadTools)`):
  - A `bash` call with no `timeout` gets `BASH_TIMEOUT_S` (600 seconds),
    and the tool's schema says so; she gives a longer one for a long build.
  - With `startJob`, `bash` takes `background: true` and there is a `jobs`
    tool (`list`, `output`, `stop`); a subagent has neither. A background
    call is approved like any `bash`, then `startJob(command, machine?,
    timeoutS?)` returns a `JobInfo` (with the job's `cwd`) at once
    (docs/workspace.md, Background commands). Jobs that end within
    `jobWakeMs` (5 s) of each other wake the thread once.
  - `ExecutionTarget.run?(argv, { signal?, timeoutMs?, cwd? })` runs argv with no
    shell under the target's own rules; the sandbox has it.
  - `ExecutionTarget.secrets?()` is the sandbox's tokens and placeholders
    (core/src/workspace/ops.ts): `bash` output (`secretMasker`), `read` and
    `web_fetch` pages (`maskSecrets`) show `SECRET_HIDDEN` for each, and the
    `tool_call` gate refuses a `web_search`, `web_fetch`, `image` or MCP call whose
    input holds one (`holdsSecret`).
  - `ThreadTools` is `{ commandRules?(), target(machine?), settings(), network(),
    claudeCode?(), machines?(), allowedInThread?(machine, command), proxmox?(machine, action, vm?),
    mcpServers?(), toolAllowedInThread?(server, tool), approve?, setMode?,
    proposePlan?(PlanRequest), recordChange?(NewChange), sameFile?(path, inserts?), madeFiles?(paths), madeSince?(since), fileNotes?(),
    startJob?(command, machine?, timeoutS?), jobs?(), jobOutput?(id), stopJob?(id) }`.
    `sameFile(path, inserts)` runs in `tool_call` for a sandbox `write` or `edit`
    (`inserts` when `insertsOnly`: every replacement of the edit keeps its
    old text whole at the start or end of the new), and for each file a sandbox `bash` plainly writes (`writtenFiles`),
    before any approval is asked; a text it returns blocks the call as its
    reason and nothing is written (daemon
    `SameFile.claim`, keyed by `Workspace.fileKey`; it holds only while the
    other thread is busy, and `SameFile.held` gives both sides of an
    unsettled hold, which `ChildThreads` shows as `ThreadState` `"held"` and
    `held: { thread, title?, path }`; `ChildThreads.message` calls
    `SameFile.messaged`, which settles it).
    `commandRules()` reads the owning project on every bash call. Forbid
    blocks in all modes and targets; Ask always prompts; Allow skips only
    sandbox mode prompts. Opaque commands ask with any forbid rule.
    `user_bash` is never checked.
    `settings()` is the thread's effective settings. `fileNotes()` returns
    `{ added, removed }` paths the Files panel changed since her last turn,
    which the `workspace` prompt section names in one line. `madeFiles`
    hears of what a sandbox `write` or `edit` wrote, and `madeSince(since)`
    of a sandbox `bash` call's start, whether or not the call succeeded,
    without the call waiting: `Workspace.sweepSince` runs one sweep per
    thread at a time (a later start waits, the earliest kept), and
    `madeSince` records the files in `/workspace` and `/shared` newer than
    it (`find` in a fresh no-network sandbox, at most 2,000 within 10
    seconds; `.git`, `node_modules`, `.lyrica` and `/workspace/repos`
    skipped). The daemon passes `madeSince` a hook that hands the files
    found to `SameFile.changed` together, which tells both threads, once
    per other thread and naming its files, when another thread changed
    them first. `claudeCode()`
    true adds `CLAUDE_CODE_LINE` to that section.
  - `read`, `write`, `edit` and `bash` take an optional `machine`. On a
    machine the call's mode is `stricterMode(settings().mode, limit)`; a
    suspect `bash` (`suspectCommand`) asks in every mode unless
    `allowedInThread`; the first call on a machine in a turn asks if
    anything earlier ran elsewhere. `ApprovalRequest` is `{ toolCallId,
    tool, input, machine?, cwd?, warning?, server?, serverTool? }`, and the call runs only if its
    arguments are still exactly what was approved. With `proxmox`, the
    `proxmox` tool is registered, and offered only while `machines()` has a
    Proxmox machine. An `mcp__<server>__<tool>` call whose server isn't in
    `mcpServers()` is refused; one its server marks `readOnlyHint` runs,
    as does one `toolAllowedInThread`; any other asks with `server` and
    `serverTool`, in every mode. Read-only MCP tools stay on in Plan mode.
  - `toolsOff(settings, registered)`: Plan mode leaves only `PLAN_TOOLS`
    (`read`, `recall`, `read_memory`, `web_search`, `web_fetch`,
    `delegate`, `ask_parent`, `threads`, `propose_plan`, `tool_search`, `proxmox`, whose
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
  1.4.0 (as are `defaultBuiltins`, `builtins` and `rebuildProviders`, used to
  empty the catalog); re-check them when Pi is upgraded. The wrapper gives a
  host provider its `fetchFor` fetch, and for every offering adds an
  `onPayload` that merges `payloadFields(offeringSettings(…).values, …)` into
  the request: `repeat_penalty` for plain local servers,
  `repetition_penalty` for hosts and cloud; `max_tokens` or
  `max_completion_tokens` never above the room Pi left (`replyCap`: a
  quarter of the context window, never above the offering's `maxOutput`,
  and at most 131,072 tokens on a local endpoint or with a `maxOutput`, else
  32,768). Settings are read at
  each request, so a change applies without reopening the session.
- A host or `llamaServer` model whose only thinking level is a chat-template switch gets Pi's
  `thinkingFormat: "qwen-chat-template"`; any other model with levels gets
  `reasoning_effort`. Local endpoints and hosts are sent `system` and
  `max_tokens`. A request sent with thinking off that the provider refuses
  because the model must think ("Reasoning is mandatory") is sent again at
  `mandatoryThinking`, and `mustThink` is called (`thinkWhenRequired`).
- **Projects:** a `project` section in `assemble` (`projectSection`), with
  its own `DEFAULT_BUDGETS.project` (8,000 characters, about 2,000 tokens):
  the goal, the user's instructions (at most 2,000 characters), project
  notes since the last sleep, (in the project chat only) its threads with
  their state from `LyricaOptions.projectThreads`, and last the project
  page, so a long page is what the budget cuts. Filled for a project chat
  and each of its threads; empty elsewhere.

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
  - `recordEntries` syncs user entries with `appendEntry` into the encrypted
    thread store in a microtask after Pi’s user `message_end` append, before
    the model runs. Turn, agent and compaction ends sync remaining entries;
    stored Pi IDs prevent duplicates.
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
  restart left working are marked idle, each gets an `INTERRUPTED_NOTICE`
  entry (`appendNotice`, shown as its last reply's error), and their parents
  are told and woken.
- **Permission prompts:** the workspace extension's `tool_call` hook calls
  `ThreadTools.approve?(request)`; `lyricad` supplies it and waits for an
  answer from any open view, denying on timeout or Stop. `proposePlan`
  takes the same path: `PermissionAnswer { allow, mode?: GoAhead,
  allowInThread?, alwaysAllow?: true }`, and approving a plan without `mode` is `400`. A
  request on a machine carries `machine` and `cwd`, a suspect one `suspect:
  true` and `warning`, an MCP one `server` and `serverTool`;
  image portrait consent uses `tool: "image"`, `args: { question, provider, model }`
  and `warning` with its question, without a thread-wide Allow option;
  `allowInThread` stores that exact command, or that server's tool, for the
  thread it runs in and is refused on any other request. A plan switching the mode, or a
  settings change, sends the thread a `{ type: "settings" }` event.
- A sandbox `bash` permission request in a project can carry
  `alwaysAllow: string`, computed by lyricad, never the browser. Answering
  with `alwaysAllow: true` saves that stored prefix as a project Allow rule
  and approves the call, also for a subagent. Other requests refuse it.
  `ThreadChange.commandRules` replaces rules only on a project chat;
  `ProjectSettingsInfo.commandRules` returns them. `ThreadChange.checks`
  and `ProjectSettingsInfo.checks` do the same for the project's checks,
  and `ThreadChange.setup` (a string; empty or `null` clears it) and
  `ProjectSettingsInfo.setup` (absent when unset) for its setup command
  (400 with the reason when invalid).
- **Sweep** (`Lyricad.sweep`, nightly, before sleep): `sweepUser(services,
  userId)` for each user whose home workspace is mounted clears snapshots
  and change records older than 30 days (`SWEEP_AGE_MS`), the folders and
  Claude Code folders (`claude/<thread>`) of threads that no longer exist
  (younger than 60 s are left), and the
  worktrees of subagent runs that aren't live (`DelegationStore.liveRuns`)
  and haven't changed in 30 days. `forgetWorktree(path, allowed)` removes a
  worktree's git record (a run's, or a code thread's own) only when it is in a folder the user may grant,
  reached with no symlinks, and names that worktree back. Logs counts only.
  `forgetThreadFiles(services, userId, pool, threads)` does the same for
  threads just forgotten, at once and with no age limit, and drops their
  change records and snapshots too, keeping a folder whose id a thread in
  either pool still has, and removes its `tmp/<id>` and each
  `threads/*/shared/<id>` directory (not following a link there);
  `DELETE …/threads/:pool/:threadId` calls it.
- **Web access** (`LyricadOptions.web`): built-in Caddy, configured through
  its admin socket `/run/lyrica-caddy/admin.sock`, or an external proxy, with
  an extra listener whose settings and TLS key are in
  `<runtime>/web-external.json` (0600) and which opens before unlock, and
  `<runtime>/web-front` (0600) naming the plain listener with a proxy in
  front, for the time before unlock. Settings
  and DNS credentials live in `self.db`. See [daemon.md](daemon.md).
- **Unlocking:** when started as a service, `lyricad` starts locked, and the
  API serves only the unlock endpoint until `self.db` is unlocked.
- **Setting up** (Bootstrap): without `self.db`, `lyricad` is setting up:
  `State.setup: true`, and only `GET /api/state` and `POST /api/setup`
  (`SetupRequest { code, passphrase, saveCredentials?, name?, admin: { login,
  password, displayName, pronouns? } }` → `LoginResponse`) answer, on
  loopback, the Unix socket and the Direct listener; the one-time code is
  in `<runtime>/setup-code` (0600), never in the log.
  - **Name.** `State.name` (her deployment name, `self.db` `settings`
    `self.name`, default Lyrica, with a copy in `<runtime>/name` for while
    locked) answers in every state; `GET`/`PUT /api/u/:userId/admin/name`
    `NameSetting { name }`; `PersonaStore.read()` puts it in REGISTER's
    `Name:` line; `DelegationOptions.name` gives it to subagents.
  - **Tailnet.** Through the `tailscale` CLI against her own
    tailscaled's socket (`lyrica-tailscaled.service`, userspace networking,
    the `lyrica` user; `daemon/src/tailnet.ts`, `Services.tailnet`,
    `LyricadOptions.tailnet { binary?, socket?, proxy? }`; `lyrica serve`
    passes `proxy: "127.0.0.1:1056"`, her tailscaled's
    `--outbound-http-proxy-listen`, and `useTailnetProxy` in `core/models`
    sends tailnet destinations through it, from every fetch and every model
    host connection, by HTTP CONNECT): `GET
    /api/u/:userId/admin/tailnet` → `Tailnet { state, tailnet?, address?,
    dnsName?, hostname?, controlServer?, version?, reason? }`; `PUT` with
    `TailnetJoin { authKey, hostname?, controlServer?, leave? }` (409 when
    joined without `leave`); `POST …/disconnect`, `POST …/connect`, `DELETE`
    (leave; turns the Tailnet web mode off). The auth key is written to a 0600
    file for `--auth-key=file:` and deleted at once, never stored or logged.
  - **Web modes.** `Request.via: "tailnet"` marks a request on the serve port
    (`LyricadOptions.web.servePort`, 7342); disconnect, leave and a join that
    leaves are 409 then. `WebMode` gains `"direct"` (the extra listener on
    every LAN and Tailscale address, port 7340 (`web.directPort`), HTTPS with
    lyricad's own certificate, no proxy list; the mode she starts in;
    `WebAccess.direct: { addresses, port, fingerprint, pem }`,
    `WebAccessStatus.direct`) and `"tailnet"` (`tailscale serve` to the serve
    port; `WebAccess.tailnet: { dnsName, certificates }`,
    `WebAccessStatus.tailnet`), and `frontDoor` includes the Direct port on
    this machine's addresses and, in Tailnet, 443 on her Tailscale address
    (which stands for her MagicDNS name: this machine's resolver needn't know
    it, since her tailscaled is userspace). All additive.
  - **Wrong door.** On the two plain loopback listeners (`port` and the serve
    port), a request whose `Host` isn't this machine's loopback name and that
    no trusted proxy marked `X-Forwarded-Proto: https` is answered without
    reaching a route: a `GET`/`HEAD` page load is `302` to the HTTPS front
    door (`https://<host>:<Direct port>` when `Host` is one of Direct's
    addresses, else `https://<Tailnet DNS name>`) with the same path and
    query, or `403 text/html` with one sentence when there is none; a path
    under `/api/` or `/hooks/` is `403 { error }` with that sentence. The
    origin check for a mutation accepts, besides `Host`/`:authority`, a
    trusted proxy's `X-Forwarded-Host` and, on the serve port, the Tailnet
    mode's DNS name and address.
- **Web search** (`core/src/web.ts`, `core/src/kiwix.ts`): the server's
  SearXNG address is `self.db` `settings` `web.searxng` (`searxngAddress`,
  `setSearxngAddress`) and its kiwix-serve address, the offline copy of
  Wikipedia, `web.kiwix` (`kiwixAddress`, `setKiwixAddress`);
  `GET`/`PUT /api/u/:userId/admin/web-search` →
  `WebSearch { searxng: string | null, auth, state: "reachable" |
  "unreachable" | "unset", reason?, kiwix: string | null, kiwixState:
  the same three, kiwixReason?, books: { name, title, language, date }[] }`,
  administrators only, `state` from a test search and `kiwixState` and
  `books` from the catalog on each call; `PUT { searxng?, kiwix? }`: a
  field with null or "" clears that address, one left out keeps it.
  A password in the SearXNG address (basic auth) is never sent back: `searxng`
  comes without it and `auth` says one is stored; a `PUT` with the same
  user@host and no password keeps it, one with a password replaces it.
  `ThreadSettings.searchProvider` says whether either is set.
  `adoptLocalSearxng(self, address)` and `adoptLocalKiwix(self, address)`
  (`adoptLocalAddress`) store the address install.sh (or the
  NixOS module's `searxng` and `zimDir` options) leaves
  in `<LYRICA_HOME>/searxng-address` and `kiwix-address` while none is
  set, called by lyricad on each unlock; `web.searxng.offered` and
  `web.kiwix.offered` record it, so each address is offered once and a
  cleared or changed one stays.
  `HostOptions.searxng`/`kiwix` and `DelegationOptions.searxng`/`kiwix`
  give them to sessions.
- **HTTP/SSE API**, defined in `daemon/src/api.ts` and described in
  [daemon.md](daemon.md). The web UI imports its types from there:
  - auth;
  - `GET /api/u/:userId/events` → SSE `UserEvent`: `{ type: "hello" }`
    on every connection, then `{ type: "changed" }`, coalesced per user
    at most once per 250 ms. Successful mutations under that user's path
    (except `PUT …/draft`),
    thread list events (`turn_start`, `turn_end`, `title`, `settings`,
    `permission`, `permission_end`, `child`) and Sleep events trigger it.
    No text, IDs or replay; clients re-read existing routes. Requires the
    addressed user's session and key; checks each event and every 25 seconds,
    ending on logout or Lock;
  - threads (list, create, hide, forget); the user's own view of them:
    `Display.sort` (`ThreadSort`), `ThreadSummary.group` and `unread`,
    `ThreadChange.group` and `unread`, `ThreadGroup` with `GET`/`POST
    thread-groups` and `PATCH`/`DELETE thread-groups/:id` (in `user.db`,
    never the pool); `State.version` and `build` (once unlocked);
  - `ThreadSettings.context` (`ContextInfo`: used, window, parts, reserve,
    free, measured at, `compactions`: how many times it was compacted, with
    used being what is left after them), `CallInfo.pace`, the `context` and `compacted`
    thread events, and a `compacted` message part (the stored notice);
  - a `gpu_wait` thread event (`wait: GpuWait | null`, and `gpuWait` on
    `hello`) while a reply waits for a model host's GPU: `busyWith` (plain
    words, "a chat model") or `loading`; null once it no longer waits, and
    cleared at `turn_end`. A reply's stored `error` that is a server's JSON
    error ("503: {…}") keeps only its message (`plainError`);
  - offline: an `offline` thread event (`task`, `tried`) when no model for a
    turn can be reached; a turn that hadn't started keeps its message in
    `queue` and sends it when a model answers. Any call that throws `Offline`
    answers `502` (503 is reserved for locked) with `{ error, code: "offline", task, tried }`;
  - child threads: `ThreadSummary.child`, `status` and `unseen`;
    `Message.from: { kind: "parent", threadId }` in a child thread only; a
    user's send or edit starting with the parent's mark is `400`;
    `ForgetThread` / `DELETE …?children=1` (the live sessions stop side by
    side, then the store forgets every doomed thread in one owner view and
    `PoolStore.forgetThread`'s `optimize: false` leaves the search index
    merge to the last one); `ThreadHost.status`,
    `delivered`, `HostedThread.waiting`, `send(text, { fromParent })` and
    `settled()`; a `received` thread event (`text`) when a message from
    another thread or a look reaches the running turn, or is kept in the
    stored thread because no turn took it; `POST threads/:id/queue/:i/steer`
    `{ text }` (`HostedThread.steerQueued`) moves the person's waiting
    follow-up at index `i` into the running turn, `409` with no turn running
    or when the follow-up there is no longer `text`, and the
    `queue` event's `steered: true` marks the update it causes;
  - **projects** (`daemon/src/projects.ts`, `children.ts`): thread pins,
    per user: `user.db` `pinned_threads` (pool, thread; no text), `PUT`/`DELETE
    threads/:id/pin`, `ThreadSummary.pinned`, pinned first in the list;
    Web UI 2's thread menu uses them. `POST threads` with `project` (and
    `PATCH` making one) also pins the thread; `Display.projects: "all" |
    "only" | "none"` filters the list; `PATCH threads/:id` with `project`,
    `goal`, `paused`, `threadsModel`, `threadsThinking`, `threadsFallback`, `watchThreads` and `checkInOnThreads`
    (`user.db` `project_settings`, settings and unsaved drafts), and
    `projectSettings.pageId` names the project page's memory ID; a project chat's
    look at its threads is marked `[Watching threads]` (`WATCHING_MARK`,
    core/src/threads.ts), which only `daemon/src/watch.ts` writes: a
    delivered entry, or the message of the turn it raised; `Message.from`
    shows it as `{ kind: "watching", told?: Told[] }` (`Told`: `threadId`,
    `text`; absent on looks from before looks were one call), and its live
    `notice` event has `status: "watching"` and `told`; `POST …/messages/:n/thread` (Start a
    thread) → `ThreadSummary`; `POST …/threads/:pool/:projectId/plan` (Make a plan: no body, a
    thread titled Plan with a server-written task, no anchor; 409 while paused or hidden, creating
    nothing) → `ThreadSummary`; `POST threads/:id/resolve` and `…/reopen`;
    `POST …/suggestions/:callId/start` (`index`, or all with none; `user.db`
    `started_suggestions`); `GET threads/:id/overview` (`ProjectOverview`:
    its threads, the waiting count, total tokens, started suggestions);
    `models/calls?project=&pool=`. `ThreadSummary` gains `project`, `goal`,
    `projectSettings`, `anchor`, `state` and `needsYou`; a `child` event in
    the project chat says a thread's card changed; an update that asks the
    user is a notice with status `waiting`. The nightly tick resolves a
    project's threads idle for 7 days (`AUTO_RESOLVE_DAYS`); Paused and Hide
    stop a project's working threads; a user's message in a paused
    project's thread is `409`;
  - **project welcome** (principle 1): `GET threads/:pool/recent?top=10&project=:id`
    → `ThreadSummary[]`, most recently active first, at most ten logged
    top-level non-project threads of that pool; hidden threads stay out.
    Local-only threads appear only for a local-only asking project chat.
    `SendRequest.recentThreadIds` supplies up to ten distinct selected IDs
    to a project chat; only those are read, through `openThreadView`, with
    `latestEntries` and the `threads read` formatter (ten messages per thread,
    16,000 characters total), in that turn's system context only. An
    unlogged or incompatible selection is refused; a busy project chat is
    `409`, so selection never leaks into a queued turn. `threads read`
    keeps its existing project-membership boundary.
    `POST threads/:pool/:projectId/fold { threadId }` → `ThreadSummary`;
    `threads fold { ids }` suggests moves without applying them;
    `POST …/:projectId/folds/:callId/apply { index? }` → `ThreadSummary[]`
    applies one or all, once per index, tracked in `started_suggestions`
    and the overview's `started`. Every move is same-pool, top-level,
    non-project work, with its children flattened into project siblings;
    local-only work needs a local-only project chat. Child state, steps
    and wake-ups keep their IDs; workspace grants narrow to the project.
    `POST threads/:pool/:threadId/continue-as-project` → a new pinned
    project's `ThreadSummary`: copies workspace and model settings,
    including local-only, moves children, leaves the source conversation,
    and sends a first linked message asking for drafts with a selected
    read of the source. That turn asks for drafts without fold-suggesting directions: the source stays in place. An unlogged source is refused.
    `threads draft { goal?, instructions? }` keeps unsaved text (each at
    most 2,000 characters) in `project_settings.draft_goal` and
    `draft_instructions`, nullable columns added by expand-only user step 9.
    `ThreadSummary.projectSettings.draftGoal` / `draftInstructions` expose
    them; other settings changes preserve them. A user `PATCH` saving
    `goal` / `instructions` clears the respective draft; `discardDraft: true`
    clears both without applying them. `WorkspaceSettings.reparent(threadId, projectId, pool)` narrows
    existing grants and network access to the new project. No extra model-facing tool.
  - pins: `PUT`/`DELETE …/messages/:n/pin` (the user's messages and her
    replies only, `400` otherwise, `409` in a subagent's thread), `GET
    …/pins` → `Pins { pins: Pin[], shortened }`, `Message.pinned`,
    `RewindResponse.pins`;
  - drafts: `GET …/draft` → `DraftInfo { text, updatedAt? }` (`text` empty
    when none), `PUT …/draft` with `DraftChange { text }` → `DraftInfo`
    (empty clears it, over 64 KiB is `413`); a sent message clears it;
  - search: `GET /api/u/:userId/search?q=&pool=&limit=&before=` →
    `SearchResults { hits: SearchHit[] }`, `SearchHit { threadId, pool,
    title?, n, who, snippet, marks, at }` (`who` is `you` or `agent`;
    `marks` are `[start, end)` offsets into `snippet`). Read through the
    owner view with `PoolStore.searchMessages`, so only from the FTS index
    recall keeps (`search` in each pool): logged entries only, never one
    written unlogged. Only the user's own pools and what the thread list
    shows: the server reads the saved `Display` itself, leaves out a pool
    turned off and hidden threads unless `showHidden`, follows the
    projects choice (a thread goes with the row it is nested under), and
    lists web threads, not subagents'; `pool` narrows, never widens. `q` needs 2
    characters; 50 hits a page, newest first, `before` a hit's `at`. The
    snippet is the sentence holding most of the words, at most 160
    characters, without citations; message text is never logged;
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
  - changes: `GET /api/u/:userId/threads/:pool/:threadId/changes` →
    `ThreadChanges`, `…/changes/commit?repo=&hash=` → `CommitChanges`,
    `…/changes/file?repo=&path=&old=&commit=` → `FileSides` (docs/daemon.md
    "Changes"): git run where the thread's tools run, through
    `Workspace.checkouts(t)` and `core/src/workspace/git-changes.ts`
    (`repositoryChanges`, `commitFiles`, `fileSides`); the open pull request
    from `ForgeWatcher.openPull(userId, pool, thread, repo)`, the last poll's
    number, head, URL, draft flag and checks; `ForgeWatcher.openPulls(userId, pool,
    thread)` lists them all for a project thread's `ThreadSummary.pull`, and
    `DelegationStore.liveCounts(userId, pool)` counts its running or asking
    subagents by parent thread for `ThreadSummary.subagents`;
  - images: `GET /api/u/:userId/threads/:pool/:threadId/file?path=` serves
    sniffed regular file bytes from that thread's folder only (relative or
    `/workspace/` paths), with `no-store`, `nosniff` and a sandbox CSP.
    Grants, traversal, symlinks and another user's files are 404; no login is
    401. `GET /api/u/:userId/photos-of-me` → `PortraitPhoto[]` (`path`, `size`,
    `type`); `POST` raw PNG/JPEG/WebP, at most 20 MB → `UploadResponse`, with
    metadata removed and an exclusive generated filename; `DELETE …/:name`
    → `Ok`. `GET …/photos-of-me/:name` serves sniffed PNG/JPEG/WebP bytes
    from that user's portrait folder only, with `no-store`, `nosniff` and a
    sandbox CSP; traversal, symlinks, non-images and another user's files
    are 404, no login is 401. `GET`/`PUT /api/u/:userId/photo-cloud` → `PhotoCloudSetting`
    (`policy: "never" | "ask" | "always"`); PUT validates and clears daily
    approval. All follow session/key checks and mutations require same-origin.
    HTTP `Capabilities` includes `upscale`, `video`, `animate` and `motion`, as core does.
    `GET …/file` also serves a clip (`video/mp4`) and answers one byte range
    (`Range: bytes=a-b` or `bytes=a-`) with 206 and `Content-Range`, or 416
    outside the file, so the browser's player can seek.
  - modes: `GET`/`PUT /api/u/:userId/mode` (`ModeDefault`), the mode new
    threads start in; `ThreadSettings` and `ThreadSettingsChange` gain
    `webSearch` and `images`, and their mode and switches are the effective
    ones, and so are its `grants` and `machines`;
  - models (paths under `/api/u/:userId/`):
    - **Endpoints:** `GET`/`POST endpoints`; `PATCH`/`DELETE endpoints/:id`;
      `POST endpoints/:id/discover`, `…/reset-ids`, `…/merge` (→ `EndpointInfo`),
      `…/models` (→ `OfferingInfo`); `GET …/probe`. Types: `EndpointInfo` (`api`,
      `addresses`, `fingerprint`, `hasApiKey`, `keyLast4?`, `planAccount?`,
      `cloudCapabilities?`, `unencrypted`, `stale`,
      `downSince`, `signedOut`, `models: OfferingInfo[]`), `OfferingInfo` (with `label`),
      `EndpointInput`, `EndpointChange`, `ModelInput`, `Probe`, `MergeInput`.
    - **Plans:** `POST plans/sign-in` (`PlanSignInStart`: `plan` and `name`,
      or `endpointId` to sign in again → `PlanSignInStarted` `{ id, url,
      code? }`); `POST plans/sign-in/:id` (`PlanSignInFinish` `{ redirectUrl? }`:
      ChatGPT's sends the address it was sent back to, Grok's no body →
      `EndpointInfo`); `DELETE plans/sign-in/:id`.
    - **OpenRouter:** `POST openrouter/sign-in` (`OpenRouterSignInStart`:
      `name`, `shared?` → `PlanSignInStarted` `{ id, url }`); `POST
      openrouter/sign-in/:id` (`OpenRouterSignInFinish` `{ code }` →
      `EndpointInfo`, a cloud endpoint holding the returned key); `DELETE
      openrouter/sign-in/:id`.
    - **Hosts:** `POST hosts` (pair, then discover); `POST hosts/:id/pair`
      (again, same addresses); `PUT …/addresses`; `GET …/status`; `POST
      …/pause|resume|restart`; `POST …/update` (→ `HostStatus`, to the release
      Lyrica runs, `409` when she runs none; administrators on a shared host);
      `POST …/models-folder` (`{ path }` → `HostStatus`: the host's updater
      moves it to that folder on the host machine; administrators on a
      shared host);
      `GET …/dashboard` (→ `{ url }`); `POST …/manage`;
      `GET …/hub/files`; `POST`/`GET …/downloads`, `DELETE …/downloads/:id`;
      `GET …/images`; `GET …/starters` (→ `{ starters: HostStarter[] }`);
      `POST …/starters/:starterId/install` (→ `{ recipe, downloads }`);
      `POST …/recipes/:recipeId` (including
      `{ do: "change", change: { op: "useFor", useFor: "fast" | "quality" | "both" } }`,
      saves on the host and refreshes discovery). Unpair is `DELETE
      endpoints/:id`. Types: `HostInput`, `HostRepair`, `HostAddresses`,
      `HostStatus` (with `commit` and `update` when the host has an updater),
      `HostUpdate` (`available`, `reason`, `changesFolder`, `state`, `tag`,
      `models`, `error`, `last`),
      `HostManage`, `DownloadInput`, `RecipeAction`.
    - **Offerings:** `PATCH`/`DELETE offerings/:id`; `POST …/replace`; `GET
      …/same`; `GET`/`PUT …/settings`; `PUT …/star`; `PUT …/separate`; `POST
      …/delete-copy`; `GET`/`PUT …/serving`; `POST …/reload`; `POST
      …/lookup`. Types:
      `CapabilitiesChange`, `ReplaceInput`, `AnswerSettings`, `OfferingSettings`
      (`sources`, `dropped`, `contextWindow` with its source),
      `OfferingSettingsChange` (`scope: "shared" | "mine"`), `DeleteCopy`
      (`usedIn`, `deleted`, `left`), `ServingSettings`.
    - **Groups and presets:** `GET`/`POST groups`; `GET groups/suggestions`;
      `GET`/`PATCH`/`DELETE groups/:id`; `GET`/`PATCH presets` (`thinking`,
      `fallback`, `sleepFallback`, `readAloudLive`, `freeOnly`, `readDaily`); `POST presets`
      (`{ name, column }`); `PATCH`/`DELETE presets/:id` (`{ name }`);
      `PUT columns/:column` (`{ preset }`); `PUT columns/:column/:task`
      (`{ models }`, `{ same }` or `{ model }`); `POST columns/:column/save`
      (`{ preset }` or `{ name }`). Types: `GroupInfo`, `GroupInput`,
      `GroupChange`, `GroupDetail`, `GroupSuggestion`, `PresetInfo`,
      `Presets` (the presets, the two columns, `thinking`, `fallback`,
      `sleepFallback`, `readAloudLive`, `freeOnly` and `readDaily`), `ColumnTaskChange`,
      `PresetsChange`.
    - **Models page, library, tokens:** `GET models/page` (→ `ModelsPage`:
      endpoints with `pageStatus` and each starred offering marked `starred`, hosts' status or error (`unpaired` when the
      host revoked this server), the presets and columns, the newest visible call,
      per-endpoint call counts over the shown pools (`endpointUses`, what ranks
      the sidebar's status panel, with `tokPerSec`, `promptTokPerSec` and
      `speedCalls` over its last 10 measured turns of the past day),
      the notice, the Clean up count, and `release` (`{ tag, commit }`) when
      Lyrica runs one); `GET models/cleanup`; `GET`/`DELETE
      models/notice`; `GET models/calls` (`?project=&pool=` filters both pool and project tree); `GET library/text`; `GET hub-tokens`,
      `PUT`/`DELETE hub-tokens/:hub` (`?shared=1`). Types: `ModelsPage`,
      `CleanupItem`, `ModelUse`, `ModelsNotice`, `CallInfo`, `TextLibrary`,
      `LibraryEntry`, `HubTokenInfo` (last four characters), `HubTokenInput`.
    - **Threads:** `ThreadSettings` gains `preset`, `presetChoice`, `thinking`,
      `thinkingLevels` and `answered`; `TaskModel` gains `list`, `label` and
      `modelId`. `ThreadSettingsChange.models` takes a ref, a list or null, and
      gains `preset` and `thinking`. `DELETE` on a thread calls
      `Models.forgetThread` for it and each subagent thread under it.
    - **Errors from core** (`statusOf`): `CloudModelForbidden`, `NoModel`,
      `PairingFailed`, `GitAccountProblem` and a plain `Error` (a validation
      message) are `400`; `AuthError` and `WrongPassword` are `401`;
      `Forbidden` is `403`; `SchemaTooNew` and `MigrationFailed` are `409`;
      `Offline` is `502`; `Locked` is `503`. A `HostRefused` keeps the
      host's meaning by `code`: `invalid` and `need_repo` 400, `refused` 403,
      `not_found` 404, `in_use` and `above_recommended` 409, `too_big` 413,
      `no_space` 507; any other code (`unreachable`, `paused`, `busy`,
      `unpaired`, `identity_changed`, …) is `502` with the host's plain
      message.
  - users and admin;
  - memory browser ([briefs/memory-browser.md](briefs/memory-browser.md)):
    `GET …/memory` → `MemoryOverview` (pages and notes counted over the
    pools the display shows, and when she last slept); `GET …/memory/about`
    → `MemoryTag[]`, the pool's distinct `about` words with counts;
    `GET …/memory/search` without `q` lists one layer when `kinds` names
    exactly one (newest first, `limit` and `before` paging by `updatedAt`),
    takes `about=` to filter notes by a tag, and its hits carry `title`,
    `about` and `updatedAt`; `kinds=entry` is the Recent layer
    ([briefs/side-panels.md](briefs/side-panels.md)), the logged
    messages written since sleep's watermark (`PoolStore.recentEntries`),
    a person's and hers only. `GET …/memory/:pool/e:<thread>#<n>` reads one
    such message as a `MemoryDetail` of kind `entry` (origin `user` or
    `lyrica`, `cameFrom` its thread, no revisions); PATCH, archive, restore
    and DELETE answer 405 for it, since a message changes only in its
    thread. `MemoryDetail.links: Record<ref, MemoryLink>`
    gives every memory and thread the text and the lineage cite its kind,
    pool, title, a snippet of its first words and its date; `usedIn` is
    `MemoryUse[]` (`{ id, sentence? }`), the sentence of each memory that
    cites this one. Titles, snippets and sentences come only from pools the
    display shows: a hidden pool's ref keeps its id and gets no link, and a
    general memory's detail never carries a private ref's title, snippet or
    sentence (a private citer is listed by id with no sentence), whatever
    the display. A thread forgotten with `keepMemories` still resolves: its link has `deleted: true`, no title, an empty snippet and `updatedAt` its deletion time. `GET …/threads/:pool/:threadId/tombstone` → `ThreadTombstone` (`{ id: "t:<thread>", deletedAt, memories: MemoryUse[], links, users }`, the notes and pages citing the thread, with their links) is `404` when the thread has no tombstone.
    `MemoryDetail.revisions` contains the current and newest earlier revision.
    `GET …/memory/:pool/:id/history` → `MemoryHistory { entries, total,
    detail }` returns versions newest first by revision ID and the current
    memory with display-safe links, including citations in the returned
    versions. A hidden pool returns 404. Search matches literal text, title,
    summary, author and date, case-insensitively. Differences are computed
    in the browser against the current text; Restore keeps its existing
    contract;
    `POST …/memory/export` (`MemoryExportRequest { items: { pool, id }[] }`)
    → `MemoryExport { name, markdown, count, skipped }`: the notes and pages
    as one Markdown file, built in memory for the browser to save (other
    kinds counted in `skipped`, a hidden pool 404). `POST …/memory/import`
    (`MemoryImport { files: { name?, text }[], pool? }`, up to 16 MiB) →
    `MemoryImportResult { imported, duplicates, renamed, linksKept,
    linksWorded, skipped }`, through `importMemories` (memory.md, "Export
    and import");
  - speech: `POST …/threads/:pool/:threadId/transcribe` and `POST
    /api/u/:userId/transcribe?pool=` (an `audio/wav` body, `?language=`) →
    `Transcription { text, seconds, model }`; `GET
    …/threads/:pool/:threadId/messages/:n/speech` (or `messages/live/speech`)
    streams raw PCM (`audio/pcm;rate=24000;encoding=s16le;channels=1`), with
    the message read from the store, never sent by the client;
    `ThreadSettings.speech` (`Speech`, also `GET /api/u/:userId/speech?pool=`)
    and `models["speech.transcribe"]`, `models["speech.speak"]` (thread tasks);
    `ThreadSettings.fallback` (null follows `Presets.fallback`) and
    `fallbackOn`, `ThreadSettingsChange.fallback`, `PresetsChange.fallback`
    and `sleepFallback`;
    `Presets.readAloudLive` and `Speech.readAloudLive` (Read aloud while she
    writes, off by default), `PresetsChange.readAloudLive`;
    `Capabilities.transcribe` and `speak`, `AnswerSettings.voices` and
    `speed`, `CallInfo.audioSeconds`;
  - history: `limit` (default 20, 1–100), `offset` (default 0,
    nonnegative safe integer) and `q` (trimmed, at most 200 characters) on
    `GET …/sleep/history`, `…/memory/:pool/:id/history`,
    `…/memory/journal/history`,
    `…/models/calls/history` and `…/models/downloads/history`. Invalid bounds
    return 400. Each returns
    `{ entries, total }`, where total counts matches before paging. Search
    and paging run on the server; hidden pools are excluded before counting.
    No search query, memory or message text is logged.
    Sleep entries are run metadata, ordered by startedAt then ID descending
    and pool ascending; search matches ID, date, status, skip reason and
    scheduled/manual reason. Call entries are `CallInfo`, newest first by
    stored ID; search matches model label, endpoint, task, thread ID, date,
    fallback and note. Calls accept the existing `project` and `pool`
    filters. The older `GET …/models/calls` array remains for existing clients.
    Journal history → `HistoryPage<MemoryHit>` of journal entries, newest
    updatedAt then ID descending and pool ascending, with optional `pool`.
    Search matches literal text and date; snippets render current mention
    names. Hidden pools are excluded, including when a pool is requested.
    Finished downloads → `DownloadHistory { entries: { endpointId,
    download: HostDownload }[], total }`, aggregated from hosts the user
    may manage (shared hosts require an administrator), excluding active
    work before counting. Ordered by startedAt and download ID descending,
    then endpoint ID ascending. Search matches host name, path, source,
    repository, state, date and error. `GET …/hosts/:endpointId/downloads`
    with `preview=1` returns all active downloads, only the newest finished
    one, and `finishedTotal`; without it, the existing host array remains.
    Clear finished reads history in pages and clears each returned entry.
  - sleep: overview (newest run per pool only), run detail, items (start a chat, dismiss), `sleep.mode`,
    start a run, and an event stream. `/sleep` typed in a thread is
    `SendRequest.confirm` and `SendResponse.sleep`.
- **Local socket:** a Unix socket (mode `0600`, owned by the service user)
  serves the same API to local clients; no `lyrica` subcommand uses it. The
  user still logs in with a password over the socket. Being on the machine
  isn't enough.
- **Scheduler:** at `sleep.time` (default 04:00) in each user's own time
  zone (`Profile.timeZone`, else the server's), for each user not in manual
  mode, sleep each pool, one run at a time across all users. The night's
  chores (model cleanup, sweep, idle project threads) run at `sleep.time`
  in the server's zone.
- **Updates** (docs/daemon.md, "Updates"): an update socket,
  `<runtime>/update.sock` (mode `0600`, the service user's, for root's
  updater; no login, and like the rest of the runtime directory never
  inside a sandbox; `LyricadOptions.update: { socket?: string | false,
  state?, requests? }`), serving only `GET /health` (`Health`: `{ commit,
  locked, checks: { name, ok, error? }[] }`, no text), `POST /drain`
  (`Drain`: refuses new turns; `{ busy: BusyItem[] }` with `BusyItem {
  kind: "turn" | "subagent" | "sleep", userId, pool?, threadId? }`, empty
  when idle) and `POST /undrain`. While draining, `SendRequest`, sleep
  starts, sleep-item chats, suggestion starts and a rewind with `then` are
  `409` with `{ updating: true }` (`Updating`; `503` stays "locked"). An
  administrator's `GET /api/u/:userId/admin/updates` (`Updates`: running
  release, kept releases with whether each can be rolled back to, the
  newest update note, the updater's state, `lastRollback`); `POST
  …/updates` with `{ tag }`, `POST …/updates/rollback` with `{ commit }`
  and `POST …/updates/check` write `<runtime>/updates/request.json` for the
  updater's path unit (`409` while an update runs, except a rollback on
  probation). `GET …/admin/status` (`AdminStatus`) carries optional
  `unitsStale: string[]` from the updater's `state.json`: Debian units that
  were missing or differed at the last update switch, shown in Status with
  the action to run `install.sh`. The updater never rewrites these units;
  NixOS does no comparison. GET also supplies `modelFacts: ModelCallFacts`
  (`since`, `until`, `pools`, `models[]`, `calls[]`): this authenticated
  administrator's own displayed pools, all retained call rows in the inclusive
  last 24 hours, grouped by offering ID with recorded label/endpoint, `kind`,
  `calls`, `outputTokens`, `speedSamples` with optional `medianTokPerSec`,
  `promptSamples` with optional `medianPromptTokPerSec`, and `fallbacks`; and
  each row as `{ at, offeringId, task, outputTokens?, tokPerSec?, fallback? }`,
  newest first, never its thread, note or text. Medians use existing
  `pace.tokPerSec` and `pace.promptTokPerSec`; no samples means absent, not zero. Fallbacks count nonempty
  recorded markers (skipped candidates, not errors/retries). No preview cap;
  the store's latest-500-per-user retention still applies, so this is not
  complete daily activity. No call text, other users, hidden pools or folded
  totals enter this aggregate. Passphrase mutation responses do not include it.
- **Schema versions** (`core/migrations`): each encrypted database records
  its schema version (`PRAGMA user_version`) and the oldest schema that can
  read it (`meta.min_reader`: an expand step leaves it, a contract step
  raises it). `STEPS[kind]` lists `MigrationStep { version, contract?,
  run(db, ctx) }` for `"self" | "user" | "pool"`; `SCHEMA` and `MIN_READER`
  are this release's. `migrate(db, kind, ctx?)` runs the missing steps in
  one transaction with foreign keys off, then `integrity_check` and
  `foreign_key_check`, and throws `MigrationFailed(kind, check)` leaving the
  database unchanged; opening one whose `min_reader` is above `SCHEMA`
  throws `SchemaTooNew(kind, minReader, schema)` (unlock answers `409`, and
  `/health`'s databases check fails). `checkReadable` does only that check,
  for read-only opens. Modules no longer create their own tables.

## bin/lyrica

One entry point with subcommands: `serve`, `admin`, `dev`, `version` and
`smoke-test`. `chat` and `mem` are reserved and not built (see
[DESIGN.md](../DESIGN.md#runtime)).
- `dev` refuses to start unless it is pointed at a development runtime: a
  directory with a marker file, created by `lyrica dev --init`.
- No subcommand reads a password from arguments or the environment.

## sleep

```ts
new Sleep({ users, memory, models, persona, proposals, hasKey, cwd, limits? })
sleep.run(userId, pool, reason: "scheduled" | "manual"): Promise<SleepRun>  // queued: one run at a time
// status: "complete" | "partial" | "skipped"
// skipReason: "no-key" | "endpoint-down" | "no-activity" | "plan-limit"
sleep.check(userId, pool)          // what would stop a run now, without recording anything
sleep.stop(userId)                 // Lock: the run is marked partial
sleep.prune(now?): number          // forgets phase threads older than 36 hours, memories kept
sleep.mode(userId) / setMode(userId, "scheduled" | "manual")   // user.db
sleep.events                       // started, phase, finished: IDs only, never text
```

- Each phase is a thread in the pool's `sleep` interface, never indexed for
  search, and forgotten with `keepMemories` 36 hours after it was made. It is opened through
  `openThreadSession` with that pool's `CallContext` and its
  `sleep.<phase>` model, so private sleep is local-only.
- The pool's `sleep_runs` and `sleep_items` tables hold runs and items. A
  `no-key` skip is recorded once the key is back, since the pool can't be
  written without it.
- `POST …/sleep/:pool/items/:itemId/chat` returns the item's existing thread
  on retry. If it has no assistant message with text and is idle, it retries
  her opening, answering an existing last hidden opening user entry without
  appending another; after her reply it sends nothing. `409` means the linked
  thread is gone. Opening a thread never re-sends the opening.
- Full details: [sleep.md](sleep.md).
- Consolidate keeps each project's page (`p:${projectSlug(id)}`) for every
  project with new conversation, from its notes and threads; the user's
  instructions on it are kept by the store. `write_page` refuses a
  `project-…` slug that names no project in the pool (unless the page
  exists) or an unlogged project's.

## core/workspace

`ThreadWorkspace.code` is a core preference, off by default, stored by
expand-only user step 14 (`thread_workspaces.code`). `inheritSettings`
copies it to descendants; each child can edit it independently. It is not
narrowed by ancestors and never changes permission mode.
`ThreadSettings` returns `code: boolean`; PATCH accepts `code?: boolean`.
The daemon's `Task` and `THREAD_TASKS` include `code`. A thread's `code`
override wins in code mode; its Chat override does not apply. Thread model
selection continues to use `preset`, never a profile choice.
`threads({ action: "code", on, task?, done? })` changes the next turn and,
when `task` or `done` is given, replaces the pool.db task text, emitting `settings`; subagents are refused.
`ThreadsHost.codeOn(from)` reads the thread's effective `code` setting.
Outside a project chat, her first successful `edit` or `write` of a session
while code mode is off carries `CODE_NUDGE`, once.
`threads({ action: "model", model })` sets the thread's own Chat model (and
its `code` model in code mode) to the one chat model the name fits, as a
step's `model` resolves, from the next turn, emitting `settings` so the
header's model picker and Thread settings follow; a name that fits none or
several is refused with the closest; subagents are refused.
Project settings carry optional `threadsCode`, stored in encrypted user
settings (`project.code.<pool>/<id>`), removed on forget. New child and
routine threads apply it beside `threadsModel`; unset inherits the parent.
`threadsModel` becomes a new thread's own `code` model when that thread
starts in code mode, and its own `chat` model otherwise.
The watcher exposes cached open PR checks via `codePulls`, without a new
network call, and drops that cache on Lock.

```ts
new Workspace(keyring, users, { excludePorts, frontDoor? })
// excludePorts: lyricad's own ports, refused on every address; required, [] for none
// frontDoor(): FrontDoor { ports, hosts, exclude }, read at each sandbox start:
//   the proxy's ports, refused on this machine's addresses, on every address
//   `hosts` has ever resolved to, and on the proxy's addresses
resolveAddresses(hosts): Promise<string[] | undefined>   // undefined: never resolved, so no network
interface WorkspaceThread { userId; pool; threadId; project?; coordinates? } // project: owning project, passed through subagents at every depth; coordinates: a project chat, whose grants and clones are read-only to it
interface Network { internet: boolean; services: boolean; hosts: string[] }
interface ExecutionTarget {               // name: "sandbox" | "ssh:<name>"
  cwd(): Promise<string>;
  ops(): { read; write; edit; bash };     // Pi's tool operations
  folders(): string[];                    // host folders, or "<ssh name>:<root>"
  run?(argv, { signal?, timeoutMs?, cwd? });  // the sandbox's
  secrets?(): string[];                   // the sandbox's tokens and placeholders, hidden in output
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
settings(userId).commandRules(pool, project): CommandRule[]
settings(userId).setCommandRules(pool, project, rules) / addCommandRule(pool, project, rule)
// CommandRule { prefix; decision: "allow" | "ask" | "forbid" }; at most 100; duplicate prefix replaces.
// user step 6 adds project_settings.command_rules, JSON default []; Projects.set upserts other columns.
// rules.ts exports commandRules (validation), decide, alwaysAllowPrefix; machines.ts exports simpleCommands.
settings(userId).checks(pool, project): string[] / setChecks(pool, project, checks)
// checkChecks: at most 8 commands, each one line of at most 300 characters, no control characters; blanks dropped.
// user step 16 adds project_settings.checks, JSON default [].
settings(userId).setup(pool, project): string | undefined / setSetup(pool, project, command)
// one line of at most 300 characters, no control characters; blank or null clears it. user step 19 adds project_settings.setup, NULL default.
settings(userId).skillsAutoApprove() / setSkillsAutoApprove(on)   // her skills active at once; user.db setting skills.auto_approve
forThread(t)  // { commandRules(), checks() (the project's; none outside one or in its chat), target(machine?), previewTarget(), settings(), machines(), proxmox(machine, action, vm?), allowedInThread(machine, command), setMode(), network(), claudeCode(), folders(), recordChange(), fileKey(path), madeFiles(paths), madeSince(since, found?), fileNotes() },
fileKey(t, path)  // one file under the same key for every thread that can write it: "<folder thread>:<path>" in a thread's folder or /shared, "grant:<path>" in a writable grant; else undefined
              // each read fresh; settings() is effective; fileNotes() takes (reads and clears) what the Files panel added and removed
files(t): ThreadFiles                     // the Files panel, every call a fresh no-network sandbox over the thread's grants:
  // roots(), list(dir), search(root, q), images(), read(path, range?) → { stream, size, type } (only the range's bytes; RangeError past the end), upload(dir, name, bytes) → path,
  // mkdir(path), rename(from, to), remove(paths), zip(paths) → Readable. FilesRefused: outside the grants, a root, .lyrica, read-only.
changes(userId): FileChanges              // her write and edit calls' changes, for removing turns
checkouts(t): { name, path, kind }[]     // where its code lives, for the changes view: worktrees, clones, writable grants (docs/daemon.md "Changes")
targetFor(t, machine?): ExecutionTarget  // the sandbox, or an SSH machine the thread may use now (a Proxmox one is refused)
machinesFor(t): ThreadMachine[]           // { name, kind, limit, root, asUser? }: granted by it and every ancestor, of its pool
proxmox(t, machine, action, vm?): Promise<string>  // one PROXMOX_ACTIONS call on a thread's Proxmox machine, token sent only to the pinned certificate
callMode(t, machine?): PermissionMode     // on a machine, stricterMode(effective(t).mode, its limit)
probeMachine(userId, login, { kind?, name, address, draft?, asUser? }): Promise<MachineProbe>
  // SSH: a key pair kept in memory for an hour (by `draft`), its keyLine and setup steps, the host key seen,
  // whether the login worked, offNetwork; asUser gives the own-account setup (no root); account root refused. Proxmox: the certificate's fingerprint and the pveum setup, no token sent.
  // Saves nothing.
addMachine(userId, { kind?, name, address, root, pool, limit?, draft? | token?, hostKey, offNetworkConfirmed?, asUser? }): Promise<MachineConfig>
  // Proxmox: tries the token against the confirmed certificate and refuses the Proxmox running Lyrica (ownNode)
updateMachine(userId, name, { address?, root?, limit?, pool? }): Promise  // a new pool drops the machine from every thread; an address naming another account is refused; Proxmox: own-node address refused
setHostKey(userId, name, hostKey, token?): Promise / confirmOffNetwork(userId, name) / removeMachine(userId, name)
grantsFor(t): Grant[]                     // { path, writable }
folders(t): string[]                      // grants, and "<machine>:<root>" for its machines with a root
network(t): Network
inheritSettings(parent, childThreadId, narrower?)  // subagents and child threads: same or stricter (folders, network, mode, webSearch, images, claudeCode), never wider
claudeCodeFor(t): boolean                 // Claude Code for a run: general, not local-only along its chain (WorkspaceOptions.restricted; without it never), switch on, token saved, reaches api.anthropic.com
settings(userId).detach(threadId)          // a kept child, once its parent is forgotten: no longer narrowed by it
// Project code threads have their own folder; other child threads share their parent's (folderThread).
sharedDir(t): string | undefined          // shared/ in the folder of the family's topmost thread (settings.familyRoot; the project chat in a project):
  // SandboxSpec.shared, mounted at /shared (SHARED) for the whole family; undefined when a thread made it a file or link,
  // or when sharesFamilyFolder(t) is false: a local-only thread (or ancestor below the top) under a top that isn't restricted
sharedOwn(t, shared): string              // the thread's own shared/<id>/ (made, replacing a file or link there): SandboxSpec.sharedOwn,
  // mounted read-write at /shared/<id> over a read-only /shared; a write elsewhere in /shared throws SandboxDenied. Not for t.coordinates.
  // In the top thread, whose WORKDIR holds shared/, WORKDIR/shared (and its alias's) is mounted read-only over it too
familyFolders(t): { path, dest }[]        // SandboxSpec.family: every other family member's folder (settings.family(root), by folderThread),
  // mounted read-only at /thread-workspaces/<id> (FAMILY_ROOT); a local-only member's only for a local-only reader; a write throws SandboxDenied.
  // Only members WorkspaceOptions.onlyIn(userId, t.pool) passes (in the reader's pool and not the other; without it, none), and none at all
  // when settings.narrowed(t.threadId): it or a thread above it was started by inheritSettings with fewer folders or repositories.
  // settings.family(root): root and every thread below it in thread_workspaces. Worked out at every sandbox start.
tmpDir(t): string                         // a project chat's lasting /tmp, tmp/<id> in the home (SandboxSpec.tmp); the sweep and forgetting remove it
// forThread(t).family() → { folder, handover? }: where its family reads its folder, and its own /shared/<id> (ThreadTools.family, familyLine)
// SandboxSpec.readOnly (t.coordinates, a project chat and its subagents): /workspace, its alias and /shared mount read-only and
//   a write the tools try throws SandboxDenied naming a code thread; its /tmp is SandboxSpec.tmp, which lasts between commands
settings(userId): WorkspaceSettings       // per-pool defaults, per-thread overrides, machines
// MachineConfig { name, kind: "ssh" | "proxmox", host, port, username (Proxmox: token id), privateKey (Proxmox: the token),
//   root (Proxmox: null), asUser (SSH: the user's own account; Proxmox: false), hostKey (Proxmox: certificate fingerprint AB:CD:…), pool,
//   limit: "ask" | "acceptEdits" | "auto" (new machines "ask"), offNetwork, lastUsed,
//   state: { kind: "online" | "unreachable" | "keyChanged", since } | null }
// settings(userId).machines() / machine(name) / addMachine(m, confirmedHostKey) / updateMachine / setMachinePool(name, pool)
//   / setHostKey / setOffNetwork / confirmOffNetwork / machineState(name, kind) / removeMachine / allowInThread(threadId, machine, command) / allowedInThread(threadId)
// A thread's `machines: string[]` (the sandbox is always there); setThread refuses a machine of the other pool;
//   inheritSettings takes a subset; effective() keeps only machines every ancestor grants.
// SUSPECT_COMMANDS, suspectCommand(command), writtenFiles(command) (the targets of its redirections and tee), onFloor(path), cleanOutput(onData), maskKeys(buf) (shares removePrivateKeys from core/src/secrets.ts),
//   authorizedKeysLine(publicKey), machineSetup(account, keyLine, asUser?): core/src/workspace/machines.ts
// page.ts: LIBS ("/opt/libs"), LIBRARIES (three, simplex-noise, @tweenjs/tween.js), libraryDirs() (each found in Lyrica's node_modules,
//   with its version; the sandbox mounts each read-only at LIBS/<name>, and allow() lets reads there), librariesLine(),
//   PREVIEW_SCRIPT (page-preview.cjs: Chromium over the DevTools pipe, SwiftShader WebGL, every non-file request failed; prints
//   PreviewOutput { console, errors, blocked, loaded, title?, canvases?, text?, png?, fail? }), decodePng(png) (8-bit RGB or RGBA,
//   non-interlaced), pixelStats(img) { background, drawn, colours }, checkPage(html): PageCheck { loads, calls, local },
//   describeCheck(c), bundlePage(entry, read): { html, inlined } (esbuild in lyricad, every file through `read`; bare names by the
//   page's import map, then LIBRARIES).
// proxmox.ts: PROXMOX_ACTIONS (status, list, start, stop, shutdown, reboot, snapshots), PROXMOX_READS, PROXMOX_SUSPECT (stop, reboot),
//   suspectKey(tool, input) (what Allow in this thread stores), proxmoxAction(call, action, vm?), ownNode(call, addresses, self), ownAddress(addresses, self),
//   proxmoxSetup(), parseProxmoxAddress, tokenId, certFingerprint. ProxmoxTransport { fingerprint(host, port), call(endpoint, method,
//   path, verify(fingerprint)) }; `proxmoxHttps` is Node's TLS; WorkspaceOptions.proxmoxTransport and .self replace them.
settings(userId).defaultMode() / setDefaultMode(mode)  // the mode new threads start in (default auto)
settings(userId).startThread(threadId, pool)           // fixes the default mode on a new thread
settings(userId).effective(threadId): ThreadWorkspace  // strictest mode and switches of it and its ancestors; only the folders
//   (read-only where any ancestor's is), machines and repositories every ancestor grants. Sandbox, Files panel, grantsFor and folders() use it.
//   setThread on a parent writes the narrowing into its descendants' rows; checkInherited no longer refuses a dropped folder.
allowedPaths.allow(actor, userId, pool, path) / disallow(...) / list(userId)
  // NEVER_GRANTED (Caddy's runtime, /opt/lyrica, the updater's state and snapshots) and LYRICA_HOME are refused, and rows
  //   overlapping them are left out of list()
credentialsFor(t): Credentials            // the thread's reachable repositories' tokens and Claude Code's, for SandboxSpec.credentials, never the env (Git accounts below); targetFor
  // passes it as the sandbox's env, never argv, and `repos` (reposDir(t)) mounted at /workspace/repos
saveUpload(t, name, bytes): Promise<string>  // cleans the name (cleanUploadName), never overwrites; a project chat's (t.coordinates) go in shared/uploads (/workspace/shared/uploads, its threads' /shared/uploads)
imageFiles(t): ThreadImages
// ThreadImages.content(path): HomeFile { stream: Readable; size; type }; relative or /workspace/ paths,
//   the thread's folder only (including the shared project folder); traversal/symlinks/nonfiles → HomeFileMissing.
// ThreadImages.read(path): Promise<{ input: ImageInput; portrait: boolean }>; ordinary paths via ThreadFiles,
//   /photos-of-me/<file> from that user's mounted encrypted home, refusing symlinks/traversal; at most 20 MB, PNG/JPEG/WebP.
// ThreadImages.read also marks bytes whose SHA-256 was recorded as a derived portrait, regardless of path; and every read
//   once this thread's folder is marked (a portrait result was saved there), or a read of a marked folder at
//   /thread-workspaces/<id> or /shared (folderOf, Workspace.originKey).
// ThreadImages.readClip(path): Promise<Uint8Array>; a workspace MP4 (a driving clip) via ThreadFiles, at most 64 MB, in memory.
// ThreadImages.save(GeneratedImage[], portrait = false): string[]; exclusive images/<uuid>.png in the encrypted thread folder,
//   removes PNG metadata, refuses symlinks, returns /workspace/images/<uuid>.png paths. A project chat's (t.coordinates,
//   as saveUpload) go in shared/images (/workspace/shared/images/<uuid>.png, its threads' /shared/images).
//   With a portrait input, records each result's SHA-256 in encrypted user.db settings before writing; descendants inherit the rule.
// ThreadImages.saveVideo(GeneratedVideo): string; exclusive videos/<uuid>.mp4 (a project chat's shared/videos/), with its
//   poster, PNG metadata removed, written first as the clip's thumbnail (.lyrica/thumbs/videos/<uuid>.mp4.png).
// ThreadImages.content(path, range?: { start, end? }) streams those bytes; a start past the end throws RangeError.
photos(userId): PortraitPhotos
// list(): PortraitPhoto[] { path; size; type }; upload(bytes): path (PNG/JPEG/WebP, 20 MB, metadata removed,
//   exclusive generated name); remove(name): void. Every access checks the user's key and mounted home.
// content(name): HomeFile; one PNG/JPEG/WebP in the portrait folder, refusing traversal/symlinks/non-images.
settings(userId).photoCloudPolicy(): "never" | "ask" | "always" / setPhotoCloudPolicy(policy)
settings(userId).photoCloudApproved(day): boolean / approvePhotoCloud(day) // encrypted day only; no prompt
settings(userId).isPortraitImage(hash): boolean / recordPortraitImage(hash) // additive images.portrait.sha256.<hash> settings, no schema step
settings(userId).isPortraitFolder(folderThread): boolean / markPortraitFolder(folderThread) // additive images.portrait.thread.<id> settings; save(…, portrait) marks this thread's
mountHome(userId) / unmountHome(userId)   // gocryptfs; mount when the user's key becomes available; makes photos-of-me/ outside thread folders
selfTest(): Promise<string | undefined>   // lyricad calls this at startup
```

- Every sandbox run receives exactly the thread's grants, the thread's folder
  in the home workspace, and a read-only system.
- **Workspace settings live in the user's `user.db`:** each thread's grants,
  network switches, permission mode, `webSearch`, `images` and `claudeCode` switches and
  machines and allowed suspect commands, and the machines. Allowed
  paths are the exception (below). Workspace never adds tables to the pool
  databases, which belong to Memory.
- **Network:** every thread has two switches (internet, and this machine's
  services) and an **allowed hosts** list. Each has per-user, per-pool
  defaults and a per-thread override.
  - Nothing on, list empty: `--unshare-net`.
  - Otherwise the sandbox gets its own network namespace, served by `pasta`, with
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
- **Git accounts and repositories** (DESIGN.md, "Updates and
  self-editing"): `settings(userId).gitAccounts() / gitAccount(name) /
  addGitAccount({ name, kind, host, account, token, pool, offNetwork },
  state?) / updateGitAccount(name, { name?, host?, account?, pool? }) /
  setGitToken(name, token, state?) / removeGitAccount(name) /
  gitAccountState(name, state) / setGitOffNetwork(name, off) /
  confirmGitOffNetwork(name)`; a new pool drops the account's repositories
  from every thread, removing it does too, and a new name follows into
  them. `GitAccountConfig { name, kind: "github" | "forgejo" | "gitea" |
  "other", host, account, token, pool, offNetwork, state: { kind:
  "signedIn" | "rejected" | "unreachable", since } | null }`; `kind:
  "github"` is general only; a private account's host must resolve on this
  machine's network, checked when added and on every use. A thread's row
  carries `repositories: { name, account, readOnly? }[]`; `setThread` refuses a
  repository whose account is missing or of the other pool, and two with
  the same clone folder, and keeps a child's read-only repository
  read-only; `inheritSettings` takes a subset; `effective()` keeps only
  repositories every ancestor grants, read-only where any ancestor's is,
  and a parent's change narrows its running children, moving a repository
  it moves to another account and adding one it gains to children that
  had all of its (read-only where `inheritSettings` was given only
  read-only ones, kept as the `workspace.readOnlyRepos.<thread>` setting,
  "1" or "0"; a child without it, from before it existed, gains nothing). `ForgeCredential.readOnly` has the relay
  refuse `git-receive-pack` and every API request but GET, HEAD and a
  GraphQL query. `Workspace`: `probeGitAccount({ kind, host,
  account, token })` checks the token against the host and saves nothing
  (`GitAccountProblem` with the state when it fails); `addGitAccount(userId,
  { …, offNetworkConfirmed? })`, `updateGitAccount`, `setGitToken`,
  `confirmGitOffNetwork`, `removeGitAccount`; `listRepositories(userId,
  name, q)` is what the account can see (none for Other).
  `repositoriesFor(t)`; `cloneFor(t)` makes or fetches each clone in the
  sandbox under the thread's folder in the home workspace (`repos/<name>`,
  a subagent's under its parent's, mounted read-only for one with
  `reposReadOnly` and for a project chat, though `cloneFor` itself may
  write them), then installs each clone's dependencies (`setup.ts`:
  `SETUP_SCRIPT`, `setupOutcome`, `SetupFailures`; docs/workspace.md, "Dependencies"),
  and returns the problems, never removing
  one (a clone goes with the thread); `addRepository(t, r)` is the
  `add_repository` tool's change. `credentialsFor(t).forge` holds the
  tokens; it is empty when the thread is of the other pool, has no
  repository, or can't reach the host (`reachesHost`). A sandbox with
  `SandboxSpec.credentials` opens a relay per run (`openRelay`,
  `core/src/workspace/relay.ts`), a loopback port forwarded into the run
  that closes when the run ends, and gives the run `gitEnv` with a
  placeholder per token: one credential helper and proxy per repository
  URL (`useHttpPath`, `http.<url>.proxy` with the run's capability,
  `http.<url>.sslCAInfo` at `/run/lyrica/certs/run.pem`) and
  `LYRICA_GIT_*` for the `gh` and `tea` wrappers
  (`core/src/workspace/forge.sh`, mounted first on the run's PATH), which
  pick the account by the clone's origin. The relay swaps a placeholder
  only on its repository's Git paths and its host's API, and refuses it
  elsewhere. Never argv; never a file, except the `tea` config the wrapper
  writes on the run's tmpfs, with the placeholder. The thread row's `repositories` column and the
  `git_accounts` table are user step 2 in `core/src/migrations.ts`. API:
  `/api/u/:userId/git-accounts` (`GET`; `POST …/probe`; `POST`; `PATCH
  …/:name`; `POST …/:name/token`; `POST …/:name/confirm-off-network`;
  `DELETE`); `GET …/git-accounts/:name/repositories?q=`; thread settings
  carry `repositories`. A sandbox's tools have `git`, `gh` and `tea`. The
  Git guide is a prompt section (`extension/src/git.md`) added to every
  turn of a thread with repositories.
- **MCP servers API:** `lyricad`'s `/api/u/:userId/mcp-servers` (`GET`;
  `POST …/probe`; `POST`; `PATCH …/:name` for name, url, pool and
  `offNetworkConfirmed`; `POST …/:name/token`; `POST …/:name/confirm-off-network`; `DELETE`), each
  server as `McpServerInfo { name, url, host, pool, hasToken, tools,
  description, offNetwork, state? }`, with any query value named like a
  credential (key, token, secret, sig, auth, pass) shown as `•••`, as in
  `EndpointInfo.baseUrl`; a `PATCH` that sends `•••` back keeps the stored
  value if the origin is unchanged (`daemon/src/redact.ts`); a body with `command` (stdio) is
  `400`. Thread settings carry `mcpServers` (names). User database step 3
  adds `mcp_servers` and `thread_workspaces.mcp_servers`. In core:
  `settings(userId).mcpServers() / addMcpServer / updateMcpServer /
  setMcpToken / removeMcpServer / mcpServerState / confirmMcpOffNetwork /
  allowToolInThread`, and `mcpUrl`, `probeMcp`, `mcpTransport`,
  `keepResult` (`core/src/workspace/mcp.ts`). A session gets
  `createMcpServersExtension({ mcpServers(), checkMcpServers?(),
  mcpServerState?() })` (`extension/src/mcp.ts`), which registers each
  granted server with Pi's `registerMcpServer`, exposure `deferred`, and
  loads Pi's MCP and `tool_search` extensions with no `mcp.json`, no log
  and Lyrica's transport.
- **Codex API:** `lyricad`'s `/api/u/:userId/codex` (`GET`; `DELETE`
  signs out) and `POST …/codex/sign-in` (starts Codex's device sign-in,
  replacing one under way; `409` when `codex` isn't installed), each
  answering `CodexStatus { installed, signedIn, signIn? { url, code } }`.
  Core exports `codexImage(box, request, signal)`, `codexSignedIn(box)`,
  `codexSignIn(box)`, `codexSignOut(box)` and `CODEX_DISABLED`, where a
  `CodexBox { home, inner, installed, start(args, cwd?) }` is
  `Workspace.codexBox(userId)`: Codex in a sandbox of its own
  (`codexSandbox(home, door)`), its home `codex/` in the encrypted home
  workspace.
- **Claude Code API:** `lyricad`'s `/api/u/:userId/claude-code` (`GET`;
  `PUT { token }`; `DELETE`), each answering `ClaudeCodeStatus { token,
  installed }`: whether a token is saved, never the token. Thread settings
  carry `claudeCode` (the effective switch) and `claudeCodeOffered`; a
  change turning it on in a private or local-only thread, or local-only on
  while it is on, is `400`. User database step 4 adds
  `thread_workspaces.claude_code`; the token is `claude_code.token` in
  `settings` (`settings(userId).claudeCodeToken() /
  setClaudeCodeToken(token | null)`). A run with
  `SandboxSpec.credentials.anthropic` gets the run's relay as
  `ANTHROPIC_BASE_URL` and its capability as `CLAUDE_CODE_OAUTH_TOKEN`,
  the `claude` wrapper (`core/src/workspace/claude.sh`) at
  `/run/lyrica/bin/claude`, and `SandboxSpec.claudeDir`
  (`Workspace.claudeDir(t)`, `claude/<thread>` in the home workspace)
  mounted at `/run/lyrica/claude` for its settings and transcripts.
  `claudeCodeInstalled()` says whether the program is among the sandbox's
  tools.
- **Machines API:** `lyricad`'s `/api/u/:userId/machines` (`GET`; `POST
  …/machines/probe` for the Test step; `POST …/machines` to confirm;
  `PATCH …/machines/:name` for address, root, pool and limit; `POST
  …/machines/:name/key` with a confirmed host key; `POST
  …/machines/:name/confirm-off-network`; `DELETE`). The probe and the
  confirm take `asUser` for the user's own account, and such a machine
  carries `asUser: true`. A machine carries
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
- **File origins** (`ORIGINS_SCHEMA`, user.db step 15): `file_origins`
  holds `(folder, path) → thread, at`, the thread that last wrote each file,
  where `folder` is the id of the thread whose folder holds it and `path`
  is inside that folder (`/shared/x` is `shared/x` in the family's topmost
  folder, `Workspace.originKey`). Paths and ids only. `WorkspaceSettings`
  `recordOrigins(folder, paths, thread, since?)` (with `since`, a row
  another thread wrote at or after it is kept), `origins`, `moveOrigins`,
  `dropOrigins`, `pruneOrigins(folder, dir, names)`, `forgetOrigins(threads,
  folders)`, `sweepOrigins(exists)`. `Workspace.madeFiles(t, paths, since?)`
  and `madeSince(t, since)` record her writes, uploads (`saveUpload`, the panel's) and images;
  `fileOrigins(t, entries, dir?)` reads them for a listing, and a whole
  listing of `dir` prunes what it no longer holds. `ThreadFiles` takes
  `OriginEvents { added?, moved?, removed? }` for the panel's uploads,
  renames and deletes.
- **Allowed paths** live in `self.db` (`workspace_paths`, keyed by user ID)
  and change only with an administrator actor. Paths overlapping
  `NEVER_GRANTED` (`/run/lyrica-caddy`, `/var/lib/lyrica-update`, `/var/lib/lyrica-snapshots`) are refused, because sandboxes run with
  `lyricad`'s groups.
- See [workspace.md](workspace.md).

## UI rules that cross components

- The current model and endpoint, with a cloud or local badge, are always
  visible in a thread.
- **Show general**, **Show private** and **Show hidden threads** are per-user
  display filters.
- The sidebar has a Sleep section.

The home composer reads `GET /api/u/:userId/thread-defaults?pool=general|private`
for `ThreadSettings` without creating a thread. On Send it creates the thread,
PATCHes changed settings, uploads attached files, then sends the first message.
The read-only defaults route uses the same defaults as thread creation and
requires the addressed user's session; it returns no thread or memory text.

### Thread usage

`GET /api/u/:userId/threads/:pool/:id/usage` → `ThreadUsage { tokens,
input, output, gpuMs?, cacheHit?, models: { label, kind?, tokens, input, output, gpuMs?, cacheHit? }[],
threads?: { threadId, tokens, input, output, gpuMs?, cacheHit? }[] }`. `input` is every
request's reads, cached reads included, and `output` what was written; they
split `tokens`, except that totals folded before user step 17 count in
`tokens` alone. `cacheHit` (0 to 1) is the share of input the server said it
read from its cache (`read_tokens - processed` over `read_tokens`), over the
kept call records that measured it, a subagent's under its parent's thread;
absent where none did. A subagent's tokens, stored as it works, and a local
one's GPU time count under its parent's thread too. Requires the addressed user's session and thread;
missing thread is 404. Models sort by tokens descending. `threads` appears
only for a project chat: the chat first, then descending tokens. The total
is also `ProjectOverview.tokens`. User step 10 adds nullable
`model_calls.read_tokens` and `call_totals` keyed by pool, thread, label,
kind, with tokens, gpu_ms and calls; expand-only user step 17 adds
`input_tokens` and `output_tokens` (default 0). Pruning folds counted chat and code records
before deleting them, in one transaction; forgetting removes their totals.

## Push notifications

Principles 6 and 2: decision requests reach the user without sending their
words. `daemon/src/push.ts` reuses `notifications()` with the saved display,
including every page, and selects `decision && type !== "sleep"`. The tick
catches every type; permission and settings events also trigger a check. Locked users are skipped; key availability
and saving a URL trigger an immediate batch of unsent decisions.

`core/src/push.ts` exports `PushSettings { url: string; token?: string;
link: boolean; origin: string }` and `PUSH_LIMITS { window: 30000,
minimumGap: 60000, timeout: 10000, retries: 2 }` (milliseconds). Ordinary
changes batch for at least 30 seconds, with at least 60 seconds between
automatic batches, including failed attempts. Held items join the next batch.
Retries wait 1 then 2 seconds and re-resolve each time. A successful send
records IDs in encrypted user.db's `push_sent (id TEXT PRIMARY KEY, at
INTEGER NOT NULL)`, added by expand-only **user step 11** (steps 9 and 10
are project drafts and usage totals). Rows older than 30 days or absent
from the current decision list are pruned at each diff. An ID that clears
and returns therefore pushes again; restart keeps delivered IDs and the
last attempt time. URL, token and failure state live in encrypted `settings`.

- `GET /api/u/:userId/push` → `PushInfo { host, path, set: boolean,
  token: boolean, link: boolean, lastFailure?: { at: string, status: number } }`.
  `path` is `/•••` when set; neither URL path/query nor token is returned.
- `PUT` at the same path takes `PushSettings`, validates before saving and
  returns `PushInfo`. `origin` is the browser's saved `location.origin`.
  `DELETE` clears URL, token and failure, returning 204. All require the
  addressed user's session; mutations use the usual origin check.
- `POST …/push/test` sends `Test from Lyrica.`; 204 on success, 502 with
  `{ status, reason }` otherwise; 400 without settings. Status 0 means no
  HTTP response or a refused destination. Failure reasons are fixed text.
  Last failure is an ISO timestamp and status; success clears it.
- Sends are plain-text POSTs with `Title: Lyrica`, `Tags: bell`, optional
  `Authorization: Bearer <token>` and no redirects. `Click` is absent
  unless `link` is true, then it is the saved origin plus `/notifications`,
  without any user ID. The web `/notifications` landing route goes to the
  signed-in user's Notifications page, through sign-in/unlock if needed.
- HTTPS is required except for administrators using HTTP on their own
  network. Non-administrators may use only public HTTPS hosts. Both schemes
  refuse loopback, link-local, unspecified/multicast and this machine's
  addresses and the configured tailnet/proxy front door. `pushTarget` reuses exported `resolveHost` and `inOwnNetwork`
  from core/workspace, validates all answers at Save and every send, and
  pins the actual connection to a checked address. Logs contain only host
  and status, never path, query, token or receiver response text.

`PUSH_PHRASES` is exported from `daemon/src/push.ts`; it is the only source
of single-item push wording. No titles, questions, pool names or details
enter a payload. Multiple items use `<n> things are waiting.`.

| Notification type | Body |
|---|---|
| question | A question is waiting. |
| permission | A permission is waiting. |
| share | A share is waiting. |
| suggestion | A suggested persona change is waiting. |
| approval | A persona change waits for approval. |
| update | A thread is waiting on you. |
| any other type | Something is waiting. |
