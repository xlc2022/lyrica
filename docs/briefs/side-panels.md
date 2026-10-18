# Brief: Side panels and files

**Thread:** Side panels and files. **Branch:** `claude/side-panels-files-o6wo5i`.
**Depends on:** the thread panel (`thread-panel.md`), the memory browser
(`memory-browser.md`), the Files panel.

**Read first:** AGENTS.md, PRINCIPLES.md (2, 6 and 7), docs/ux.md §6 (the
conversation, Memory and Files rows), docs/web.md, docs/memory.md and the
app mockup, version 34 (https://claude.ai/artifact/7CyNY26eu8T7SMD6Sb3WrN).

## Goal

Seven usability asks from the owner's first days with the web UI, all in the
spirit of principle 6 (the user reaches what they need without leaving where
they are) and principle 7 (nothing costs a reload):

1. **Rename in place.** A double-click on a thread or project title, in the
   sidebar or in the page header, turns it into a field. Enter or leaving the
   field keeps the new name; Escape keeps the old one.
2. **A child beside its parent.** With a project chat open, a plain click on
   one of its threads (a sidebar row, or a row of the overview) opens it in
   the panel beside the chat, replacing what the panel showed. Shift+click
   and Open beside still work; below 1180 px the click navigates as before.
3. **The project at a glance.** The header's **Project** button opens the
   project's threads grouped by state (Waiting on you, Working, Idle,
   Resolved) in the panel, with a **Project settings** link inside. On a
   phone it opens the Threads page. Project settings are no longer a header
   button.
4. **Recalled messages open as memories.** The `e:` ids under "Recalled N
   memories" open the memory browser beside the conversation (the page on a
   phone), not the thread they came from.
5. **The Recent layer.** The memory browser gets **Recent**: messages she has
   logged but not slept on yet, read in the browser as memories of their own
   (origin, text, "Came from" the thread) and read-only there. Sleep's
   consolidation cursor is the boundary.
6. **File rows.** Every writable file row carries **Rename** and **Delete** as
   quiet icon buttons on hover or focus (always shown without hover), the
   same actions as the row's menu. The tree reloads itself after each of
   her tool calls in the thread and when the window regains focus.
7. **Deleting a project is quick.** Stopping the sessions of a project and
   its threads runs in parallel, and the store's full-text index is
   optimised once, after the last thread, instead of once per thread.

## Out of scope

Renaming from the keyboard without a mouse (the thread menu's Rename stays
for that); drag and drop in the Files tree; a file watcher (the tree reloads
on activity and focus, not on every change the sandbox makes).

## Contract changes

`GET …/memory/search?kinds=entry` lists the Recent layer; `GET …/memory/e:…`
reads one message as a memory; `PATCH`/`DELETE` on an `e:` id answer 405.
`PoolStore.forgetThread` takes `optimize: false`. See docs/contracts.md.

## Handoff

Done: all seven items, their docs (ux.md §6, web.md, memory.md,
contracts.md), unit tests for the Recent layer and the live reducer's tool
count, e2e steps for the beside click, both renames and the file row
buttons, and the mockup (v34). Next: review by UI review and PR review.
Open question: whether the Files tree should also reload on a timer while a
tool call runs for a long time; today it waits for the call to end.
