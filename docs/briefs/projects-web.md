# Brief: Projects (web)

**Thread:** Web UI. **Branch:** `feature/projects-web`. **Model:** Fable.

**Depends on:** Projects (back end) for its API, and Web UI 2 Part 0 for
the thread menu, the Sort menu and the Notifications page.

**Read first:**
- AGENTS.md, and docs/ux.md every time;
- DESIGN.md: "Projects" and "How the web UI looks" / "Where things are";
- docs/web.md; the API in `daemon/src/api.ts`;
- the app mockup (https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx), with
  the projects frame the UI review thread drew.

## Goal

Li sees a project the way DESIGN describes it, in the agreed look, on a
desktop and at 390 px (principle 1). Every control has its row in ux.md §6.

## In scope

1. **Sidebar.** A project row with the project icon in the pool dot's
   place; its threads nested as child threads are, each with its pool dot,
   state and unseen count; resolved threads under one **Resolved** disclosure
   row with the count in mono; an amber dot on the row when a thread waits
   on Li. **New project** in the empty thread list's context menu (beside New
   group): an empty project chat, like New thread. **Make project** (K) in a
   top-level thread's menu; **Resolve** / **Reopen** (E) in a project
   thread's menu.
2. **Project chat.** The facts line gains **Threads** with its count (mono,
   caret), opening a popover grouped Waiting on you, Working, Queued, Idle,
   Resolved (full width on a phone), and the project's total tokens. Actions
   stay Files and Settings.
3. **Thread cards**, one per thread under the message that started it,
   updated in place from the `child` event: title as written, dot and word
   (Working blue; Waiting on you and Waiting for approval amber; Resolved
   green; Idle the word alone, muted), what it waits on beneath, the last
   update's first line, up to three file names in mono then "+n", and Open,
   Stop, Resolve or Reopen behind ⋯. No per-update cards in a project chat.
   A card waiting on Li carries `data-pending`, so the pending bar reads
   "Thread waiting for your answer".
4. **Suggested threads** card, like the plan card: secondary **Start** per
   row, one primary **Start all**, `data-pending` ("Suggestions waiting for
   your answer"), no Dismiss.
5. **Start a thread** in a message's menu, in a project chat only. A
   resolved thread's message box is replaced by one **Reopen** link.
6. **Project settings page** (Settings in the project chat's header), its
   own address, sections on the left: **General** (the project chat's own
   settings rows first, then Goal, Threads model and thinking, Paused),
   **Memory** (Instructions; a link to the project page in the memory
   browser), **Files** and **Images** (the project folder: upload, new
   folder, rename, move, delete, download, through the Files panel's API).
7. **Notifications:** the **Waiting on you** type, with Open.
8. **Recent calls** filtered to a project, linked from the tokens fact.
9. **Docs:** docs/web.md; the PR lists which ux.md rule each control
   follows, with screenshots at 1280 and 390.

## Out of scope

- Anything the back end doesn't offer yet; new widgets or button looks.

## Done when

- `npm run typecheck` and `npm test` pass; UI review and PR review both say
  verified.

## Follow-up

If the mockup frame for projects isn't in the app mockup when this starts,
ask the UI review thread for it before building the sidebar row and the
card.

## Handoff notes

(The thread fills this in if it stops before it's done.)
