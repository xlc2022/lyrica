# Brief: Thread panel (Overview, double-click, View thread)

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

1. **Overview** in the project chat's header, beside Project settings (a
   noun label). It toggles the panel with the project's threads grouped as in
   the Threads popover (Waiting on you, Working, Queued, Idle, Resolved): each
   row is title, state, one line of the latest message. A row swaps that
   thread into the panel; the breadcrumb, **Open as a page** and **Close
   panel** work as they do. Below 1180 px it is the project's Threads page
   at the same address (ux.md: no panel on a phone).
2. **Double-click** on a child thread's sidebar row, with a thread open and
   at 1180 px or wider, opens it in the panel beside the open thread, in a
   project or not. A single click still navigates. Below 1180 px a double-click
   is the page. Keyboard: Shift+Enter on a focused row does the same.
3. **View thread** on a thread card in the chat (secondary button under the
   title) opens the panel, as the title link does now. The small "Open" link
   on subagent runs (`ThreadLinks`, Messages.tsx) opens the panel too at 1180 px
   and wider.

## Out of scope

No new API: the Threads popover's data feeds Overview. No changes to the Files
panel, a phone layout, or panel width.

## Docs to update in the same PR

docs/ux.md (a §6 row for Overview and the double-click rule; add the new
labels to its label list), docs/web.md (panel triggers), this brief's handoff.

## Steps for a small model (one per run, each self-contained)

Run `npm run typecheck` after each step. One test suite at a time.

1. `web/src/Shell.tsx`: in the sidebar's `ThreadLink`, add an `onDoubleClick`
   that, when `useWide()` is true and the current route is a thread, calls
   `go({ ...route, drawer: undefined, panel })` with `panel = { page: "thread",
   pool: t.pool, threadId: t.id }` and starts a new trail
   (`trail.set([panel])`). Reuse the code at the end of `openInPanel`; extract
   it into a helper rather than copying. Nothing else.
2. `web/src/Messages.tsx`: in the thread card component, add a **View thread**
   button (class `secondary`) under the title that is an `<a>` to the thread's
   href, so the existing `openInPanel` click handler opens it. Same for the
   `Open` link in `ThreadLinks`: nothing to add, only confirm it is an `<a
   href="#/u/...">` and so is covered; add a one-line comment saying so.
3. `web/src/Project.tsx` and the project chat header: add the **Overview**
   button. It is an `<a>` to a new panel page `{ page: "threads", pool,
   threadId }` (add to `Panel` and `parse`/`href` in the router file, and
   render the Threads popover's list inside the panel). Reuse the popover's
   grouping function; do not copy it.
4. docs and e2e: edit the docs listed above; extend the "the split view"
   test with a double-click on a sidebar child row, a **View thread** click
   and an **Overview** open, each followed by the panel being visible, and a
   check that below 1180 px they navigate.

## Handoff

Done: nothing built. Next: steps 1 to 4 in order. Open: whether Overview's
rows need the latest-message line at launch (drop it if the list API doesn't
give it).
