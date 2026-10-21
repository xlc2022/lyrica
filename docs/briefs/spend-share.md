# Brief: Spend share

**Status:** Merged as #287 (4a76109). Handoff notes below are history.

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
is its chat's and every thread's. Claude Code in the sandbox has no call
records either: its relay counts each message request's tokens, which go
straight into the thread's `call_totals` as **Claude Code**, cloud
(docs/workspace.md, "Claude Code").

**D. API** (`daemon/src/routes.ts`, `api.ts`). `GET …/threads/:pool/:id/usage`
→ `ThreadUsage { tokens, gpuMs?, models: { label, kind?, tokens, gpuMs? }[],
threads?: { threadId, tokens, gpuMs? }[] }`, `threads` only for a project
chat (the chat first, then by tokens, most first). `ProjectOverview.tokens`
is the same total. `GET …/models/calls` keeps `?project=&pool=`.

**E. Web**, per docs/ux.md. `web/src/Thread.tsx`: a **Tokens** fact, "<n>
tokens" in mono with a caret (`tokenCount`), after Checklist, once the thread
has a counted turn; reloaded after each turn. Its popover: a row per model
(label, local or cloud muted, tokens in mono, GPU time in mono for local),
then Total, whose tooltip says "Counts every request, cached reads
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
calls; names Tokens, GPU time, By thread, All projects, and the Total tooltip "Counts every request, cached reads included."), and the status table
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

2026-10-13 — Build complete in the working tree (principles 1, 2 and 8).

Done: every request's cached and uncached reads are recorded separately
from context size; tokens and local GPU time survive pruning in
`call_totals`; usage includes nested subagents and filters both pool and
thread. Pace recording and retry records also respect the hosted pool.
Pruning retains the latest 500 rows even when forgetting leaves gaps.
Thread/project usage routes, matching overview totals, Tokens popovers,
phone inline rows, By thread and route-retained Recent calls project
selection are built. The Project select does not depend on the sidebar's
project filter. Main's presets/columns, Backend and Images UI, thread-list
panel, notifications, tombstones and command rules are preserved; all eight
conflicted files have their markers resolved. The migration is **user step
10**, after main's steps 6–9; no pool migration was added. Tests migrate
schemas 1–9, preserve old counts and keep old readers working. Component
docs, contracts, DESIGN, UX and the design/projects-web briefs are updated;
obsolete profile routes in the touched web documentation now name presets
and columns.

Validation: typecheck and the web build pass. The targeted socket-free run
passes 35 tests in seven files: core spend-share and migrations, extension
context, daemon spend-share routes, web spend-share, cards and paths. Tests
use encrypted synthetic stores, manual offerings and in-process route
handlers, with no paid calls. Earlier pre-resume targeted integration tests
passed; after resuming, this sandbox refuses loopback listeners with
`listen EPERM`, so socket-based regressions and Playwright cannot run here.
A targeted Playwright scenario covers desktop/phone popovers, the project
filter surviving reload and No projects, screenshots and horizontal scroll.
Every test command used `/tmp/lyrica-tests.lock`; the full suite was not run.

Next: the operator stages the resolved merge and changes, runs the full
suite, and runs the targeted Playwright scenario on a host with loopback
listeners and Chromium available (1280 and 390 px), then obtains PR/UI
review and pushes. No commit or push was made in this resumed run; git's
merge index still needs the operator's staging. If main takes another user
schema step before this lands, merge it and renumber step 10 and its
migration test after the new highest version.

Open questions: none about scope or design; host-run verification remains.
