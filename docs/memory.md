# Memory

**Status: agreed in outline** (D-004, D-012, D-013, D-014). The sleep cycle is
in [sleep.md](sleep.md) and is still under discussion.

Xu's requirements:

1. Lyrica saves whatever she wants, without asking.
2. She retrieves it when it's relevant, without being told to look.
3. Xu can search and edit her memories.
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
| **Pages** | Her current understanding of one subject (a project, a person, an area of Xu's life, herself) | Sleep | Notes |
| **WAKE** | First-person orientation: what's in motion, what's unresolved, what she wants to bring up | Sleep | Pages and notes |
| **Journal** | Sleep's reflection and dreams, including persona proposals | Sleep | Anything |

Pages replace Monika's single `FACTS.md`. One large file can't show which
sentence came from where. Pages split the same content by subject and keep
citations.

## Storage

Memory lives in encrypted SQLite (SQLCipher), with one database per space
(D-013):

```text
runtime/
  self.db              shared: persona (with revisions), settings, model config
  spaces/public.db     threads, entries, notes, pages, WAKE, journal, index
  spaces/private.db
```

- **Separate files, separate keys.** A public thread's code only ever opens
  `public.db`, so private memory can't reach a public context by mistake. A
  private thread opens both, and writes only to its own.
- **Threads are stored in the database too.** The daemon runs Pi sessions with
  an in-memory session manager (`SessionManager.inMemory(cwd, opts, entries)`
  in Pi 1.1). It loads entries from the database and writes new ones back. Pi's
  terminal UI writes its own JSONL files, so the CLI keeps its data directory
  on an encrypted filesystem.
- **Full-text search lives inside the encrypted database** (FTS5). There is no
  plaintext index.
- **Unlocking (D-015).** One passphrase unwraps the per-database keys when
  `lyricad` starts. By default it asks for the passphrase on every restart. The
  optional "start automatically" mode stores the unwrapped key with systemd
  credentials (sealed to the TPM if one exists). Choosing that mode trades
  protection for convenience, and the settings page says so.
- **Backups** are encrypted (restic or borg). Memory never goes into a git
  repository.

Tables in a space database, roughly: `threads`, `entries`, `notes`, `pages`,
`wake`, `journal`, `citations`, `revisions`, `tombstones`, plus FTS tables.

A note's text carries inline citations such as `[e:web/3f7a2c#41]`, and a
page's text carries citations such as `[n:20261009-k3f9]`. The `citations`
table is derived from the text, so "came from" and "used in" are cheap queries.

Example note:

```text
id: n:20261009-k3f9   created: 2026-10-09T14:02Z   about: proxmox, backups
Xu wants the Proxmox cluster off the old NAS before winter, and is worried
about the backup job on node 2. [e:web/3f7a2c#41]
```

Example page ("Proxmox homelab"):

```text
The cluster has three nodes [n:20261002-a81c]. Migration off the old NAS
should finish before winter [n:20261009-k3f9]; the node-2 backup job is the
open risk [n:20261009-k3f9].
```

## Retrieval: how she knows to look

The cheapest mechanism comes first:

1. **Always in context** for the thread's space: persona, WAKE, and a **page
   index** with each page's title and one-line summary. The index tells her
   what she knows about, which is what lets her think "I have notes on that"
   without being prompted. If the index outgrows its budget (about 3k tokens),
   it shows recently updated pages and pages that match the conversation.
2. **Automatic recall on every user turn.** Search notes, pages and past
   threads in the space using Xu's message, and inject the top few hits as
   short snippets with their IDs (about 1.5k tokens).
3. **Deliberate lookup** through tools. `recall(query)` searches.
   `read(id)` opens a page, a note, or a window of a past thread around an
   entry.

Search starts as FTS5 (BM25). Embeddings (hybrid search) get added if the
continuity evals show lexical search missing paraphrases. The embedding model
follows the same local/cloud rules as every other model call.

## Writing

- `remember(text, about?, supersedes?)` writes a note, and its source is the
  current thread entry. She uses it freely. Superseded notes stay but drop out
  of automatic recall.
- Pages change only during sleep (D-012). See [sleep.md](sleep.md).
- Each change to a note or page keeps the previous text in `revisions`, with
  an author of `lyrica`, `sleep` or `xu`.

Model-facing memory tools: `remember`, `recall`, `read`. That's three of the
six-tool budget.

## Deletion (D-014)

| Level | Effect |
|---|---|
| **Archive** | She stops using the memory. It is kept, and archiving can be undone. |
| **Delete a memory** | The text and its revisions are removed. A tombstone is left. Pages that cited it are flagged, and the next sleep rewrites them. |
| **Forget a thread** | The thread and its entries are deleted, along with notes whose only sources were in it. Each deleted note leaves a tombstone, and pages that cited them are flagged. |
| **Forget a topic** | Search, review the matches, then delete them in bulk. |

A **tombstone** holds no text: only the deleted item's ID, its kind, when it was
deleted, who deleted it, and the IDs of its source entries. Its one job is to
stop sleep from re-extracting a deleted fact from a thread that still exists.

## Xu's editing tool

The web UI gets a memory browser:

- A search box and filters by space and layer (note, page, WAKE, journal).
- An item view: the text; **Came from** (cited sources, linking into the
  thread); **Used in** (pages and WAKE that cite it); and its revisions.
- Edit, archive and delete, recorded as Xu.

A small CLI (`lyrica mem search|show|edit|delete`) covers the time before the
web UI exists. Editing opens the text in `$EDITOR` from a tmpfs file.

## Guarantees, in one sentence

Deleting a memory removes its text and revisions from the live database, and
the next sleep rewrites pages that cited it. Encrypted backups keep it until
they expire. Anything already sent to a model provider is out of our hands.

## Not doing

- Relation graphs, receipts or audit logs.
- Contradiction-detection code. Sleep (the model) notices contradictions and
  asks.
- Memory tiers by model route.

## Open questions

1. **Note granularity.** One fact per note, as proposed, or one note per
   conversation moment that may hold several facts?
