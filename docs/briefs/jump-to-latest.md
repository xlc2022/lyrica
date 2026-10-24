# Brief: Jump to latest

**Status:** In progress. **Branch:** `lyrica/jump-to-latest`.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md, docs/contracts.md, docs/ux.md, docs/web.md, docs/briefs/chat-view.md.

## Goal

When a reply or streamed text lands while the person has scrolled up in a conversation, the
conversation stops following it, and nothing told them that more had arrived. The fix is small and
local to the web UI: a small **Jump to latest** button at the foot of the conversation, which takes
the person back down to the latest text, shown only while new content landed while they were scrolled
up, and gone once they are at the bottom again by any means.

Principle 1, the experience before infrastructure: a reply that arrives out of sight looks like
nothing happened.

## In scope

- `web/src/Thread.tsx`: `useStickyScroll` reports whether the content grew while the person was
  scrolled up; the conversation renders a small secondary button, `jump-latest`, when it did and the
  person is not at the bottom.
- `web/src/app.css`: the button's look (the secondary button of ux §3, 13 px text, `--tap` tall) and its
  place (its own row of the conversation, sticky to the bottom of the scroll area).

## Out of scope

- An unread count, day dividers, or any change to how auto-scroll decides that it is at the bottom.
- Any back-end or API change.

## Design

- The follow behaviour is unchanged: `useStickyScroll` keeps the conversation at the bottom while new
  text arrives, and judges "at the bottom" against the height before the update, not the last scroll
  event, as before.
- The scroll listener now also reports whether the person is at the bottom, so the control goes away
  when they reach the bottom by scrolling, by the follow, or by the jump itself.
- The button is the secondary look (1 px border, panel background, 13 px text, `--tap` tall) with the
  existing `arrow-down` icon from the one icon set beside the noun label, which is short (§4).
- Clicking scrolls the conversation to the bottom smoothly; the control then leaves.

## Done when

- The control shows when new messages or streamed text land while scrolled up, near the bottom of the
  conversation; clicking scrolls to the bottom; the control goes away once at the bottom by any means.
- One e2e test covers scroll-up, arrival, see, click, ends-at-bottom; it passes, with screenshots at 1280
  and 390 wide and no horizontal scroll.
- docs/ux.md (§6, §10) and docs/web.md describe what changed; no drift.
- typecheck, tests and e2e pass; a draft PR into `main`.

## Handoff

- Done:
- Open questions: none.
