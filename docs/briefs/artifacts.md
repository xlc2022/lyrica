# Brief: Artifacts

**Status:** Agreed (2026-11-11): the owner chose to build it with React
components. Building; nothing has merged.

**Thread:** Add artifacts to Lyrica. **Branch:** `claude/project-thread-sso301`.
**Model:** Opus.

**Read first:** AGENTS.md, DESIGN.md "Files and images", docs/ux.md §6 (the
Files panel row, "A file opened from a library"), docs/web.md ("The file
viewer"), docs/workspace.md (the `page` tool, "Offline libraries"),
`daemon/src/file-view.ts`, `core/src/workspace/page.ts`,
`extension/src/page.ts`, `web/src/Viewer.tsx`.

## Goal

The user asked (2026-11-11) that Lyrica make artifacts as Claude does, and
that the mockups made as Claude artifacts can be imported (principle 1: the
user asked; principle 6: review made easy).

An **artifact** is one self-contained page (HTML, SVG, Markdown or a React
component) with a title, kept with every version it has had,
shown as a card in the conversation, opened large in a sandbox, and listed
in one place.

## What exists already

- She writes HTML in her thread's folder; `page preview`, `page bundle` and
  `page check` look at it, make it one file and say what it would still
  load (docs/workspace.md).
- The file viewer runs an HTML file in a sandbox with an opaque origin
  (`GET …/files/view`), with its console, and shows SVG and Markdown
  rendered. With the thread's internet off the page runs no scripts.
- Thread folders are in the user's encrypted home.

So a page she writes can already be opened. What an artifact adds is a
name, versions, a card, a list, and a way in for pages made elsewhere.

## Design

### Storage

Two tables in each pool's database (expand-only, one pool step, with its
migration test):

- `artifacts`: id, title, kind (`html`, `svg`, `markdown`, `react`),
  the thread it belongs to or none, the path it was published from or
  none, created, updated.
- `artifact_versions`: artifact, number, the page's bytes, who made it
  (`lyrica`, `user` for an import or restore), when.

Why the database and not files: a version must not change when she edits
or deletes the file it came from, an imported artifact has no thread
folder, and the list is one query (principle 4). The bytes are encrypted
like the rest of the pool, so nothing is plaintext on disk. A private
pool's artifacts are in the private database and are never listed or served
outside it.

One sentence of guarantee (principle 7): a version is at most 16 MiB (the
viewer's limit), every version is kept until the user deletes it or the
artifact, and forgetting a thread deletes its artifacts unless the user
keeps them, which leaves them with no thread.

### How she makes and updates one

No new tool (principle 8): `page` gains two actions.

- `page publish` takes a path in the thread's folders and an optional
  title. The first publish of a path makes an artifact; a later publish of
  the same path adds a version. It runs `check` first and refuses a page
  that needs local sibling files, telling her to `bundle` it. It returns
  the artifact's id, version and what `check` found.
- `page artifacts` lists the thread's artifacts (and a project's, in its
  threads): id, title, kind, version, path.

`publish` writes to the database only, so it asks nowhere and is allowed
in every mode but Plan. She can't delete an artifact or a version; only
the user can. Her prompt gets one line: publish a page the person should
keep or look at again, not every scratch file.

### How it is served

`GET …/artifacts/<id>/view?v=<n>` answers with the same headers as
`files/view` (`viewHeaders`): HTML under the CSP `sandbox allow-scripts
allow-popups`, never `allow-same-origin`, so the page has an opaque origin
and can't reach Lyrica's cookies, storage or API; SVG with nothing run.
The internet rule is the thread's, as for a file: with the thread's
internet off, no scripts and nothing loaded from outside. An artifact with
no thread follows the user's default for new threads. Nothing about the
boundary is new; the route reads a different store.

The address works on its own in a tab for the signed-in user. There are no
public links.

### Import

**Import** takes one or more files (`.html`, `.htm`, `.svg`, `.md`, `.jsx`,
`.tsx`) or pasted source with a title, and makes each an
artifact at version 1, authored `user`, in the pool chosen, belonging to
the thread or project it was imported from, or to none from the list page.
The same 16 MiB limit applies; an import is never run or read by a model
at import time. Importing a file onto an existing artifact (**Add
version…**) adds a version.

Claude's artifacts can't be fetched by Lyrica, so the user downloads each
one from Claude (or a Claude thread saves their sources as files) and
imports the files. Their version history on Claude doesn't come along.

She can also publish a file the user uploaded into a thread, which is an
import by asking.

### Interface

Each control needs its row in docs/ux.md §6; UI review judges the
mockup before the web part is built.

- **In the conversation:** a `page publish` call shows as an **artifact
  card** in her reply: title, kind and "Version n" in the facts line, and
  **Open**. A later version in the same thread updates nothing above it;
  each publish has its own card.
