# Brief: Memory browser, the notebook

**Thread:** Memory browser. **Branch:** `feature/memory-browser`.
**Model:** Fable (a user sees all of it; the API part rides along).
**Depends on:** nothing. **Runs alongside:** Web UI 2.

**Read first:** AGENTS.md, PRINCIPLES.md (5 and 6), DESIGN.md "Memory",
docs/memory.md "The memory browser", docs/contracts.md (the planned
entries under the daemon's memory browser), docs/ux.md §6 (the Memory rows)
and the app mockup's memory frame (version 27,
https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx#memory/none/p:proxmox-homelab).
The proposal and screenshots are in the project files under
`memory-browser/`.

## Goal

The memory browser reads like a notebook, the way Obsidian does, so that
reviewing what Lyrica wrote is a thing Li does by wandering rather than by
searching (principle 6). Nothing new is stored: links stay citations by ID
in the text, lineage stays derived from them (principle 5), and the owner
view stays the only way in.

Li's picks (2026-10-11): no graph; a browse pane by layer; links as titles
stored as IDs; hover previews; backlinks with the citing sentence; notes'
`about` as tags; a textarea with `[[` autocomplete and Preview; word diffs
in history; memory in the panel from a conversation; no note to her about
edits; "Remember this" on a message.

## In scope

1. **The browse pane** (`web/src/Memory.tsx`, the Files panel's layout):
   a search box above a segmented control **Pages | Notes | WAKE |
   Journal**, one filters row (pool select; **User introduced**), and the
   layer's list newest first, paged. Search replaces the list with hits
   across layers while a query is typed. On a phone the pane and the memory
   alternate, with a **Memory** back button. The page header states facts
   (pages, notes, when she last slept) and holds **Add a memory**.
2. **Links as titles.** In a memory's text, `[p:slug]` renders as the
   page's title, `[t:…]`/`[e:…]` as the thread's title (as today), and
   `[n:…]` as a dated source mark in mono. Each is a link that opens the
   memory in place (the breadcrumb grows, as the panel does) and shows a
   preview (title or first line, pool, date) on hover or focus. The stored
   text keeps the IDs; nothing is rewritten. The API supplies the titles:
   `MemoryDetail.links` (contracts). A general reader never receives a
   private title; a hidden pool's memory shows "Private is hidden".
3. **Came from and Used in** as cards: title or first words, date, and the
   citing sentence, rendered with titles. `usedIn` returns the sentence,
   and only from pools the display filters show: a citer in a hidden pool
   keeps its id, gets no sentence, and shows as "Private is hidden", like
   a link. A private note's words never reach a general memory's detail.
4. **History** as word differences: each revision against the current
   text, computed in the browser (a small word-level diff, no dependency),
   with **Restore**. No diff is stored.
5. **Tags:** a note's `about` words as chips; the Notes layer lists the
   pool's tags (`GET …/memory/about`) and a tapped tag filters the list
   (`about=`). Pages get no tags.
6. **Editing in place:** **Edit | Preview** segment, the textarea, Save as
   the one primary. `[[` opens a popover of pages (saved as `[p:slug]`) and
   people (saved as name tokens, as today). Notes stay cited by ID in the
   editor. No draft in `localStorage` or `sessionStorage`; leaving with an
   unsaved edit asks first (the browser's own prompt).
7. **Memory in the panel:** a recall marker's entries, a citation in her
   text and a sleep item's source open the memory in the panel from 1180 px
   up (`…/panel/memory/<pool>/<id>`), the page below it. The panel's
   breadcrumb and Open as a page work as for threads.
8. **"Remember this"** in a message's menu (feature comparison item 7): a
   one-line note in the User introduced collection, prefilled with the
   message's first line and editable before saving, in the thread's pool,
   citing the message. A new ⋯ item, so docs/ux.md gets its line.
9. **Docs** in the same PR: docs/memory.md "The memory browser", docs/web.md
   Memory, docs/ux.md (the Remember this line; the Memory rows exist),
   docs/contracts.md (planned → real).

## Out of scope

A graph, local or whole-pool (Li, 2026-10-11, after seeing both drawn);
tags on pages; a live-preview editor (CodeMirror); drafts kept in the
browser; unlinked-mention search; a plaintext export (the encrypted Export
belongs to the feature comparison's item 11); telling her about edits
(she reads the current text from her next turn, and sleep already sees
`editedSince`).

## The hard rules

- The browser reads through `openOwnerView` only. Titles for links are
  read in the same owner view; a general ID's detail never carries a
  private title, snippet or citing sentence.
- Titles, previews and diffs live in React state, computed from the API
  response. Nothing of a memory's text goes to `localStorage`,
  `sessionStorage` or any log.
- Another user's memory is unreachable by construction; nothing changes.

## Tests (what Li would notice)

- A general memory's detail never carries a private title, snippet or
  citing sentence, with the private pool shown or hidden.
- An edit keeps name tokens and citations; the rendered titles follow a
  page rename and a thread rename without a save.
- Restore after a diff round-trips the text exactly.
- A recall marker opens the panel at 1280 and the page at 390; no
  horizontal scroll at 390.
- "Remember this" saves a User introduced note citing the message, in the
  thread's pool, and it shows under User introduced.

## Checklist (docs/ux.md §10)

Say which rule each control follows; screenshots at 1280 and 390, light and
dark; labels from §4; no captions (the Graph caption was already removed in
review); numbers in mono.
