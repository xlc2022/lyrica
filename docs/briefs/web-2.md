# Brief: Web UI 2 (the Models page, Sleep and images)

**Thread:** Web UI. **Branch:** `feature/web`. Each part is its own PR,
started when its API lands:

| Part | Needs |
|---|---|
| Models page | Models 2's API |
| Sleep section | Sleep's API |
| Images and portrait photos | Images' API |

**Read first:** docs/briefs/web.md and docs/web.md, DESIGN.md ("How the web UI
looks", "Models and endpoints", "Sleep" and "Images"), and the API in
`daemon/src/api.ts`.

**Read first, every time:** docs/ux.md. A PR that touches the interface
follows its checklist.

## Goal

The web UI shows what the new back ends do, in the agreed look, and works on a
phone (principle 1).

## In scope

0. **The look and the shell**, from the app mockup
   (https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx) and DESIGN's "How the
   web UI looks" and "Where things are":
   - IBM Plex Sans and Mono, self-hosted in the web build (OFL licence file
     included), with system fallbacks; the five sizes; the three action
     looks; badges for state only; no explanatory captions.
   - The sidebar as described, with thread sorting (by date, last activity,
     start date, title) and the user's own groups (made and filled from a
     thread's header or a right-click / long-press menu), saved per user (a small
     API and a `thread_groups` table in `user.db`; a thread's group is a
     per-user setting, never in the pool). One Sort menu holds the sort
     choices and the General / Private / Hidden checkboxes.
   - The thread menu (right-click or long press, letter shortcuts): Pin,
     Mark as unread, Rename, Share with ›, Move to group ›, Hide, Delete.
     Pin uses the per-user thread pins that Projects (back end) builds.
     **Share with** sends a copy to another user on the server: a
     notification for them with Add to General, Add to Private and Decline;
     accepting copies the entries into a new thread in their pool, as an
     export does, and indexes it there. Nothing of the sender's memory goes
     with it. Tests: a declined share leaves nothing in the recipient's
     pools; a shared private thread lands only where the recipient chooses;
     the sender's later messages never reach the copy.
   - The header shows "Lyrica (ver. …, build …)" inline, with the date
     beneath; the daemon reports its version (package.json) and build (the
     git commit, set at build time).
   - Notifications with its count in the sidebar's top links, under Search; the user's
     button and its menu (Administration only for administrators; the
     control panel's "Server" section is renamed), Settings and Administration as
     pages with a section list (the control panel's cards move into them),
     and the Notifications page with its API: one list over what waits for
     the user, sortable, filterable, paged, with each item's actions.
   - **The thread's Files and Images panel**, as in DESIGN, with its API in
     `daemon/src/api.ts`. Everything goes through `Workspace` in a sandbox,
     so paths and symlinks can't leave the thread's folder and its grants:
     - list one folder at a time (grants can be large), search names (capped);
     - serve a file (the Images route), and a thumbnail made by the daemon
       and cached in the thread's folder under `.lyrica/thumbs/`, which the
       panel doesn't list;
     - upload to a folder, make a folder, rename, delete several, and
       download several as a zip streamed straight to the response, never
       written to disk;
     - read-only grants refuse every change;
     - a names-only note of files added or removed since her last turn,
       placed in her next turn.
     Tests: `..` and symlinks can't escape for upload, rename or delete; a
     read-only grant refuses changes; the zip leaves no temp file; a panel
     upload reaches her next turn as names only; another user's thread files
     are refused.
   - The thread view's message actions, mode picker, "+" switches, thinking
     control, pins and the removal confirmation come with the back-end briefs
     that add them (Modes, Child threads, Models 2).
1. **The Models page**, built from the revised mockup
   (https://claude.ai/artifact/U3xANiSAFje8cuinWpHo7V): Overview, Tasks
   (Private and General), Text models, Image models, Hosts and endpoints,
   Downloads, Clean up and Recent calls. It replaces the control panel's
   Endpoints and Model profiles sections.
   - Hosts and plain endpoints with live status: per-GPU VRAM bars, models,
     pause and resume, a dashboard link, and editable addresses.
   - **Add endpoint**, with the plain-HTTP warning.
   - **Add model host**: addresses, pairing code, then the paired
     fingerprint.
   - Tasks: a table of tasks against Private and General threads; each cell
     shows what answers now and opens a side panel with its ordered list
     (drag or arrows to reorder, add, remove) or **Same as** another task.
     Pickers offer only suitable models.
   - **Image models**, a tab of its own: recipes, and parts by type
     (checkpoints, diffusion models, text encoders, VAEs, LoRAs, unused
     files), filtered by architecture; each recipe opens to its copies and
     their parts, with Change within a slot (and Download another), Add a
     part (a LoRA with strength, or a VAE or encoder for a checkpoint),
     removing parts, a To review page for proposals (bulk Use, Download parts and Ignore, grouped by host, paged), missing
     parts to download, and Delete that says what it keeps; Download model
     with Starter recipes, Hugging Face, Link and Scan folder.
   - **Downloads**, a tab of its own with a count while anything runs:
     Download text model, Download image model, Accounts (hub tokens),
     progress with Cancel, finished downloads and deletions, Clear finished.
   - **Text models**: one row per model, opening to its copies with their raw
     names, where groups are made, reordered and undone; finetunes in rows of
     their own, linked to their base; flagged copies and **Not this model**;
     search, filters and stars; each copy's **Settings**: how it answers
     (with each value's source and a per-user override) and, on a model
     host, how it's served, with its placement and Reload now;
     **Download model** (host, source, repository lookup with file choice,
     the saved token for gated repositories, progress); **Delete** with a
     confirmation that lists where the copy is used; **Accounts** for hub
     tokens.
   - Clean up, as in the mockup.
   - Recent calls, with fallback notes.
   - A mode picker beside the message box (Ask, Accept edits, Auto, Plan;
     Shift+Tab cycles) and a "+" menu of switches (Web search, Internet for
     commands, Images), once the Modes brief lands.
   - A thinking control in the message box (Off, Low, Medium, High; only
     the current model's levels; hidden when it has none), and a note beside
     the model badge when a fallback couldn't think.
   - The thread's model badge shows which model actually answered, and when
     a fallback was used.
2. **The Sleep section** in the sidebar, as docs/sleep.md describes:
   - her **items** at the top: what she'd like to raise after a night, each
     with **Start a chat** and **Dismiss**, and a badge on the section while
     any are new;
   - for each run, per pool: its status (or why it was skipped), notes added,
     pages changed with a diff, questions, the dream and the WAKE, each
     linking into the memory browser;
   - **Sleep now**;
   - the per-user scheduled or manual setting, and the administrator's sleep
     time.
3. **Images.**
   - Inline images in messages, with a full-size view, and progress while
     one is made.
   - A **Portrait photos** page: upload, view and delete the photos, plus the
     Never, Ask once a day and Always setting, explained in plain words.
   - The ask-once-a-day prompt uses the existing permission prompt, worded
     for photos.
4. **Phones.** Every part is checked at 390×844 with Playwright, like the rest.

## Out of scope

- The back ends.
- The host's own dashboard (Model host thread).
- Voice (dictation, voice conversation, Read aloud): the mockup's buttons
  are placeholders, not built here.

## Done when

For each part:
- typecheck, tests, build and Playwright pass in CI;
- docs/web.md describes what exists;
- the PR shows a screenshot at desktop and at phone size.

## Handoff notes

(The thread fills this in if it stops before it's done.)

- 2026-10-11, PR 1 (look and shell): done: fonts, icon set, sidebar with
  Sort menu (sorts, groups, pool checkboxes), thread menu, Settings and
  Administration pages with section lists, header with version and build,
  home message box; back end for groups, unread, sort, version. Next, each
  as its own PR: Files & Images panel (needs the Workspace API for
  listing), Notifications page and Share with, Pin (after the Projects back
  end's pins), the speech Settings drawer into the Models area, the Models
  page, the Sleep section. Open: the mockup's Sleep and Models sidebar links
  come with their parts.
- 2026-10-11, PR 2 (Projects web part 1): the project chat, its cards and
  the Project settings page, per docs/briefs/projects-web.md. Next: the
  split-view panel settled with UI review (third column from 1180 px, 360 to
  520 px, 420 to start, dragged divider, width kept per browser; anything
  looked at without leaving a conversation opens in it: the project's
  Overview, Threads, Settings and Files, a thread from a card, a mention or
  the Threads popover; breadcrumbs, Expand and Close; Esc closes; below
  1180 px the same address is the full page), then the Files panel, the
  Watching threads switch and markers once #97 lands, Notifications, Pin
  in the remaining places, the Models page and the Sleep section.
- 2026-10-11, PR 3 (the panel): done as settled: the third column, the
  divider, breadcrumbs, Open as a page and Close panel, the address carrying the panel,
  the page on its own below 1180 px (docs/web.md "The panel"). The Files
  panel becomes this column when it comes; a project's Overview and Threads
  as pages wait for a design.
- 2026-10-11, PR 4 (Watching threads): the switch on Project settings and
  the "Checked the other threads" marker, after #97 and #110.
- 2026-10-11, PR 5 (Li's ask): messages from other threads collapse to one
  line, "Message received from <thread>", and expand on a tap; the rule is
  in docs/ux.md §6.
- 2026-10-11, PR 6 (Files panel, back end): `Workspace.files(t)` and the
  `…/files` routes (docs/daemon.md "Files"): listing one folder at a time
  with the roots, search, images, content with a no-run CSP, upload, folder,
  rename, delete, zip streamed from the sandbox, and the one-line note to her
  about what the panel changed. No thumbnails yet (the panel shows the image
  itself; a thumbnail route waits for an image library). Next: the panel
  itself.
- 2026-10-11, PR 7 (Files panel, the UI): `web/src/Files.tsx` and the
  `files` route and panel kind (docs/web.md "The Files panel", docs/ux.md
  §6; Show in thread finds the first message naming the path, on Li's ask).
  Not built: thumbnails.
- 2026-10-11, PR 8 (files in the conversation, Li's ask): `web/src/paths.tsx`;
  a `/workspace` path in a message links to `…/files/<encoded path>`, which
  shows the file; her images from the thread folder show in the message and
  open large (docs/web.md "Chat", docs/ux.md §6); her prompt says so.
- 2026-10-11, PR 9 (thumbnails, Li's pick): `ThreadFiles.thumb` runs
  ImageMagick inside the sandbox and keeps the copy under `.lyrica/thumbs`,
  gone with the image on delete or rename (Li's rule); `GET …/files/thumb`
  (docs/daemon.md "Files"); the Images grid and inline images use it and
  fall back to the image itself; `imagemagick` joins the NixOS sandbox tools
  and the Debian install. Not done: a grant-less sandbox for the thumbnail
  run (PR review's suggestion; `ThreadFiles` gets the thread's box) and a
  replaced-by-older image, which `-nt` misses. Next: Notifications, Pin in the remaining places,
  the Models page (carry the Fallback default), the Sleep section; Web:
  bootstrap on Li's go.
