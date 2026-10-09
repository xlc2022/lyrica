# Memory

**Status: agreed.** The sleep cycle is in [sleep.md](sleep.md).

Li's requirements:

1. Lyrica saves whatever she wants, without asking.
2. She retrieves it when it's relevant, without being told to look.
3. Li can search and edit her memories.
4. For any memory, you can see where it came from and what it was consolidated
   into.

## Layers

Each layer cites the one below it by ID, inline in its text. Reading the
citations downward gives a memory's sources. Reverse lookups ("what was this
consolidated into?") are computed from the same citations, so there is only one
source of truth.

| Layer | What it is | Written by | Cites |
|---|---|---|---|
| **Threads** | Pi session entries: what was actually said | Pi, stored by `lyricad` | none |
| **Notes** | Small, dated observations: one fact, event, preference or decision each | Lyrica in conversation (`remember`), or sleep when she missed something | Thread entries |
| **Pages** | Her current understanding of one subject (a project, a person, an area of Li's life, herself) | Sleep | Notes |
| **WAKE** | First-person orientation: what's in motion, what's unresolved, what she wants to bring up | Sleep | Pages and notes |
| **Journal** | Sleep's reflection and dreams, including persona proposals | Sleep | Anything |

Pages replace Monika's single `FACTS.md`. One large file can't show which
sentence came from where. Pages split the same content by subject and keep
citations.

## Storage

Memory lives in encrypted SQLite (SQLCipher), with separate databases for each
user and pool:

```text
runtime/
  self.db                      shared: persona (with revisions), global settings, and the users
                               index (login, admin flag, profile, password-wrapped key)
  users/<user-id>/
    user.db                    endpoint and model settings
    general.db                 threads, entries, notes, pages, WAKE, journal, index
    private.db                 same tables, private pool
```

Each user (one of Li's personas) has their own databases, endpoint
settings and memory pools. Lyrica's persona is the only thing shared between
users.

- **Two pools per user.** The **general** pool may use cloud models or a
  custom endpoint. The **private** pool may use only a custom endpoint. Nothing
  in the private pool ever reaches a cloud model.
- **Separate files, separate keys.** A general thread's code only ever opens
  `general.db`, so private memory can't reach a general context by mistake. A
  private thread opens both: it reads general memory and writes only to its
  own database. That's safe because private threads run only on a custom
  endpoint.
- **Threads are stored in the database too.** The daemon runs Pi sessions with
  an in-memory session manager (`SessionManager.inMemory(cwd, opts, entries)`
  in Pi 1.1). It loads entries from the database and writes new ones back.
  Every interface, including `lyrica chat`, goes through `lyricad`, so no
  thread is ever written as a plaintext file.
- **Full-text search lives inside the encrypted database** (FTS5). There is no
  plaintext index.
- **Unlocking.** The `lyricad` passphrase unlocks `self.db`. As a service,
  `lyricad` starts locked and the web UI shows an unlock page. Each user's
  databases are unlocked by that user's password at login. "Save credentials"
  (for `lyricad` or for a user) keeps the key with systemd credentials, sealed
  to the TPM if one exists. That trades protection for convenience, and the
  settings page says so.
- **Backups** are encrypted (restic or borg). Memory never goes into a git
  repository.

Tables in a pool database, roughly: `threads`, `entries`, `notes`, `pages`,
`wake`, `journal`, `citations`, `revisions`, `tombstones`, plus FTS tables.

A note's text carries inline citations such as `[e:web/3f7a2c#41]`, and a
page's text carries citations such as `[n:20261009-k3f9]`. The `citations`
table is derived from the text, so "came from" and "used in" are cheap queries.

Example note:

```text
id: n:20261009-k3f9   created: 2026-10-09T14:02Z   about: proxmox, backups
[[u:7c1e]] wants the Proxmox cluster off the old NAS before winter, and
[[u:7c1e]] is worried about the backup job on node 2. [e:web/3f7a2c#41]
```

It is stored with a user token (see [Names and pronouns](#names-and-pronouns)).
Everyone who reads it, Lyrica included, sees it with the current name: "Li
wants the Proxmox cluster…".

Example page ("Proxmox homelab"):

```text
The cluster has three nodes [n:20261002-a81c]. Migration off the old NAS
should finish before winter [n:20261009-k3f9]; the node-2 backup job is the
open risk [n:20261009-k3f9].
```

## Names and pronouns

Users can change their display name and pronouns at any time in settings. Stored
memory never needs rewriting when they do.

**In storage**, notes and pages refer to users by token, never by name:

| Token | Renders as (for she/her) | Renders as (for they/them) |
|---|---|---|
| `[[u:ID]]` | Li | Li |
| `[[u:ID:obj]]` | her | them |
| `[[u:ID:poss]]` | her | their |
| `[[u:ID:poss-pro]]` | hers | theirs |
| `[[u:ID:refl]]` | herself | themself |

- **No subject-pronoun token.** "She is" versus "they are" would need the verb
  to change as well. In the subject position, memory text uses the name token
  instead. The other pronoun forms never change the verb, so they can be
  swapped freely.
- **Writing.** When Lyrica writes about the person she's talking with, she
  writes `{user}`, `{user:obj}` and so on. Her instructions and the `remember`
  tool's description say so. The store turns these into `[[u:ID…]]` tokens on
  write. Anyone else she mentions (people who aren't users) is plain text.
- **Reading.** Every read path (context assembly, tools, the memory browser)
  renders tokens with the user's current profile. Lyrica and the user both see
  natural text. The stored token form shows only in the browser's "raw" view.
- **WAKE and journal are plain text.** They are rewritten every sleep, so
  tokens would only make her narrative voice clunky. After a change they catch
  up at the next sleep.
- **Threads are never rewritten.** They are the record of what was said, old
  name included. The context's "who you're talking with" section lists the
  current name and pronouns, plus previous names with dates. When an old
  transcript uses a previous name, she knows who that is.

Tokens are rendered from the profile, so a rename takes effect everywhere
immediately. Nothing is rewritten, re-indexed or re-slept.

Search works on the stored text. Before searching, any user name in the query
(current or previous) is turned into that user's token, so searching for "Li"
finds notes stored as `[[u:7c1e]]`.

## Retrieval: how she knows to look

The cheapest mechanism comes first:

1. **Always in context** for the thread's pool: persona, WAKE, and a **page
   index** with each page's title and one-line summary. The index tells her
   what she knows about, which is what lets her think "I have notes on that"
   without being prompted. If the index outgrows its budget (about 3k tokens),
   it shows recently updated pages and pages that match the conversation.
2. **Automatic recall on every user turn.** Search notes, pages and past
   threads in the pool using Li's message, and inject the top few hits as
   short snippets with their IDs (about 1.5k tokens).
3. **Deliberate lookup** through tools. `recall(query)` searches.
   `read_memory(id)` opens a page, a note, or a window of a past thread around an
   entry.

Search starts as FTS5 (BM25). Embeddings (hybrid search) get added if the
continuity evals show lexical search missing paraphrases. The embedding model
follows the same local/cloud rules as every other model call.

## Writing

- `remember(notes: [{ text, about?, supersedes? }])` writes notes. Their
  source is the current thread entry. Superseded notes stay but drop out of
  automatic recall.
- **One fact per note, and plenty of notes.** Small notes keep lineage and
  deletion precise. Small notes must never mean fewer notes, so:
  - one `remember` call can save several notes at once, so splitting a moment
    into facts costs her nothing extra;
  - her instructions say to save liberally: when in doubt, note it. Notes are
    cheap, and sleep consolidates and prunes;
  - sleep's catch-up writes notes for what she missed, and each sleep run
    reports how many. A count that stays high means she is noting too little
    in conversation, which is a signal to adjust her instructions;
  - the continuity evals include "was it noted at all?" scenarios.
- Pages change only during sleep. See [sleep.md](sleep.md).
- Each change to a note or page keeps the previous text in `revisions`, with
  an author of `lyrica`, `sleep` or `user:<id>`.

Model-facing memory tools: `remember`, `recall`, `read_memory`. That's three of the
eight-tool budget.

## Workspace activity is memory too

What she does in a workspace is part of her experience, the same as what is
said:
- **Tool calls and results are thread entries.** Files read, edits made,
  commands and their output are stored and searchable like the rest of the
  conversation. Large outputs are indexed in truncated form. The full text
  stays in the thread entry, encrypted with everything else.
- **Notes can be about work.** She notes what matters, for example "Changed
  the node-2 backup job to keep 14 days [e:…]". Each note cites the tool-call
  entry it came from.
- **Sleep consolidates work.** It turns what happened in workspaces into pages
  about each project or folder: what it is, its current state, recent changes,
  and what's unfinished. Unfinished work goes into WAKE.
- **Opening a folder brings back what she knows about it.** When a thread is
  granted a folder that a page describes, that page is loaded with the thread's
  context, the same way a relevant page comes up in conversation.
- **Copies of files are not memory.** File contents stay in the thread entry
  where she read them. Notes and pages hold what she concluded, with
  citations.

## Threads that aren't logged

Each thread has a **Do not log thread in memory** checkbox. When it is on:
- the thread isn't indexed, so no other thread can recall anything from it;
- sleep skips it, and catch-up never extracts notes from it;
- she can't write notes in it: `remember` isn't offered, and her prompt tells
  her the thread isn't being remembered, so she doesn't promise to;
- she can still *read* her existing memory in it;
- the thread itself is still kept, encrypted, so you can scroll back. You can
  forget it like any other thread.

**Daughter threads inherit the setting.** Forks, and copies exported to
another interface, are created unlogged if their parent is unlogged, and
their checkbox can't be turned off. The store refuses to create a logged
daughter of an unlogged thread, so this doesn't depend on the interface
getting it right.

**Disposable subagents are never memory themselves.** A subagent's own thread
is stored, so the parent thread can show its steps, but it is always
unlogged, whatever the parent's setting.
- Only what comes back into the parent thread can become memory: the
  subagent's result, which arrives as a tool result in the parent.
- Whether that result is logged then follows the parent's setting.
- So that work isn't lost, the `delegate` tool appends a mechanical summary
  to every result: the files the subagent changed and the commands it ran
  that had effects. This doesn't rely on the subagent remembering to mention
  them.
- **This holds for every thread and session:** web, CLI, Matrix, forum and
  sleep sessions alike, and for subagents started by subagents. A nested
  subagent's result returns to its own parent, which is also unlogged, so
  only what finally reaches a main thread can become memory.
- **Exported copies aren't counted twice.** A thread copied to another
  interface keeps the original entries' IDs. Sleep and search treat those
  entries as the ones already processed, and only new entries in the copy are
  new material.

**Changing the setting part-way through** only affects what comes after:
- **Turning it on:** anything already consolidated stays in memory. Use
  "forget thread" to remove it.
- **Turning it off:** entries written while it was on are never logged, even
  later. Each entry records whether it was written while unlogged.

## Deletion

| Level | Effect |
|---|---|
| **Archive** | She stops using the memory. It is kept, and archiving can be undone. |
| **Delete a memory** | The text and its revisions are removed. A tombstone is left. Pages that cited it are flagged, and the next sleep rewrites them. |
| **Forget a thread** | The thread and its entries are deleted, along with notes whose only sources were in it. Each deleted note leaves a tombstone, and pages that cited them are flagged. |
| **Forget a topic** | Search, review the matches, then delete them in bulk. |

A **tombstone** holds no text: only the deleted item's ID, its kind, when it was
deleted, who deleted it, and the IDs of its source entries. Its one job is to
stop sleep from re-extracting a deleted fact from a thread that still exists.

## The memory browser

The web UI gets a memory browser:

- A search box and filters by pool and layer (note, page, WAKE, journal).
- An item view: the text; **Came from** (cited sources, linking into the
  thread); **Used in** (pages and WAKE that cite it); and its revisions.
- Edit, archive and delete, recorded as the user who made the change.

Until the browser exists, a small CLI (`lyrica mem search|show|delete`) covers
review, and users can ask Lyrica to correct a memory in conversation. There is no
CLI editing, because opening a memory in `$EDITOR` would write decrypted text
to a file.

## Guarantees, in one sentence

Deleting a memory removes its text and revisions from the live database, and
the next sleep rewrites pages that cited it. Encrypted backups keep it until
they expire. Anything already sent to a model provider is out of our hands.

## Not doing

- Relation graphs, receipts or audit logs.
- Contradiction-detection code. Sleep (the model) notices contradictions and
  asks.
- Memory tiers by model route.
