# Brief: Child threads wake an idle parent

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

1. A message from a child to its parent, and the daemon's notes "finished
   without a report", "stopped with an error" and "didn't start", start one
   turn in an idle parent (`triggerTurn: true`) instead of waiting for the
   next time the person writes. Subagent run results keep today's behaviour.
2. The wake obeys the wake-up guards: nothing while the project is paused,
   the concurrency limit holds, and a bad end wakes its parent once until the
   child reports or the person writes in it (`noticed`). A child's `needsYou`
   or update line in a project chat counts the same.
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

Idle parent gets a turn when a child reports and when a child ends without a
report; a paused project and a repeated bad end do not wake; subagent result
into an idle parent still doesn't.

## Build

Codex on lunasa, one at a time through the install thread's test queue; no
parallel test runs.

## Handoff notes

(The building thread fills this in if it stops before it's done.)
