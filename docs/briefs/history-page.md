# History pages

## Goal

Serve principle 6, Trust her judgment; make review easy, and principle 8,
Small surface, held to a budget: nightly history stays easy to review without
making the memory page grow forever.

## In scope

Memory versions (notes, pages, WAKE and journal entries), sleep runs, and
model call history. Each preview shows only the most recent entry, with a
plain **Show all** link right-aligned beside the History eyebrow. The link
opens a reusable history page with a Search field and numbered pages, using
existing components, typography, controls and icons, noun labels and no
captions. Large lists are searched and paged on the server with limit,
offset, q and a filtered total, documented in the contracts. Sleep is wired
first, then memory versions and model calls.

## Out of scope

The journal's memory browser already lists entries with server-side search
and paging; it is a collection, not an inline history. Current routines and
subagents are active work, not historical logs. Kept update releases are
bounded (last five plus current and previous), and last rollback is already
one entry. No storage migration, retention change, model calls, new widget
styles or changes to memory boundaries. No message text in logs.

## Done when

Previews contain one entry; heading links open searchable numbered history
pages; API tests cover paging, counts and search; the sleep web e2e covers
the preview, navigation, paging and search at desktop and phone widths.
Docs match the implementation. Targeted tests run under the shared lock,
using fakes only. The local Playwright config stays untracked. Work is
committed, without pushing.

## Handoff

Implementation in progress. Full suite and pushing belong to the user.
