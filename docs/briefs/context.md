# Brief: Context and pace (the meter, prepared compaction, speed)

**Status:** Merged as #46 (977c915); the meter in #182.

**Thread:** Models 2, after #40 (it owns
`prepare()`, call records and the Pi runtime hooks). **Branch:**
`feature/context`. The meter's UI goes to the Web UI 2 thread.

**Read first:** AGENTS.md and PRINCIPLES.md; DESIGN.md "Models and
endpoints" (the context length a model serves, call records, pinned
messages); docs/models.md; docs/contracts.md `extension` and `core/models`;
Pi 1.1.0: `AgentSession.getContextUsage()`, `compact()`, the
`session_before_compact` hook, `CompactionSettings`, `Usage`.

## Goal

Lyrica knows how much of her context is used and how fast her model is
answering, prepares for compaction before she hits the window, and compacts
herself in a controlled way. The user sees the same numbers. This serves
principle 1 (long work doesn't fall off a cliff) and principle 3 (Pi still
owns compaction; we steer it).

## What Pi gives us

- `getContextUsage()`: tokens used, the window and a percentage, from the
  last response's usage.
- `Usage` per assistant message: input, output, cache read and write.
- `compact(customInstructions)`, and automatic compaction at
  `window - reserveTokens`, keeping `keepRecentTokens` of recent messages.
- `session_before_compact`, which can cancel or supply the compaction result
  itself, with the reason: manual, threshold or overflow.
- Provider hooks for timing: before the request, each stream event, the end.

## In scope

1. **Measuring.** After every turn, record on the thread and in the call
   record (`model_calls`): prompt tokens, output tokens, the window, time to
   first token and generation time. From those, tokens per second and prompt
   tokens per second. Counts and times only, never text.
2. **The breakdown.** lyricad assembles the prompt, so it can say what each
   part costs: persona, the page about the user, pinned messages, memories
   recalled this turn, tool definitions, the conversation, Pi's reserve for
   compaction, and free space. Parts are estimated with Pi's
   `estimateTokens` and scaled so they add up to the measured total; hosts
   can give exact counts through llama.cpp's `/tokenize` later. The thread
   API returns it; the thread header shows **Context 21%** in the facts
   line, opening a popover with one bar and the parts, used of window, and
   when it was measured.
3. **Her status line.** One line in each turn's context, numbers only:
   `Context 64% of 32k · 11.5k free · 38 tok/s · 2.1k tok/s prompt`. No
   explanation of what it means; the persona says once how to use it.
4. **Preparation.** At 75% lyricad adds one line: finish the current step,
   save what matters to memory, then compact with a summary of what the
   next stretch needs. At 90%: compact now. These are lines in the turn
   context, like the date, not tool results.
5. **Compacting herself.** A `compact` tool with one argument, her own
   summary (what she is doing, decisions, open questions, paths and names
   she needs). It stands alone until the Child threads thread lands the
   `threads` tool, which then takes `compact` as an action and the
   standalone tool goes. lyricad checks the summary fits Pi's reserve, then
   calls Pi's `compact()` and answers `session_before_compact` with her
   summary as the result. Pi cuts the old entries and keeps the recent
   ones; pinned messages are re-injected as today. The compaction shows as
   a marker, **Compacted · 41k → 6k**, that expands to the summary. If her
   summary is missing or too short, Pi makes one, with her notes as the
   instructions.
6. **The safety net.** Pi's automatic compaction stays on at the window's
   edge. `session_before_compact` with reason threshold or overflow lets
   Pi's default run, with instructions to keep the current task and the
   pinned messages. She should rarely reach it.
7. **Speed where it's useful.** Recent calls gains tok/s and prompt tok/s
   columns. The text library shows each copy's median speed over its last
   twenty calls. The context popover shows the last turn's speed. Nothing
   acts on speed automatically yet; group ordering by measured speed is a
   later suggestion.

## Out of scope

- Exact token counts for cloud models (estimates are fine).
- Changing the model mid-thread because it is slow.
- Compaction of subagents (they are short-lived; Pi's default stays).

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests show that: the parts sum to the measured total; the 75% and 90%
  lines appear at those points and not before; `compact` with her summary
  replaces the old entries, keeps the recent ones and the pinned messages,
  and the marker shows the summary; a private thread compacts with a local
  model; a "Do not log" thread records counts only; call records carry
  speeds and no text.
- docs/models.md, docs/daemon.md and docs/web.md describe what exists.

## Handoff notes

**Done** (feature/context): items 1 to 7 as the API, with the stored
compaction marker shown as one line in the web UI.

**Left:**
- **Pinned messages** are built: they are read from the store word for word
  into a `pinned` section, so compaction can't summarise them away, and the
  breakdown's `pinned` part counts them (`extension/src/assemble.ts`).
- **A compaction marker that expands** is built: the stored marker and her
  Compaction card both open to the summary (docs/web.md). The context meter,
  the facts line's Context and its popover, is built too.
- **Speed in the web UI** is built: tok/s and prompt tok/s in Recent calls
  and each copy's median speed in the text library (#430).
- **Exact counts** from a host's llama.cpp `/tokenize`.

**Open questions:** none blocking. `compact` is its own tool, with her summary
as its one argument, until the Child threads thread's `threads` tool takes it
as an action.
