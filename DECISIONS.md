# Decisions

Short entries, newest last. A settled decision changes only through a new entry
that supersedes it. Read this file and [PRINCIPLES.md](PRINCIPLES.md) before
proposing changes.

Format: **ID — title (date, status)**, followed by context, the decision, and
what it rules out.

---

## D-001 — Restart from scratch (2026-10-09, accepted)

**Context.** v1 was built with several models and reached about 41,000 lines:

| Part | Size |
|---|---|
| Tests | 11k lines |
| Memory extension | 10.7k lines |
| Docs | 6k lines |
| Forum | 5.8k lines |
| Supervisor | 2.2k lines |

That supports 12 compose services, 37 slash commands, 14 model tools and 48
SQL tables, all for one user.

Most of the code implements accounts, session-policy presets, memory tiers,
forgetting receipts, leases and fencing, and a delegation ledger. The persona
calls Lyrica a friend, assistant and secretary, yet there are no calendar,
reminder, email or task tools. Her `SOUL.md` is 14 lines (Monika's is 87). The
docs are dominated by caveats such as "staged," "not host-validated" and "not
proof."

The individual pieces are carefully written. The problem is direction: there
was no single thesis to rank concerns against. Each review closed another
hypothetical gap, and nothing was ever removed.

**Decision.** Start a new history from PRINCIPLES.md. Keep v1 as read-only
reference, either outside this repo or archived under a tag. Claude does the
bulk of the rebuild. Lyrica edits herself with other models only after she is
usable again.

**Carried over:** the persona text as a seed; Pi JSONL as the canonical
history; topic routing; the WAKE/journal shape of sleep.

**Ruled out until a new decision:** accounts and authentication; the
Ordinary/Temporary/Private/Custom presets; the General/Sensitive tiers; the
controller, leases and fences; the delegation ledger; forgetting receipts and
redaction.

## D-002 — Spaces: Xu's separate relationships with Lyrica (2026-10-09, accepted)

**Context.** Lyrica is for Xu alone. Xu wants to keep interactions apart: one
more public-facing persona, and at least one for private thoughts and projects.
Lyrica should treat each as a different person she knows.

**Decision.** A *space* is one of Xu's personas. (We say "space" so it isn't
confused with Lyrica's own persona files.) Each space has its own threads,
notes, pages, WAKE and journal. A thread belongs to exactly one space, chosen
when the thread is created. A thread's context loads only its own space's
memory, plus any spaces it is explicitly configured to read (for example,
private reads public). Lyrica's persona is shared by all spaces. She is one
individual with several relationships.

The point of spaces is context hygiene: private material never sits in a public
context. They are not a security boundary against Xu, so they need no logins.
Choosing a space in an interface is a menu choice.

**Rules out:** accounts, passwords, ACLs, and automatic flow from one space to
another.

## D-003 — Each interface owns its threads (2026-10-09, accepted)

**Context.** v1 bloated partly because every thread had to look the same in
every interface (projection, sync, one-writer leases). Xu wants web chat as the
main interface, with CLI, forum and Matrix as options.

**Decision.** Each interface keeps its own threads. Continuity across
interfaces comes from shared memory: Lyrica remembers what was said in a web
chat when Xu talks to her on Matrix, but the threads themselves are separate.
Moving a thread to another interface is an explicit export that copies the
session into a new thread there. Nothing syncs continuously.

Build order: web chat, then CLI (almost free, since it is Pi's own TUI), then
Matrix, then forum.

**Rules out:** projections, sync jobs, cross-interface leases, and treating one
thread as visible in several interfaces at once.

## D-004 — Memory: autonomous writes, searchable editing, visible lineage (2026-10-09, accepted in outline)

**Context.** Xu is happy for Lyrica to save whatever she wants, on three
conditions: she actually retrieves it when it's relevant; Xu can search and
edit it; and it is possible to see where each memory came from and what it was
consolidated into.

**Decision.** No confirmation for memory writes. The design is proposed in
[docs/memory.md](docs/memory.md) and is still under discussion.

## D-005 — Persona seed and self-revision (2026-10-09, accepted)

**Decision.** Keep the v1 persona as the seed. Lyrica proposes persona changes
when asked to reflect on how things have been going, and in sleep's journal.
Changes apply only after Xu approves them, and each one is kept as a revision. Because the
persona is shared across spaces, a proposal must not carry private details from
the space it came from.

## D-006 — Scope of action (2026-10-09, accepted)

**Decision.** Her first real-world duties are maintaining a calendar and
sorting data. Managing computer systems (for example, Xu's Proxmox deployment)
comes much later. It is gated on trust in her reliability and on a way to
guarantee that sensitive data stays on local models.

## D-007 — Runtime shape (2026-10-09, proposed)

**Context.** The main interface is web chat, so something has to host Pi
sessions outside a terminal. Pi 1.1's SDK runs sessions in-process with inline
extensions.

**Decision.**
- The Lyrica Pi extension holds everything that makes her Lyrica: persona,
  spaces, context assembly, memory tools and sleep.
- `lyricad` is one Node process. It hosts SDK sessions for web chat (and later
  Matrix and forum) and loads that same extension.
- The CLI is Pi's TUI with the same extension loaded.
- Memory writes from the two processes are serialized with a file lock on the
  self repository.

This replaces "one process" in principle 8 with "one daemon, plus the TUI when
it is in use."

## D-008 — Spaces: private reads public, never the reverse (2026-10-09, accepted)

**Decision.** This refines D-002. Private spaces include all memories from the
public space. Nothing from a private space can be retrieved in a public space.
Lyrica has one user, but nothing in the design should assume there will only
ever be one.

## D-009 — Models, delegation, and the local-only switch (2026-10-09, accepted)

**Context.** She will run on a mix of DeepSeek 4.1 Flash, GLM 5.3 Flash,
Qwen 3.8 27B and Qwen 3.8 Flash Next, through public and custom endpoints.

**Decision.**
- Each endpoint is declared explicitly as **cloud** or **local**. The API type
  never decides this.
- Different tasks can use different models (chat, subagents, sleep phases).
- Xu defines the list of models she may choose when she delegates on her own.
- A thread has a **local-only** checkbox. When it is on, any attempt to use a
  cloud model for a subagent fails with an error.
- Choosing an endpoint, public or custom, is easy. The model currently running
  is always obvious in the UI.

## D-010 — Integrations (2026-10-09, accepted)

**Decision.** Build adapters for Google Calendar, iCloud and CalDAV (which
covers Nextcloud), and for sorting files, notes, downloads and email. They
don't all need to be connected at first.

## D-011 — Fresh start with a self-primer (2026-10-09, accepted)

**Decision.** No v1 data is imported. Lyrica starts with a primer on her own
design, architecture and goals. It includes the rule that whenever she edits
her own code, she keeps the documentation current and readable. The primer is
loaded when the topic comes up, not always (principle 9).

## D-012 — Pages are written only by sleep (2026-10-09, accepted)

**Decision.** In conversation she writes notes. Pages change only during sleep.

## D-013 — Encrypted SQLite per space (2026-10-09, accepted)

**Decision.** This supersedes the plain-files-in-git idea. Memory and threads
live in SQLCipher databases: one per space, plus a shared `self.db` for the
persona and settings. Separate keys and separate files make "private never
reaches public" structural. Memory never goes into a git repository. See
[docs/memory.md](docs/memory.md).

## D-014 — Deletion levels and content-free tombstones (2026-10-09, accepted)

**Decision.** There are four levels: archive, delete a memory, forget a thread,
and forget a topic. A tombstone records IDs, kind, time, who deleted it, and the
source entries, never text. It exists so that sleep doesn't re-extract a
deleted fact.

## D-015 — Unlocking (2026-10-09, accepted)

**Decision.** By default, `lyricad` asks for a passphrase each time it starts.
An option saves the key (with systemd credentials, sealed to the TPM where
available) so it can start unattended.

## D-016 — Local-only means local for everything (2026-10-09, accepted)

**Decision.** This extends D-009. With local-only on, every model call made for
that thread goes to the thread's custom endpoint and nothing else: chat,
subagents, compaction, titles, embeddings, and the sleep work over that thread.
A cloud call fails with an error. It is never silently rerouted.

A settings page sets the default models per task, in separate cloud and local
profiles. Each thread can override which model handles which task. Open: how
memories written in a local-only thread are treated later (see
[docs/sleep.md](docs/sleep.md)).

## D-017 — Sleep schedule and dreams (2026-10-09, accepted in part)

**Decision.** Nightly sleep runs at about 04:00 for each space with new
activity, and `/sleep` runs it manually. She may bring up her dreams, as her
persona inclines her to. The rest of the cycle is a proposal in
[docs/sleep.md](docs/sleep.md), based on a review of Monika's.

## D-018 — Project workflow (2026-10-09, accepted)

**Decision.**
- The "Agent harness design principles" session is the design thread. It owns
  the principles, decisions and contracts, and keeps coding to a minimum.
- Feature threads are separate Claude Code sessions, titled and tagged
  `project:lyrica`. Each works from a brief in `docs/briefs/` on its own branch
  and ends with a pull request.
- The initial threads are: Core, Memory, Models, Web, Sleep and Integrations.
  No more than two or three are active at once.
- Sessions hand off through the repo (briefs, docs, PR descriptions), not
  through chat transcripts.

## D-019 — General and private memory pools (2026-10-09, accepted)

**Decision.** This refines D-002, D-008 and D-016. Spaces come in two kinds:

- A **general** space may use cloud models or a custom endpoint.
- A **private** space must use a custom endpoint for every model call.

Private threads read general memory. General threads never read private
memory. Sleep runs per pool and never writes across pools. The control panel
sets a model for each pool. In a private space, the UI doesn't offer cloud
models at all, and a cloud call fails with an error.

The local-only checkbox on a *general* thread controls only that
conversation's own live model calls. Its memories belong to the general pool,
and general sleep may process them with a cloud model. Content that must never
reach the cloud belongs in a private space.

## D-020 — Sleep modes and offline endpoints (2026-10-09, accepted)

**Decision.**
- `sleep.mode` is `scheduled` (nightly at `sleep.time`, default 04:00) or
  `manual`. Manual works like Monika: `/sleep` asks for confirmation, sleeps,
  then opens a fresh thread.
- If a pool's endpoint is offline when sleep is due, that pool is skipped until
  the next due time. Skipped and partial runs are recorded, and the watermark
  doesn't advance past unprocessed material.

## D-021 — Personas are users with their own credentials (2026-10-09, accepted)

**Context.** This supersedes the "no logins" part of D-002 and lifts D-001's
ban on accounts.

**Decision.** Each of Xu's personas is a separate user with its own password,
its own databases, its own endpoint and model settings, and its own general
and private memory pools (D-019). Lyrica's persona is the only thing shared
between users. Accounts stay minimal: local users, Argon2id password hashes and
a web login cookie. No roles or identity providers.

**Open:** whether any memory is shared between users, and how sleep gets each
user's key (see [docs/sleep.md](docs/sleep.md)).

## D-022 — Sleep is visible in the UI (2026-10-09, accepted)

**Decision.** A Sleep section in the sidebar shows each run per pool: status,
notes added, page diffs, the dream and the new WAKE.

## D-023 — Local-only in general threads (2026-10-09, accepted)

**Decision.** Xu accepts the consequence described in D-019. In a general
thread, the local-only checkbox keeps only that conversation's own model calls
local. Its memories may later be processed by cloud models during general
sleep.
