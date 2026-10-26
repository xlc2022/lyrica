# Brief: Read a long sleep row in place

**Status:** Merged as #592 (`bd1fb7fa`). The welcome page's **From sleep** card, left
out below, was asked for in use and went to #594. Handoff notes are history.
**Branch:** `lyrica/sleep-row-show-more`. **Issue:** #591.
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
- The welcome page's **From sleep** card: left out here on the judgement that its
  link to Sleep sits above it. In use that was wrong — it went to #594, which also
  lifted the measuring into `ClampedText` in `src/ui.tsx` for both places. (Rows in
  the Notifications *card* share `Row`, so they gained the reveal with the page.)
- Citation groups left in a notification title but stripped on the Sleep page —
  drift of its own, filed under Later in #591.

## Design

The link is the **Link** look (§3: "revealing more of a list"). It is a real
`<button type="button">` with `aria-expanded`, like the row's existing **▸ Waiting
threads** toggle.

It is honest to say this is a third visible control on such a row. §3 allows two
actions per row, so `docs/ux.md` §6 records it narrowly: an inline reading
disclosure in the text column, not an action on the item — **Start a chat** and
**Dismiss** stay the only buttons that touch it, and they keep their place in the
row's actions area. It is not read as a general third-action allowance.

It shows only when there is more to see: the rendered element's `scrollHeight`
against its `clientHeight`, measured when the text changes and whenever the row's
width does (a `ResizeObserver`), so it appears wherever the text really overflows —
390 px and 1280 px differ, and a row resized narrow gains the link. What stays the
same is the **collapsed cap: three lines of text**, not the whole row's height, which
grows by the line the link needs; expanded, the list reflows below it.

Mockup, synthetic text (a short row above an affected one):

```
desktop 1280 ── Notifications ───────────────────────────────────────────────────────
 ☾  Fixture note about the greenhouse being warm enough now.        [Start a chat] [Dismiss]
    Something from sleep · general · 04:03

 ☾  Fixture question about whether to plant the beds along the north
    wall this season, since the shade from the fig arrives too late in
    the afternoon to …                                       [Start a chat] [Dismiss]
    Show more
    A question from sleep · general · 04:03

expanded, same row ────────────────────────────────────────────────────────────────
 ☾  Fixture question about whether to plant the beds along the north   [Start a chat] [Dismiss]
    wall this season, since the shade from the fig arrives too late in
    the afternoon to matter for the tomatoes and the soil there drains
    well enough that they should ripen before the first frost; she
    would rather ask than decide alone, because last year rows were
    placed by the fence line and nobody ever measured it.
    Show less
    A question from sleep · general · 04:03

phone 390 ── collapsed / expanded ────────────────────────────────────────────────
 ☾  Fixture question about whether to plant the      ☾  Fixture question about whether to
    beds along the north wall this season, since        beds along the north wall this
    the shade from the fig arrives too late in …        season, since … (all of it)
    [Start a chat] [Dismiss]                               [Start a chat] [Dismiss]
    Show more                                              Show less
    Something from sleep · general · 04:03                 A question from sleep · general · 04:03
```

## Done when

- The API carries the item's whole text past 160 characters (the other shortened
  lines are untouched code); a long **From sleep** row shows three lines and **Show more**.
- Pressing it, or focusing it and pressing Enter or Space, shows the whole text in
  place: same address, no `…/items/<id>/chat` request, no thread; pressing again
  collapses back to three lines.
- A short row has no link at all, and a row that fits at one width gains the link
  when it is narrowed — the measurement follows the width, not a character count.
- The row's checkbox still selects it for the bulk bar, and Dismiss still dismisses.
- One e2e test covers collapsed, expanded, collapse-again and both widths with no
  horizontal scroll; screenshots for UI review.
- `docs/web.md` (Notifications, the welcome cards' line about three lines) and
  `docs/ux.md` §6's Notifications row say what the row does now; no drift.
- typecheck, tests and e2e pass; draft PR to Review and UI review.

## Handoff

- Done:
- Open questions: none.
