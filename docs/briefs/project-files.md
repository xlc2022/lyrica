# Brief: Project settings: Files and images

**Thread:** Project files and images. **Branch:**
`claude/project-files-images-q3gsot`. **Model:** Opus.

**Read first:** AGENTS.md, DESIGN.md "Projects" (the Files bullet and
Project settings), docs/ux.md §6 (the Project settings row and the Files
panel row), docs/web.md ("Project settings page", "The Files panel"),
docs/daemon.md (the Files panel routes), `web/src/Project.tsx`,
`web/src/Files.tsx`, and the app mockup's project settings page
(`#project/p1/files`).

## Goal

The user manages a project's shared folder in the project's own settings
(principle 1). The project chat's folder is the project folder, a root in
every thread of the project. Today its files are reached only through Files
in the project chat's header, a thread's quick view, which has no Move
and mixes the folder with the chat's other grants. The owner asked
(2026-10-18) for the designed section to be built.

## In scope

1. **Files and images**, the third section of the Project settings page
   (`…/p/<pool>/<project>/files`), after Memory.
2. A row of controls under the heading: **Files | Images** (a segmented
   control), then **Upload** and **New folder**.
3. **Files:** the project folder one folder at a time, with the folder's
   path above the list as crumbs (**Project folder** first). Folders first.
   Each row: an icon, the name in mono, and its facts muted (a folder says
   Folder; a file its time and size, in mono); **Open** (a folder opens in
   the list, a file in the project chat's Files panel with it shown) and a
   ⋯ with Download (Download as zip for a folder), Rename…, Move to… and
   Delete…. Rename edits the name in place; Move to… opens a **drawer**
   with a Folder select (every folder of the project folder) and one Move;
   Delete… is confirmed by a dialog with one sentence. New folder adds a row
   whose name is edited in place. Dropping files on the section uploads them
   to the folder shown.
4. **Images:** All, Uploaded, Made by Lyrica, and a grid of the folder's
   images; a tile opens the image large, and its name carries the same ⋯.
5. The list follows the project: it reloads when any thread finishes a tool
   call or a turn, and when the window comes back into focus.
6. Everything goes through the Files panel's routes on the project chat
   (`…/files`, `/images`, `/content`, `/upload`, `/folder`, `/rename`,
   `/delete`, `/zip`); `rename` moves. Nothing new in `lyricad`.
7. **Docs:** docs/ux.md (the Project settings row gets the section back),
   docs/web.md, DESIGN.md (Projects), docs/briefs/projects-web.md and
   docs/briefs/design.md (no longer "not built"), the mockup.

## Out of scope

- Starter recipes (the Image settings and recipes thread).
- Who made a file (no back end for it); selection of several rows; the
  Files panel itself.

## Done when

- `npm run typecheck` and `npm test` pass; UI review and PR review both say
  verified; screenshots at 1280 and 390.

## Handoff notes

- 2026-10-18: built as in scope; PR open for review.
