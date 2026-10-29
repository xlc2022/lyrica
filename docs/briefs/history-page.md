# History pages

**Status:** Merged as #288 (703e572). Handoff notes below are history.

## Goal

Serve principle 6, Trust her judgment; make review easy, and principle 8,
Small surface, held to a budget: nightly history stays easy to review without
making the memory page grow forever.

## In scope

Memory versions (notes, pages, WAKE and journal entries), sleep runs, journal
entries, model calls and finished downloads. Each preview shows only the
most recent entry, with a plain **Show all** link right-aligned beside the History eyebrow. The link
opens a reusable history page with a Search field and numbered pages, using
existing components, typography, controls and icons, noun labels and no
captions. Large lists are searched and paged on the server with limit,
offset, q and a filtered total, documented in the contracts. Sleep is wired
first, then memory versions, journal entries, model calls and finished
downloads.

Came from and Used in also preview four cards, with the same heading link
expanding longer lists in place (maximum height 320 px, own scroll), then
Show less to collapse. Either expansion hides History; Came from expansion
also hides Used in. The memory and earlier sections stay visible.

## Out of scope

Pages and Notes keep their existing browse and search. Current routines and
subagents are active work, not historical logs. Kept update releases are
bounded (last five plus current and previous), and last rollback is already
one entry. No storage migration, retention change, new model calls or widget
styles or changes to memory boundaries. No message text in logs.

## Done when

Previews contain one entry; heading links open searchable numbered history
pages; API tests cover paging, counts and search; the sleep web e2e covers
the preview, navigation, paging and search at desktop and phone widths.
The memory e2e covers both lineage previews, expansion, scrolling, heading
link alignment, collapse and the section visibility rules at both widths.
Docs match the implementation. Targeted tests run under the shared lock,
using fakes only. The local Playwright config is used only for checks and
removed afterwards.

## Handoff (2026-10-13)

Done: latest-entry previews and heading links for sleep runs, journal
entries, every memory’s versions, model calls and finished downloads;
shared search and numbered paging; API bounds, filtered counts and hidden
pool handling; existing Restore, group and Clear finished actions kept.
Docs and the browser tests cover the resulting behavior. Merge markers in
contracts, UX, Shell and routes are resolved in the files; main’s presets,
notifications and thread tombstones are preserved. No schema change.

Checks: typecheck and web build pass. Under the shared test lock, all six
history API handler tests, five Backend/card tests and eight download unit
tests pass. Handler tests use real encrypted stores and fake downloads,
without listeners or model requests. Before the pause, daemon, sleep and
history tests passed; desktop sleep/WAKE and calls e2e passed, and phone
sleep passed before the initial paging debounce race was found and fixed.
Earlier desktop and phone screenshots were inspected. Post-merge daemon
integration and Playwright runs cannot start here: the sandbox rejects
local listeners with EPERM. The extended browser checks include journal
and download history and still need a run on a host that permits sockets.

Remaining validation: browser checks and the operator’s full suite. No commit or push
was made on this resumed run. The local Playwright config was removed from
the tree because the WIP snapshot had accidentally tracked it; keep that
deletion in the final change. A copy for recreating it during checks is at
`/tmp/lyrica-history-page.playwright.local.config.ts`, using ports 7351–7353
and the requested Nix Chromium. From web/, run the targeted Playwright
checks under `flock /tmp/lyrica-tests.lock`, with one worker and the local
config, matching `Sleep:|Models: the sidebar|Downloads:`. Remove the local
config again before committing. No open design questions.

## Handoff: lineage expansion (2026-10-13)

Done: four-card previews and inline Show all / Show less for Came from and
Used in, reusing History’s heading styling. Expanded lists scroll at 320 px;
History hides for either expansion and Used in hides for Came from. Memory
and earlier sections remain visible. The fake encrypted history fixture
and desktop/phone e2e cover the rules, collapse and short lists. UX, web,
memory and DESIGN docs match. Preset adaptations from the prior merge are
retained; no API or schema change.

Checks: typecheck and web build pass; under the shared lock, six history
handler tests and five Backend/card tests pass. The extended Sleep/memory
browser test passes at 390 px and 1280 px, including lineage scrolling and
card heights. Screenshots were inspected; the temporary local Playwright
config was removed. Tests use fakes only.

Remaining validation: the operator’s full suite.
This run leaves edits in the tree.
No open design questions.

## Handoff: UI review round (2026-10-13)

Done, from UI review on PR #288: only the digits of "Page 3 of 12" are mono;
the current page button keeps `aria-current="page"`, is styled as pressed and
stays focusable, and reaches `--tap` on touch screens; a muted "…" sits in each
gap of skipped page numbers. **Show all** hides when its list holds one entry
or fewer — sleep counts through a `limit=1` history fetch, downloads reuse the
finished total, journal asks for two rows and shows one, and the memory preview
needs no count because it renders nothing at all with no earlier version. That
preview now shows the newest *earlier* version (the current text is already
above) with its diff and Restore; the fixture gained a second lineage-fixture
write so the collapse-restores-History check still has one. The search text and
page number ride in the address (`?q=&page=`, replaced not pushed), so Back
returns to the same page; route parse/href, web unit tests (new
`web/test/history.test.ts`) and the history e2e cover these. "Show less" moved
next to Show all in docs/ux.md's names list rather than duplicating there;
Overview's hand-rolled Show-all head is untouched, outside this round.

Checks: run `npm run typecheck` and the web unit suite before committing.
This run leaves edits in the tree. No open design questions.

## Review fixes after merging main (2026-10-13)

Done: all nine merge-conflicted files have been resolved in the working
tree, preserving presets, spend shares and the history pages. Call history
keeps the Project select (UX §6) and search/page in its address; the API
restricts project calls to their visible pool, with 404 for a hidden pool.
Clear finished collects IDs before deleting each once. Memory details
include the newest earlier version for the preview, and paged versions show
N of M instead of revision IDs. The restore e2e checks the single open
preview and that restoring brings back the earlier text. No migration added.
These fixes serve principles 2 and 6.

Checks: typecheck and web build pass. Under the shared lock, 33 targeted
daemon/web tests and all 10 selected phone/desktop e2e tests pass, including
lineage, numbering, downloads and the project filter. Fakes only. The local
Playwright config was removed. Remaining: the operator stages the resolved
files, runs the full suite, commits and pushes; the Git index is read-only
here.
