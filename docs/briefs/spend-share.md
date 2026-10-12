# Brief: Spend share

**Branch:** `feature/spend-share`. **Built by:** Codex on the test machine.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Context and pace" and
Projects (the facts line), docs/models.md (Recent calls), docs/delegation.md
"Limits and accounting", docs/ux.md (Context, A project's usage, Models).

## Goal

The user sees where a thread's and a project's tokens went: which model, which
thread, and how long local models worked. Tokens only, no money. Principles 1
(a fact the user sees this month where they already look), 2 (each pool's
totals stay its own) and 8 (no new tool or process; call records hold it).

## In scope

**A. Counting.** Today a call record's `prompt_tokens` is the turn's last
request (the context used), so a turn of many tool calls is undercounted.
`extension/src/context.ts` also sums `input + cacheRead + cacheWrite` over the
turn's requests as `readTokens`; `recordPace` (`core/src/models/index.ts`)
stores it. A turn's **tokens** are `read_tokens + output_tokens`, or
`prompt_tokens + output_tokens` for a record without it. **GPU time** is
`ttft_ms + gen_ms` (from the request to the last token, so queueing and loading
count) on calls whose `kind` is `local`; cloud calls have none. Shown beside
tokens, not instead: tokens are what fills her context on either kind.

**B. Keeping the sums.** `model_calls` keeps the latest 500 per user, so a sum
over it would shrink. Before pruning deletes rows, fold their counts into a
`call_totals` table: pool, thread, label, kind, tokens, gpu_ms, calls, keyed by
the first four. One user.db step (the next free version) adds `model_calls.read_tokens` and `call_totals`, expand only,
with a migration test from every released user schema. Command rules adds a
step too, in parallel: whichever merges second merges main, renumbers its step
after the other's and keeps its migration test from every released schema,
since two steps sharing a number would leave one never run. `forgetThread` deletes
a thread's totals too. No other table.

**C. Sums.** `Models.usage(userId, pool, threadIds)`: per thread and model
label (with kind), the sum of its call records plus its `call_totals`,
filtered by pool **and** thread. Subagents' turns write no counts to their
call records, so their tokens come from `subagent_runs` (`input_tokens +
output_tokens`, by `model` label, kind from the offering when it still
exists, no GPU time), followed down every depth from the thread. Replace
`tokensFor` with it, so the project's total gains its subagents and the pool
filter. A thread's total is its own records and its subagents'; a project's
is its chat's and every thread's.

**D. API** (`daemon/src/routes.ts`, `api.ts`). `GET …/threads/:pool/:id/usage`
→ `ThreadUsage { tokens, gpuMs?, models: { label, kind?, tokens, gpuMs? }[],
threads?: { threadId, tokens, gpuMs? }[] }`, `threads` only for a project
chat (the chat first, then by tokens, most first). `ProjectOverview.tokens`
is the same total. `GET …/models/calls` keeps `?project=&pool=`.

**E. Web**, per docs/ux.md. `web/src/Thread.tsx`: a **Tokens** fact, "<n>
tokens" in mono with a caret (`tokenCount`), after Checklist, once the thread
has a counted turn; reloaded after each turn. Its popover: a row per model
(label, local or cloud muted, tokens in mono, GPU time in mono for local),
then Total, then one muted line, "Counts every request, cached reads
included." (a long cached tool loop counts its context once per request). In a project chat it replaces the plain "312k tokens": the same
rows for the whole project, then **By thread** (This chat, then each thread
as a link, tokens and GPU time), and **Recent calls** linking to that tab
filtered to the project. On a phone it is a line at the foot of the Context
popover (the Threads popover for a project) that opens the rows in place.
`web/src/Models.tsx` Recent calls: a **Project** select in the tab's header
(All projects, then projects by title, grouped General and Private, hidden
pools left out), kept in the route (`web/src/route.ts`).

**F. Docs.** DESIGN.md (Context and pace, the project facts line),
docs/models.md, docs/delegation.md, docs/contracts.md, docs/daemon.md,
docs/web.md, docs/ux.md (a thread's tokens row, "A project's usage", Recent
calls; names Tokens, GPU time, By thread, All projects, and the muted line "Counts every request, cached reads included."), and the status table
in docs/briefs/design.md. The guarantee, once: "Totals count her turns and her
subagents' work; titles, images, speech and a project chat's looks at its
threads carry no counts and aren't included."

## Out of scope

Prices, dollars or a price lookup (a later idea); budgets, limits or alerts;
per-user or server-wide totals; a usage page; GPU time for subagents or cloud
calls; counting title, image, speech or watching calls.

## Done when

`npm run typecheck` and `npm test` pass, with tests: a thread's and a
project's totals equal the sums of their call records, folded totals and
subagent runs; totals stay the same after pruning; a multi-request turn counts
every request it read; a private thread's calls never count toward a general
project, even with the same thread ID; GPU time sums only local calls; the
calls route filters to one project; the migration.

## Handoff notes

Not started.
