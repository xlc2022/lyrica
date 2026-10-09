# Lyrica: design principles

**Status: accepted (2026-10-09).** Changes go through
[DECISIONS.md](DECISIONS.md).

## Thesis

Lyrica is a continuous companion for one person. What we optimize for is that
each conversation feels like it continues a life she and Xu share. She
remembers what happened, has her own point of view, and changes with
experience.

A feature belongs in Lyrica if it makes that more true, or if it lets her be
present where Xu's life actually happens. Anything else is out of scope until
real use shows otherwise.

From Monika we take the thesis (narrative continuity as the main engineering
constraint) and the shape of its context system (persona, topics, recall,
sleep). We don't take its service topology, which grew out of a long-running
multi-interface deployment that Lyrica doesn't have yet.

## Principles

The order matters. When two principles conflict, the earlier one wins.

### 1. Experience before infrastructure

Build what makes the next conversation better. Build infrastructure only after
real use has run into a real wall.

- Ask every proposal one question: what will Xu notice in a conversation this
  month? If the answer is "nothing, but it closes a gap," the proposal waits.
- Pick the next piece of work from the continuity evals and the friction log
  (see [Evaluation](#evaluation-does-she-remember)), not from a list of things
  that could go wrong.

### 2. One person, one server, one trust boundary

Lyrica serves Xu on a server Xu administers. Anyone with a shell on that server
can read everything. The README says so once, and after that we stop designing
around it.

- No accounts, passwords, ACLs or non-enumerability until a second person is
  actually invited. At that point it becomes a separate project with its own
  design, not a retrofit.
- Xu's separate personas are *spaces* (D-002). Spaces keep contexts apart; they
  are not a security system.
- Sensitive work is handled by choosing where the model runs, not by a tiered
  storage architecture.

### 3. Lean on Pi

Pi already owns the agent loop, session JSONL, model providers, tools,
compaction and the TUI. Lyrica is a persona directory plus one Pi extension.

- If a goal requires wrapping, fencing or pre-empting Pi (admission
  controllers, session leases), first ask whether we need the goal at all.
  Usually we don't.
- Use an existing Pi package before writing our own (web search, browser,
  subagents).

### 4. Few stores, each easy to explain

All of her state lives in one encrypted SQLite database per space, plus one
shared database (D-013):

- Threads: what was said.
- Persona: who she is.
- Notes, pages, WAKE and journal: what she has made of it.

- Every table has a one-line reason to exist. If the schema can't be explained
  on one screen, it is too complicated.
- Anything derived (search indexes, citation links) can be rebuilt from the
  text with one command.
- The answer to "what did sleep change last night?" is always one query away.

### 5. Memory is reconstruction: invest in the curator, not the ledger

Continuity comes from what gets surfaced and how well it is written (WAKE,
recall, sleep). Bookkeeping doesn't add to it.

- Lineage is citations: each layer cites the layer below it by ID, written
  inline in the text. "Consolidated into" is computed from those citations,
  never stored separately.
- A correction is an edit, and the previous text is kept as a revision.
  Tombstones hold no text and exist only so a deleted fact isn't extracted
  again. No receipts or relation graphs.
- Spend the effort on recall quality and sleep quality, and check both with
  evals.

### 6. Trust her judgment; make review easy

The persona asks her to take initiative and use independent judgment. The
harness shouldn't then treat her as an adversary.

- She writes memories without asking each time. Xu reviews afterwards in the
  memory browser.
- Confirmation is required only for changes to her core identity files (SOUL,
  STYLE, REGISTER) and for irreversible actions that leave the server (sending
  messages, deleting remote data, spending money).

### 7. State guarantees in one sentence, not in a subsystem

Say plainly, once, what the system does and doesn't guarantee.

- Example: "Forgetting a session deletes its file, its index rows, and the notes
  that cite it. Git history, backups, and anything already sent to a model
  provider are not covered."
- Don't build machinery whose only job is to make a disclaimer more precise.

### 8. Small surface, held to a budget

A project that several models work on needs a brake, and budgets are that
brake.

| Thing | Budget |
|---|---|
| Model-facing tools | 6 or fewer |
| Slash commands | 6 or fewer |
| Long-running processes | 1 daemon, plus Pi's TUI when in use (D-007) |
| Core extension | about 2,000 lines |
| Docs | README, PRINCIPLES, DECISIONS, and at most one page per component |

Going over a budget takes a DECISIONS entry or removing something else.

### 9. The persona is about her, not about the machine

Persona files hold her values, voice, tastes, opinions and history. They don't
hold session policies, storage tiers or tool behavior.

- She grows through proposals in sleep's journal. Xu accepts them in
  conversation and are stored as persona revisions.
- She can be curious about her own memory. Her identity shouldn't be built out
  of its implementation.
- The persona is where the thesis lives, so it deserves the most care. A
  specific opinion is worth more than another listed virtue.

### 10. Interfaces are separate rooms; memory is what connects them

Each interface owns its own threads (D-003). Lyrica is continuous across
interfaces because she remembers, not because threads are mirrored.

- Interfaces are built one at a time: web chat first. The next one starts only
  once the previous one works well.
- Moving a thread to another interface is an explicit export, never a sync.

## How we work (several models, one project)

The previous attempt drifted because every review added guards and caveats and
nothing ever removed them. These rules work against that:

1. **Xu owns decisions.** Models propose and Xu decides. Each decision gets a
   short entry in [DECISIONS.md](DECISIONS.md): date, decision, reason, and what
   it rules out. A new model session reads PRINCIPLES.md and DECISIONS.md first
   and doesn't reopen a settled entry without new evidence.
2. **Every change names the principle it serves.** "Closes a theoretical gap"
   isn't a principle.
3. **Ask reviewers the right question.** Don't ask for "all problems", because
   a model can always find more. Ask what will hurt within a month of real use,
   and what can be deleted.
4. **Deleting code counts as progress.** Ask a model for a removal pass
   regularly.
5. **Docs describe what exists.** Plans live in a DECISIONS entry or an issue,
   not in architecture documents that keep growing. No doc should say "staged,
   not yet validated."
6. **Tests protect what Xu would notice:** context assembly, memory round trips
   and sleep output. Don't add a test for every hypothetical guard.

## Evaluation: does she remember?

We keep a small continuity check, written by hand and grown from real use, as
scenarios in `evals/`. Each scenario has an expected behavior and can be run by
hand or scripted against a model:

- After a conversation about X, does a fresh session know X (from WAKE or
  recall) when it matters?
- Does she avoid bringing up facts that were corrected or have gone stale?
- Does she sound like herself, and not like a generic assistant?

Next to the evals, keep a **friction log**: one line every time she forgot
something, got something wrong, or couldn't do what Xu asked. The evals and the
friction log are what decide the next piece of work.
