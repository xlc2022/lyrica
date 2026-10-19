# Brief: Sleep's threads go after 36 hours

**Status:** merged (#361, f10fd3e). **Branch:** `claude/project-thread-i9j6rg`.
**Built by:** the Sleep threads cleanup thread (Opus).
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Memory" (Deletion),
docs/sleep.md "In code", docs/memory.md "Deletion".

## Goal

Each sleep phase runs in its own thread (`Sleep: consolidate`, `Sleep: dream`,
`Sleep: wake`), and nothing ever removed them. Their entries were indexed
like any thread's, tool results included, so a note the user deleted could
come back through recall from a sleep transcript that had read it. The user
can't see or delete these threads. The user asked for them to be deleted
36 hours after they're made.

Principles 7 (deleting a memory deletes it, stated once, with no scrubbing
machinery: the transcripts just go) and 4 (fewer places a fact can hide).

## Change

- Sleep threads' entries are never indexed (`PoolStore.appendEntry`), and
  search skips any `e:sleep/…` entry indexed before this change.
- `Sleep.prune(now)` forgets every `sleep` thread older than 36 hours
  (`SLEEP_THREAD_AGE_MS`) in each pool whose key is here, with
  `keepMemories`. The journal, notes, pages, WAKE and items stay, and each
  thread leaves a text-free thread tombstone, so an item whose source was a
  phase thread still leads somewhere. `lyricad` calls it once an hour from
  its tick and logs only the count.
- Recent work for a project (`recentWorkAllowed`) no longer lists sleep
  threads, and Continue as project refuses them.

Out of scope: a phase thread that fails before its session opens is still
made, and is now forgotten after 36 hours like the rest. Model call
records for sleep threads are kept (they hold no text).

No contract change beyond `sleep.prune`. No schema change.

## Handoff

Done: the change above, merged in #361, with a test in extension/test/sleep.test.ts that
fails without the indexing change. Lunasa's older sleep threads were cleared by hand the same day. Next: nothing.
