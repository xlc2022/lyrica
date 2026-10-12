# Brief: Sleep

**Thread:** Sleep. **Branch:** `feature/sleep`.

**Depends on:** Memory, Models, Workspace, Delegation and Daemon (all merged),
and Memory's `p:about-user` PR. Start once that PR is merged.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Memory pools", "Memory" (including "About you"), "Sleep",
  "Persona" and "Models and endpoints";
- docs/sleep.md, which is the agreed design for this thread, and
  docs/memory.md;
- docs/contracts.md: `sleep`, `core/store`, `core/models`, `daemon`, and
  persona proposals under `core/users`;
- docs/daemon.md.

## Goal

Lyrica sleeps. Each pool runs **consolidate → dream → wake** as agentic
sessions in her own voice, nightly and on demand, and keeps general and
private memory apart. The user can see what she did. This is where her memory
becomes understanding (principle 5), and where she wakes up continuous
(principle 1).

## In scope

1. **`runSleep(userId, pool, reason)`**, as in the contract. It returns a
   `SleepRun` with a status (`complete`, `partial` or `skipped`) and a skip
   reason (`no-key`, `endpoint-down` or `no-activity`).
2. **Phases are sessions.**
   - Each phase is a thread in the pool's `sleep` interface, run with
     `openThreadSession` and the thread's own `CallContext`, so dreams can be
     recalled later.
   - Each phase gets the persona and **memory tools only**: `recall`,
     `read_memory`, `remember`, and the sleep-only tools for writing pages,
     the journal and WAKE. No shell, web, `delegate` or `image`.
   - Every page change keeps a revision and cites what it rests on.
3. **Consolidate**, as in docs/sleep.md:
   - Read the notes since the watermark, and skim the threads they came from.
     Note what was missed, lightly.
   - Create or update pages with citations, and rewrite pages flagged by a
     deletion.
   - Turn contradictions into questions. They are listed in the run and
     raised in WAKE.
   - User-written or user-edited memories are authoritative: she builds on
     them, asks rather than overwriting, and never edits or deletes them.
   - **Maintain `p:about-user`** in this pool: who the user is, what they
     prefer, dislike and care about, citing notes. Create it if missing. Never
     overwrite text the user wrote. Add around it, or ask.
4. **Dream.** Free reflection, written to the journal and marked as
   reflection, so nothing in it becomes a fact by itself.
   - A persona proposal goes through
     `PersonaProposals.propose(view, threadId, …)`, so it is a draft in the
     user's own `user.db` unless the user is an administrator.
5. **Wake.** Write WAKE, 400–800 words in her voice, last: where things stand,
   what's in motion, and what's unresolved. It is orientation only, with no
   dream content. The next new thread starts with it, plus how long it has
   been.
   - **Items.** She also writes a few things she'd like to raise: a thought
     from the dream, a question from consolidation, a persona suggestion.
     Each item is stored in the pool with a link to its source.
   - A new thread can be started **from an item**. That thread gets the item
     in its context, and she opens with it.
   - Items never enter other threads; that is the structural rule. Dreams
     still come up naturally through recall when a conversation touches them.
     Journal entries stay searchable, and a test should show a related dream
     surfacing later.
6. **Pools.**
   - Private sleep reads general memory as background and writes only to the
     private pool.
   - General sleep never opens the private pool.
   - Each pool's sleep resolves `sleep.consolidate`, `sleep.dream` and
     `sleep.wake` through the router with that pool's context, so private
     sleep is local-only.
   - Retries stay within the allowed models and never cross between local and
     cloud. Use the profile's ordered fallbacks once Models supports them;
     until then, one model per phase.
7. **The watermark.**
   - Only entries written before the run started are processed.
   - It moves only after consolidate finishes. A partial run resumes where it
     stopped next time.
   - Unlogged threads are never slept.
8. **Skips.**
   - **`no-key`:** the user's key isn't available.
   - **`endpoint-down`:** a cheap probe of the phase's model fails first.
   - **`no-activity`:** nothing new since the watermark.

   A skip moves nothing and is recorded. Lock during a run stops it and marks
   it `partial`.
9. **Scheduling, in `lyricad`.**
   - Run at `sleep.time` (self.db `settings`, administrators) for each user
     with a key available, and each pool with activity.
   - `sleep.mode`, `scheduled` (default) or `manual`, is a per-user setting in
     `user.db`.
   - Run pools one at a time per user, and users one at a time, so a GPU
     isn't asked for everything at once.
10. **`/sleep`.**
    - It sleeps the current thread's pool now, from the web UI or the bench.
    - In `manual` mode it asks for confirmation first, then opens a fresh
      thread afterwards, as Monika does.
    - It's one command, within the budget of 6.
11. **API** in `daemon/src/api.ts`, for the Web UI's Sleep section (which the
    Web UI thread builds):
    - list runs per pool;
    - a run's detail: status and skip reason, notes added, pages changed with
      a diff, questions, the dream, the WAKE;
    - items, with new ones marked, plus "start a chat from this item" (which
      creates the thread and has her open it) and "dismiss";
    - start a run now;
    - progress events on a stream.
12. **Limits and logs.**
    - Each phase has a turn and token limit, and a timeout. Exceeding one ends
      the phase as `partial`.
    - Logs carry no text, as everywhere.

## Out of scope

- The Sleep section's UI (Web UI thread).
- Ordered fallbacks in profiles (Models follow-up). Use them if they land
  first.
- Embedding-based recall.
- Importing v1 memories.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, with a scripted fake model server and a temporary runtime, show that:
  - a run consolidates notes into pages with citations, writes a dream marked
    as reflection, and writes WAKE last, which the next new thread loads;
  - WAKE has no dream content, and items appear in no thread except one
    started from that item, where she opens with it;
  - `p:about-user` is created from notes, updated on the next run, and keeps a
    user's own text untouched, raising a question instead;
  - private sleep writes only to private and can cite general; general sleep
    never opens private;
  - an offline endpoint skips the run without moving the watermark, and a
    partial run resumes;
  - unlogged threads and entries after the watermark aren't slept;
  - a non-administrator's dream proposal becomes only a draft in their
    `user.db`;
  - `no-key` and `no-activity` skips are recorded;
  - manual mode only runs on `/sleep`;
  - logs contain no text, checked with a marker string.
- **The continuity eval passes after a sleep.** A user states a dislike, sleep
  puts it in `p:about-user`, and a later unrelated thread avoids it.
- docs/sleep.md describes what exists, and the PR lists any contract change.

## Handoff notes

(The Sleep thread fills this in if it stops before it's done.)
