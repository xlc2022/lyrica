# Memory

**Status: proposal for discussion.** Implements D-004.

Xu's requirements:

1. Lyrica saves whatever she wants, without asking.
2. She retrieves it when it's relevant, without being told to look.
3. Xu can search and edit her memories.
4. For any memory, you can see where it came from and what it was consolidated
   into.

## Layers

Each layer cites the one below it by ID, inline in its text. Reading the
citations downward gives a memory's sources. Reverse lookups ("what was this
consolidated into?") are computed by the index from the same citations, so
there is only one source of truth.

| Layer | What it is | Written by | Cites |
|---|---|---|---|
| **Threads** | Pi session JSONL: what was actually said | Pi | none |
| **Notes** | Small, dated observations: one fact, event, preference or decision each | Lyrica in conversation (`remember`), or sleep when she missed something | Thread entries |
| **Pages** | Her current understanding of one subject (a project, a person, an area of Xu's life, herself) | Sleep | Notes |
| **WAKE** | A short orientation: what's in motion, what's unresolved, what to ask about | Sleep | Pages and notes |
| **Journal** | Sleep's reflection, including persona proposals | Sleep | Anything |

Pages replace Monika's single `FACTS.md`. One large file can't show which
sentence came from where. Pages split the same content by subject and keep
citations.

## On disk

Everything lives in the self repository (git):

```text
self/
  persona/                       shared by all spaces
  spaces/<space>/
    WAKE.md
    pages/<slug>.md
    notes/2026/10/<note-id>.md
    journal/2026-10-09.md
threads/<interface>/<space>/     Pi JSONL (not in git; too large and noisy)
index.sqlite                     derived; `lyrica reindex` rebuilds it
```

A note:

```markdown
---
id: n-20261009-k3f9
created: 2026-10-09T14:02:11Z
about: [proxmox, backups]
sources: [web/3f7a2c#e41]
supersedes: []
---
Xu wants the Proxmox cluster off the old NAS before winter, and is worried
about the backup job on node 2.
```

A page:

```markdown
---
title: Proxmox homelab
summary: Xu's three-node cluster, the NAS migration, and open worries.
---
The cluster has three nodes [n-20261002-a81c]. Migration off the old NAS
should finish before winter [n-20261009-k3f9]; the node-2 backup job is the
open risk [n-20261009-k3f9].
```

Git records who changed each file: Lyrica in conversation, sleep, or Xu by
hand. `git log` on a page is therefore its edit history, attributed, at no extra
cost.

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

Search starts as SQLite FTS5 (BM25). Embeddings (hybrid search) get added if the
continuity evals show lexical search missing paraphrases. A local embedding
model would keep memory text on the server.

## Writing

- `remember(text, about?, supersedes?)` writes a note, and its source is the
  current thread entry. She uses it freely. Superseded notes stay on disk but
  drop out of automatic recall.
- She does not edit pages during a conversation; sleep owns pages. This keeps
  conversations fast and gives each page change one reviewable commit.
  (Open question below.)

Model-facing memory tools: `remember`, `recall`, `read`. That's three of the
six-tool budget.

## Sleep

Sleep runs per space, on demand with `/sleep`, and later on a nightly schedule:

1. **Catch up:** read threads since the last sleep and write notes for anything
   important she didn't `remember`, citing entries.
2. **Consolidate:** fold new notes into existing pages or create new pages,
   citing notes. When notes contradict each other, she keeps both and writes
   the question into WAKE ("ask Xu whether...") rather than guessing.
3. **Orient:** rewrite WAKE.
4. **Reflect:** write a journal entry. A persona proposal goes to Xu, phrased
   without private details from its space (D-005).

Each phase is its own commit (`sleep(private): pages`, `sleep(private): wake`),
so the git log shows exactly what each night changed. A page citing a deleted
note gets rewritten at the next sleep.

## Xu's editing tool

The web UI gets a memory browser:

- A search box (FTS) and filters by space and layer (note, page, WAKE,
  journal).
- An item view: the text; **Came from** (cited sources, linking into the
  thread); **Used in** (pages and WAKE that cite it); and its git history.
- Edit and delete, committed as Xu.

The files are plain markdown, so any editor also works. A small CLI
(`lyrica mem search|show|edit`) covers the time before the web UI exists.

## Guarantees, in one sentence

Deleting a memory removes its file and its index rows, and the next sleep
rewrites pages that cited it. Git history, backups, and anything already sent
to a model provider are not covered.

## Not doing

- Relation graphs, tombstones, revision tables, receipts or audit logs. Git
  history covers these.
- Contradiction-detection code. Sleep (the model) notices contradictions and
  asks.
- Memory tiers by model route.

## Open questions

1. **Pages in conversation.** Should she update a page mid-conversation when
   Xu says "update your notes on X," or always leave it for sleep?
2. **Note granularity.** One fact per note, as proposed, or one note per
   conversation moment that may hold several facts?
3. **Thread files in git?** The proposal keeps threads out of git (they're
   large). Deleting a thread then means deleting the file and its index rows.
