# Brief: Read a long sleep row in place

**Status:** In progress. **Branch:** `lyrica/sleep-row-show-more`. **Issue:** #591.
**Read first:** AGENTS.md, PRINCIPLES.md, docs/contracts.md, docs/ux.md (§1, §3, §6
"Anything waiting for the user", §8, §10), docs/web.md (Notifications, the welcome
cards).

## Goal

A **From sleep** row in Notifications whose text is long is cut off — at 160
characters by `daemon/src/notifications.ts`, and again to three lines by CSS — and
nothing on the row opens the rest. The only ways past the cut are **Start a chat**,
which creates a thread, or finding the item again on the Sleep page. So reading one
thing she wants a decision about costs either a new conversation or a trip
elsewhere.

Principle 1: what the user notices this month is that a message waiting for her can
be read where it waits. Principle 8: one link in an existing row, and a truncation
that exists only because there was no way to expand goes away.

## In scope

- `daemon/src/notifications.ts`: a sleep row's title carries the item's whole text.
  The `DETAIL` slice stays where it is used for fact lines.
- `web/src/Notifications.tsx`: in a **From sleep** row, the title is clamped while
  collapsed; when the clamp actually hides something, a **Show more** link at its
  end expands the text in place and reads **Show less**.
- `web/src/app.css`: the clamp applies only while collapsed.

## Out of scope

- Any new endpoint, field, page or widget; any change to what the row's buttons do.
- The welcome page's **From sleep** card, whose items keep clamping to three lines:
  its own link to Sleep sits above them. (Rows in the Notifications *card* share
  `Row`, so they gain the reveal with the page.)
- Citation groups left in a notification title but stripped on the Sleep page —
  drift of its own, filed under Later in #591.

## Design

The link is the **Link** look (§3: "revealing more of a list"), not a third button:
it sits at the end of the text column, so §3's two visible actions per row are still
**Start a chat** and **Dismiss**, and pressing it cannot reach either. It is a real
`<button type="button">` with `aria-expanded`, like the row's existing **▸ Waiting
threads** toggle.

It shows only when there is more to see, measured the way `FromThread` in
`web/src/Messages.tsx` measures (the rendered element's `scrollHeight` against its
`clientHeight`) rather than by a character count, so it appears at whatever width
the text actually overflows — 390 px and 1280 px differ. Collapsed, the row is the
same height as now; expanded, the list reflows below it.

Mockup, synthetic text (a short row above an affected one):

```
desktop 1280 ── Notifications ───────────────────────────────────────────────────────
 ☾  Fixture note about the greenhouse being warm enough now.        [Start a chat] [Dismiss]
    Something from sleep · general · 04:03

 ☾  Fixture question about whether to plant the beds along the north
    wall this season, since the shade from the fig arrives too late in
    the afternoon to matter for the tomatoes and the soil there drains
    well enough that …                                       [Start a chat] [Dismiss]
    A question from sleep · general · 04:03                    Show more

expanded, same row ────────────────────────────────────────────────────────────────
 ☾  Fixture question about whether to plant the beds along the north
    wall this season, since the shade from the fig arrives too late in
    the afternoon to matter for the tomatoes and the soil there drains
    well enough that they ripen before the first frost. She would
    rather ask than decide alone, because last year's rows were placed
    by the fence line and she is not sure that was ever measured.
                                                              [Start a chat] [Dismiss]
    A question from sleep · general · 04:03                     Show less

phone 390 ── collapsed / expanded ──────────────────────────────────────────────────
 ☾  Fixture question about whether to plant the   ☾  Fixture question about whether to
    beds along the north wall this season, since      beds along the north wall this
    the shade from the fig arrives too late in …      season, since … (all of it)
    Something from sleep · general · 04:03            [Start a chat] [Dismiss]
    [Start a chat] [Dismiss]                          Show more → Show less
```

## Done when

- A long **From sleep** row shows three lines and **Show more**; pressing it shows
  the whole text in place, the address does not change, no `…/items/<id>/chat`
  request is made and no thread appears; pressing again collapses.
- A short row has no link at all.
- One e2e test covers both widths with no horizontal scroll; screenshots for UI
  review.
- `docs/web.md` (Notifications, the welcome cards' line about three lines) and
  `docs/ux.md` §6's Notifications row say what the row does now; no drift.
- typecheck, tests and e2e pass; draft PR to Review and UI review.

## Handoff

- Done:
- Open questions: none.
