# Decisions

Short entries, newest last. A settled decision changes only through a new entry
that supersedes it. Read this file and [PRINCIPLES.md](PRINCIPLES.md) before
proposing changes.

Format: **ID — title (date, status)**, followed by context, the decision, and
what it rules out.

---

## D-001 — Restart from scratch (2026-10-09, proposed)

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
reference, either outside this repo or archived under a tag.

**Carried over:** the persona text as a seed; Pi JSONL as the canonical
history; topic routing; the WAKE/FACTS/journal shape of sleep.

**Ruled out until a new decision:** accounts and authentication; the
Ordinary/Temporary/Private/Custom presets; the General/Sensitive tiers; the
controller, leases and fences; the delegation ledger; forgetting receipts and
redaction; the forum.
