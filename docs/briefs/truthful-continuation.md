# Brief: truthful continuation

**Issue:** #302. **Branch:** `lyrica/truthful-continuation`.
**Status:** Merged as #304 (5b1acbe).

## Goal and principles

Stop saying work will continue when the turn has ended without a mechanism
that can continue it. This serves principle 1 (a failure noticed in use),
3 (lean on Pi rather than wrap its loop), 7 (one plain guarantee), and 9
(tool conduct belongs outside persona).

## Scope

Add operational `toolGuidance`: do actionable work before final; final ends
the turn. After failed delegation, use available direct tools in that turn.
A background claim needs a successful tool start or queue and names the
mechanism; queued is not running. Otherwise report the stopping point and
idle. Recurring routines require a user request. Update the extension doc,
Runtime design, prompt contract and own-project handoff in distinct hunks
from #300 (delegation folders) and #301 (read-only child checkout access).

Use the existing eval harness with synthetic data only. Cover failed
delegation with direct read available, recovery after "Have you been
working?" in the same turn, queued versus running, and no unsolicited
routines. Scripted cases check guidance and regression assertions; optional
real-model cases provide behavioral evidence, not a deterministic guarantee.

## Rejected / out of scope

No controller that keeps taking turns until intent is satisfied: the existing
hosted run normally clears busy at turn end; the observed issue is conduct,
not a runtime bug. No autonomous loop, new timers, UI intent-state changes,
new tools, persona-core changes or unsolicited routines. Existing child,
delegate and CI-watch mechanisms remain unchanged. No real transcripts or
private data are saved in fixtures or logs.

## Checks and handoff

Run typecheck, tests and evals sequentially. Report skipped model-dependent
checks explicitly. Open a PR with rationale and rejected controller noted;
inspect failing CI logs before fixes, and leave merging to review.

Implementation is in `extension/src/index.ts`: her own prompt passes the
rules to `toolGuidance`, and subagent prompts (`delegate/tool.ts`) don't get them; the focused eval is
`evals/truthful-continuation.eval.ts`. Context boundary fixtures allow for the
added prompt characters and Pi's reserve; all compaction assertions remain.
Local checks passed sequentially: typecheck; tests (1,090 passed, 50 skipped);
evals (12 passed, 3 skipped). The three optional real-model checks were not
run: no `LYRICA_EVAL_BASE_URL` / `LYRICA_EVAL_MODEL` was configured. The first
test run exposed missing openssl on PATH and prompt-size-sensitive fixtures;
both causes were checked before correcting the environment and fixtures.
Dependencies installed with `npm ci --ignore-scripts`; the packaged native
SQLite and Argon2 bindings were available. No dependency files changed.

Merged as #304. A follow-up kept the rules out of subagent prompts, which
also use `toolGuidance`. No operator setup, runtime, persona or UI change.
