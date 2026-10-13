# Brief: Child threads wake an idle parent

**Status:** Merged as #291 (34f2e19). Handoff notes below are history.

**Branch:** `feature/child-wakes`. **Approved:** by the user, 2026-10-13.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md (child threads),
docs/delegation.md ("Child threads", "Told when a child ends"),
docs/contracts.md (the threads section near "once per user, checked on
start"), `daemon/src/children.ts`, `extension/src/delegate/tool.ts`.

## Problem

A child thread finished without messaging its parent. The daemon did tell the
parent ("finished without a report"), and the user then told the child to
report, but both are delivered by `Delegation.deliver`, and `deliverVia` in
`extension/src/delegate/tool.ts` appends them to an idle parent without
starting a turn. The parent never looks, so the work looks lost. A weak local
model also skips the "post an update when you finish" guideline.

## Change

1. What wakes an idle parent, for one turn (`triggerTurn: true`): a child's
   question or `needsYou` message, the daemon's notes ("finished without a
   report", "stopped with an error", "didn't start"), and a child's report
   at the end of its task (its turn ends idle after it messaged the parent,
   so the parent hears that it is done). Plain progress updates are appended
   as today and wake nobody. Subagent run results keep today's behaviour.
2. Guards. The wake-up guards hold: nothing while the project is paused, the
   concurrency limit holds, and a bad end wakes its parent once until the
   child reports or the person writes in it (`noticed`). Coalescing: while a
   woken parent turn is queued or running, more child messages join it
   instead of adding turns.
   No loop: a parent turn started by a child's message can't start a turn in
   that child through its own reply. The reply is appended, and the child
   sees it on its next turn or when the person writes in it.
3. Tighten the child guideline in `core/src/threads.ts`
   (`PROJECT_THREAD_GUIDELINES`, and the equivalent for children outside a
   project): "Always end with a message to the parent: the result, or what
   blocked you."

## Principle

Principle 1 (long work doesn't swallow a conversation) needs the parent to
hear of finished work. Don't rely on the model alone: the daemon note plus the
wake is the structural part.

## Docs to update in the same PR

docs/delegation.md (delivery section and "Told when a child ends"),
docs/contracts.md (threads/delivery lines), DESIGN.md child-thread bullet,
and docs/briefs/child-threads.md if it describes the old behaviour. The PR
body says which.

## Tests

Idle parent gets a turn when a child asks, ends with a report, or ends without
a report; a progress update, a paused project and a repeated bad end do not
wake; a subagent result into an idle parent still doesn't. Three quick child
messages give at most one parent turn. A parent woken by a child that replies
to it starts no child turn.

## Build

Codex on lunasa, one at a time through the install thread's test queue; no
parallel test runs.

## Handoff notes

**Status (2026-10-13):** built and pushed as PR #291; the integration tests
ran on lunasa and the full suite passes apart from the known updater
environment failure. In PR review.

### 2026-10-13 — implementation complete

**Done:** resolved the merge conflict using main's fuller requirements.
Questions use `question: true`; project `needsYou`, idle final reports,
failed/no-report ends and didn't-start notes wake the parent. Progress
updates append, subagent delivery stays as before, pending/running wakes
coalesce, pause/hidden and concurrency hold, and a woken parent's replies
to its source children only append. Tightened both child prompts. Serves
Principle 1; no new tool or process, and no schema migration or number taken.
Updated DESIGN, contracts, delegation, daemon, UX, child-threads and the
lyrica-project handoff; no new UI control (existing child card, UX §6).

**Validation:** typecheck passed. Focused child, delegation, thread-tool,
wake-up and routine tests passed; targeted project-pause coverage passed.
All Vitest commands used the shared `flock` and fork pool with two workers;
no full suite, paid API or real plan endpoint was called.

**Next:** done; see the Status line.

**Open questions:** none. Pending wake metadata is in memory only; encrypted
notices remain after restart, as documented.


### 2026-10-13 — resumed after main's presets merge

**Done:** resolved `docs/ux.md` by retaining main's project panels/cards and
this feature's child-wake behavior. Checked the welcome Backend card and
Images controls against named presets; the merged code already uses them.
Updated delegation's inherited context to say preset, and repaired stale
profile routes/Backend wording in docs/web.md. Reply suppression applies
only to the child-started turn, so a queued user turn can still start a child normally; pending wakes wait during an
update drain too. This feature adds no migration:
main's user steps through 8 and pool steps through 7 remain unchanged.

**Validation:** typecheck passed after the merge. All 17 socket-free guard,
thread-tool and card tests passed under the shared lock. Localhost fake-server tests
cannot run in the resumed sandbox (`listen EPERM`); the earlier successful
runs predate this merge. No full suite or paid endpoint was called.

**Next:** done; see the Status line.

**Open questions:** none; the integration rerun is the remaining check.