- **Opened:** the file viewer, as for a file: the page at the left, its
  thread at the right. Its header gains a **Version** picker (newest
  first, with the time), and its ⋯ menu Open in new tab, Download, Copy
  link, Add version…, Restore this version (makes a new version from an
  old one), Rename… and Delete….
- **The list:** an **Artifacts** page from the sidebar, beside Memory and
  History: a grid of cards (title, kind, version count, thread, updated),
  search, the pool filter the thread list uses, and **Import**. A thread's
  Files panel gains an **Artifacts** segment after Videos for its own.

## Parts

1. **Core and daemon:** the tables and migration, `page publish` and
   `page artifacts`, the view, list, import, rename, restore and delete
   routes, thread forget. PR review (migration, agent loop, the sandbox
   route).
2. **Web:** the card, the viewer's version picker and menu, the Artifacts
   page, Import, the Files panel segment, the mockup. UI review and PR
   review (docs/ux.md).
3. **React components:** `kind: react` for `.jsx` and `.tsx`. The source
   is kept as written; `buildReactPage` (`core/src/workspace/react-page.ts`)
   has esbuild make it one HTML page with React, lucide-react, recharts
   and Tailwind's browser build inside, so it loads nothing from outside
   (it runs only with the thread's internet on, as any page's scripts). It
   is built when a version is made and the built page is kept beside the
   source. The source may import only that closed list, enforced by the
   build, and is never run in `lyricad`. The builder is being written by
   Codex on the test machine from
   `/mnt/project-files/handoffs/artifacts-react-builder.md` (the owner
   asked, 2026-11-11); this thread wires it in.
4. **Sharing with another user on the server,** as Share with does for a
   thread: a copy, never a live link. Not asked for; not planned.

## Out of scope

- Public or unauthenticated links.
- Artifacts of several files; `page bundle` makes one file.
- Storage, a database or model calls for a running artifact (Claude's
  runtime capabilities).
- Fetching from claude.ai.
- Comments on an artifact.

## Tests

The pool migration from every released schema; a publish, update, restore
and delete round trip; a private pool's artifact never listed or served
from General; the view route's headers with internet on and off; one e2e
for publish → card → open → pick a version, and one for Import.

## Docs to update when built

DESIGN.md (Files and images; Storage), docs/contracts.md (the store, the
`page` actions, the routes), docs/workspace.md (`page`), docs/daemon.md,
docs/web.md, docs/ux.md §6, the user guide, the app mockup.

## Open question for the owner

Should the two project mockups move to Lyrica as artifacts once import
works, so her threads update them there?

## Handoff notes

- 2026-11-11: brief written from the code at 8d6c19b. The owner chose React
  now.
- 2026-11-11: part 1 built on this branch (PR #983): pool step 17,
  `ArtifactLibrary`, `page publish` and `page artifacts`, the routes, the
  `artifact` message part. Differences from the plan above: there is no
  delete of a single version; a thread's artifacts are kept with no thread
  when it is deleted with Keep memories, and deleted otherwise; an artifact
  with no thread follows its pool's default network; `publish` also takes
  an `artifact` id, since a renamed file has a new path. React is refused
  by `publish` and import until the builder lands. Next: part 2 (web),
  starting with the mockup for UI review; then wire `buildReactPage` in
  from the test machine's branch.
- 2026-11-11: part 2 built (the card, the viewer's version select and ⋯
  menu, the Artifacts page, Import). Not built, and not planned unless
  asked: pasted source (Import takes files), the Files panel's Artifacts
  segment, a grid of cards (the page is a list). The app mockup has not
  been updated. Next: React, once the builder's branch arrives.
- 2026-11-11: part 3 wired in. The builder came from the test machine's
  branch `codex/artifacts-react-page` (e3b75bb), merged here; `page
  publish` and import build `.jsx` and `.tsx` with it and keep the page
  beside the source. `bundlePage` does not resolve React (the handoff's
  step 3 was skipped), so a page she bundles herself can't import it.
- 2026-11-11: the owner asked why artifacts had a sidebar page and chose
  **Files panel only**. The Artifacts page, its sidebar row, its address and
  Copy link are gone; the Files panel has an **Artifacts** tab after Videos
  with **Import…**, and a project chat's tab lists its threads' artifacts.
  Every artifact now belongs to a thread: import needs one, the list route
  is per thread, and deleting a thread deletes its artifacts whether its
  memories are kept or not. This replaces "The list" under Interface, the
  thread-less import under Import and the Keep memories note above.
- 2026-11-12: PR review found that esbuild expands a computed `require()`
  or `import()` into a glob over the daemon's disk, past the import list.
  A component now may have neither (both are refused before bundling), it
  resolves from an empty folder, and the page is refused if any file in it
  is not a library's. Whether a built page may run scripts with the
  thread's internet off is a boundary change for the owner, not decided.
