# Brief: The file viewer

**Status:** Done. The viewer merged in #388; Part 2, the record of which
thread wrote each file, merged in #391.

**Thread:** File viewer. **Branch:** `claude/project-thread-mws19s`.
**Model:** Opus.

**Read first:** AGENTS.md, DESIGN.md "Files and images", docs/ux.md §6
(the Files panel row, "A file opened from a library", the Project settings
row), docs/web.md ("The Files panel", "The file viewer"), docs/daemon.md
(the Files routes), `web/src/Viewer.tsx`, `daemon/src/file-view.ts`.

## Goal

The user asked (2026-10-20) that opening a file or web page from a thread's
file library open it large with the thread that produced it beside it, as
Claude's own app does, instead of showing HTML and similar files as raw
text (principle 6: what the user needs, without leaving where they are).

## In scope

1. **The viewer:** a dialog almost the window's size (the whole screen on a
   phone): the file at the left, the thread at the right from 1180 px up;
   below that a **Thread** button switches between them.
2. **Which thread:** the Files panel's own thread for a file in its thread
   folder; the project chat for a file in Project settings → Files and
   images. A file in a granted folder has no thread and opens on its own.
   Nothing records which thread wrote a file, so this is the thread whose
   folder holds it.
3. **What it shows:** HTML as a page in a sandboxed frame with its console
   under it; SVG and Markdown rendered, with **Preview | Source**; PDFs,
   images, audio and video in the browser's viewers; text as text; anything
   else with Download.
4. **The sandbox:** a new route, `GET …/files/view`, serves HTML with the CSP
   `sandbox allow-scripts allow-popups` (an opaque origin even when opened
   on its own: no cookies, storage or readable Lyrica answers), SVG with
   nothing run, and only real PDFs. `…/files/content` stays plain text.
5. Opening from the Files panel's tree, its Images tab, a path linked in a
   message, and Project settings' Open and image tiles. The panel's own
   file column goes.
6. **Docs:** docs/ux.md, docs/web.md, docs/daemon.md, DESIGN.md, the
   `api.ts` comment, the app mockup.

## Part 2: which thread wrote a file

The user asked (2026-10-20) that the viewer show the thread that made the
file, with the record cleaned up when the file is deleted. Files in a
project folder and in `/shared` are written by many threads, so the folder
alone doesn't say.

- `user.db` step 15 adds `file_origins` (folder's thread, path in it,
  thread, time; no content), last writer wins.
- Recorded from her sandbox `write`, `edit` and `bash` calls (a sweep for
  files newer than the call's start), uploads and her images.
- Dropped by the panel's Delete, moved by its Rename, pruned by a whole
  listing of a folder (for files her commands delete), and dropped with a
  forgotten thread or folder and by the nightly sweep.
- Listings carry `madeBy`; the viewer shows that thread and falls back to
  the library's own.

## Out of scope

- An HTML page's relative links to its sibling files (the sandboxed page
  has no cookie to fetch them with); self-contained pages and https
  resources work.
- Syntax highlighting (no highlighter in the bundle; code in messages has
  none either).
- Message thumbnails keep the Lightbox, since their thread is already open.
- Part 2: her writes on a machine or in a granted folder, and a removed
  turn's undone files until the folder is next listed.

## Done when

- `npm run typecheck` and `npm test` pass; the e2e Files tests pass at 1280
  and 390; PR review (the sandbox is a security boundary) and UI review say
  verified.

## Handoff notes

- 2026-10-20: part 2 built. Only bwrap hosts run the Files panel's sandbox
  test that checks the panel's origin events.
- 2026-10-20: built as in scope. Locally the e2e step "the tree follows what
  she writes" fails because bash can't run in this container; CI decides.
