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
Changes apply only after Xu approves them and are committed to git. Because the
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
