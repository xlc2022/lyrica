# Brief: Thread panel (threads list, Open beside, View thread, divider fix)

**Status:** Merged as #276 (0700d82). Handoff notes below are history.

**Thread:** Web UI. **Branch:** `feature/thread-panel`. **Model:** Qwen on
lunasa first (small steps below), Codex as the fallback; Fable reviews the UI.

**Read first:** AGENTS.md; docs/ux.md §6 (the right panel) and the mobile
section; docs/web.md; DESIGN.md "Where things are". The panel code is in
`web/src/Shell.tsx` (`SPLIT_WIDTH`, `openInPanel`, `usePanelTrail`); its e2e
test is "the split view" in `web/e2e/web.spec.ts`.

## Goal (principle 1: she is easy to live with)

The split view exists but is hard to find: it opens only from a link inside a
conversation, only at 1180 px and wider. Make a thread one gesture away,
as the Claude app's Overview button and thread cards do.

## In scope

0. **Fix the divider (bug).** The panel's divider shows a resize cursor and
   dragging does nothing: `PanelColumn` sets `--panel-w` on the `<aside>`, but
   the grid that reads it (`.app[data-panel="true"]` in app.css) is the aside's
   parent, so the variable never reaches it and the column stays 420 px.
   Set it on the `.app` element instead (a layout effect on
   `ref.current.parentElement`, removed on unmount). Keep the 360 to 520 px
   range and the stored width.
1. **Threads opens the panel list** from the project chat's facts line, at
   1180 px and wider, in place of the popover; below 1180 px it keeps the
   popover. There is no second Overview button, so one list has one entry
   point (ux.md "A project's threads at a glance"). If the owner asks for the button by
   name, it replaces Threads in the facts line. The list is the popover's
   groups (Waiting on you, Working, Queued, Idle, Resolved). Rows follow ux.md
   §5: state as a dot and a word, times in mono, the latest message muted and cut
   to one line. A row swaps that thread into the panel; breadcrumb, **Open as a
   page** and **Close panel** work as they do. The Threads fact is a toggle:
   `aria-pressed`, pressed look while the panel shows the list.
2. **Open beside** for a child thread's sidebar row, with a thread open and at
   1180 px and wider: **Open beside** (B) in the row's right-click menu (long
   press on a phone is the same menu), Shift+click and Shift+Enter on a focused
   row, each with `preventDefault()`. It opens the child in the panel beside the
   open thread, in a project or not. A plain click navigates as before. Below
   1180 px the item is not shown and Shift+click is a plain click. (Double-click
   cannot work on a row: the first click already navigates.)
3. **View thread** on a thread card in the chat: a button in the card's action
   row (`className="sm"`, the default secondary look) that opens the panel, and a
   double-click on the card does the same. Ignore the double-click when it lands on a link or
   button, or leaves a non-empty `getSelection()` (a user selecting text to copy). Below 1180 px both open the full page.
   The per-run "Open 1", "Open 2" links (`ThreadLinks`, Messages.tsx) are replaced,
   when a run made more than one thread, by one **Threads** button with the count in mono and a chevron (Threads 3 >, turning
   down while open) in the card's head (`aria-expanded`): it expands the pill into a
   list of those threads, each row the thread's title cut to one line and its state
   as a dot and a word (§5); on coarse pointers a row is a 44 px tap, and at 390 px the
   list takes the card's full width, in flow, not as an overlay; a link that opens the panel at
   1180 px and wider and the page below. One thread keeps a single **Open** link,
   which does the same.

## Out of scope

No new API: the Threads popover's data feeds the panel list. No changes to the
Files panel, a phone layout, or the panel's 360 to 520 px range.

## Docs to update in the same PR

docs/ux.md (a §6 row for the panel list, Open beside and the card gestures; add
Open beside and View thread to its label list), docs/web.md (panel triggers),
this brief's handoff. Screenshots to attach: the panel list and Open beside at
1280, and the 390 fallback.

## Steps for a small model (one per run, each self-contained)

Run `npm run typecheck` after each step. One test suite at a time.

1. `web/src/Shell.tsx`, `PanelColumn`: move `--panel-w` from the aside's
   `style` to the `.app` element (item 0). Extend the split-view e2e test with a
   divider drag that changes the panel's width.
2. `web/src/Shell.tsx`: extract the end of `openInPanel` (build the panel, set the
   trail, `go`) into a helper `showInPanel(route, trail, panel)`. In the sidebar's
   `ThreadLink`, call it from Shift+click, Shift+Enter and a new **Open beside**
   menu item (B), only when `useWide()` and a thread is open. Below 1180 px Shift+click still calls `preventDefault()` and navigates itself,
   or the browser opens a new window.
3. `web/src/Messages.tsx`: add **View thread** and the card double-click (item 3),
   as `<a>` to the thread's href so `openInPanel` handles it.
4. `web/src/Project.tsx` and the project chat's facts line: make Threads open a
   new panel page `{ page: "threads", pool, threadId }` at 1180 px and wider (add
   to `Panel`, `parse` and `href` in the router file), rendering the popover's list
   (reuse its grouping function, do not copy it).
5. docs and e2e: edit the docs above; extend the split-view test with Open beside,
   View thread and the Threads list, and check below 1180 px they navigate.

## Handoff

Done: steps 1 to 5 built — the divider's `--panel-w` reaches `.app` and drags;
`showInPanel`, **Open beside** (B) with Shift+click and Shift+Enter on a child
row; **View thread** at a card's foot and its double-click, with one **Threads
<n>** pill replacing the per-run Open links when a run made several; the
`{page:"threads"}` panel page toggled by the Threads fact from 1180 px up (the
popover below); docs/ux.md, docs/web.md and this brief updated; the split-view
e2e test extended with all of it and the below-1180 px navigation. Next: the PR
to review, with screenshots at 1280 and 390. Open: none — the list's rows show
state as a word and the time in mono, no latest-message line (the overview
gives `updatedAt`, not a message preview).
- 2026-10-22: the panel's range widened to 280 to 1000 px at the user's ask (the grid holds it short of leaving the conversation under 48ch), and the sidebar's right edge drags too; docs/ux.md §6 and docs/web.md have both.
