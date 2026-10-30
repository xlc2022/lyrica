# Web UI

The browser interface to `lyricad`, in `web/`: React and TypeScript, built
with Vite into `web/dist`, which `lyricad` serves under its Content Security
Policy. It talks to the API in `daemon/src/api.ts` with `fetch` and one
`EventSource` per open thread plus one for the signed-in user, and imports
only its types (and `THREAD_TASKS`). It also imports `core/src/mentions.ts`, a pure function, to
render mention tokens.

## Pages

Routes are in the URL hash (`#/u/<user>/t/<pool>/<thread>`, `…/p/<pool>/<project>/<section>`
for a project's settings, `…/memory`, `…/notifications`, `…/settings/<section>`, `…/admin/<section>`,
`#/login`), so `lyricad` serves a single file. The old `…/panel` opens Settings.
A thread's address may carry what the panel beside it shows:
`…/t/<pool>/<thread>/panel/t/<pool>/<other>`, `…/panel/p/<pool>/<project>/<section>`
or `…/panel/t/<pool>/<project-thread>/threads`. A project's threads list is
`…/t/<pool>/<project-thread>/threads`: what the panel shows beside its chat from 1180 px up.

- **Unlock** while `lyricad` is locked, then **login**. A browser holds one
  person's users: the user menu at the foot of the sidebar opens Settings and
  Administration, switches between linked personas (separate users of the same
  person), logs in as another, and has **Lock** and **Log out** for the
  current user. Logging in as a
  user who isn't linked signs the browser's users out first, and a short
  notice says so without naming them. Logging out says when the user stays
  unlocked because another browser still holds them.
- **Sidebar:** the app's name links home, marks it as current
  there, and closes the phone drawer when pressed. New thread and New project:
  each row stays put and opens its General / Private choice in a row directly
  below it, as Search does with its field; clicking the row again or pressing
  Escape closes the choice, and opening one closes the other. Search (`src/Search.tsx`,
  "Search titles and messages": the list filters by title as it is typed;
  from 2 characters, 300 ms after the last key, `GET …/search` turns it
  into a group per thread in the order of their newest hit, the thread's
  row then up to three hits of up to two lines, each who wrote it and its
  time in mono (as a message shows it: HH:MM today, "11 Oct 14:32"
  otherwise, the full date as its tooltip) with the sentence and its
  matches marked, and "<n> more in this thread" to
  open the rest in place; after the groups, the threads whose title alone
  matched; **Show more** under a full page of 50; "Nothing matches." when
  nothing does; Escape clears it. Going to any page that isn't a
  conversation — another section, or another page within the same area — closes
  the field and clears its query, as navigating already closes the phone
  drawer, so that page's list is the list again; while a conversation is the
  page they stay (its hits, another thread, what opens beside it), since you
  are still choosing among them. A hit opens its thread at that message,
  loading older messages as needed, and marks it a moment, as the Pinned
  popover does; only the thread and the message number wait in session
  storage for a thread not yet open), **Notifications** with the count of decisions waiting (read with
  the thread list, groups, Me/display settings, Sleep and the Models area
  (its page, the text library and an open copy's settings, through
  `ShellContext.changed`; the Notifications page and the welcome page's
  Notifications card read their lists again the same way, so an item acted on
  elsewhere, such as a sleep item dismissed on the From sleep card, leaves them too; an open copy's serving fields take the new values
  unless the user has edited them, so Save never puts old ones back) on the user stream's `hello` and `changed`
  events, and on focus; the stream reconnects automatically,
  with a fresh connection after a terminal HTTP error), Memory, the Sort menu, the thread list, the **status panel** (`src/SideStatus.tsx`: above the user row, its own divider line; up to two most-used local endpoints side by side and up to two cloud ones on their own lines — each a dot and name (docs/ux.md §5), a short state word when it isn't simply online ("Blackwell · paused") or else, for an endpoint serving a text model, its recent output speed ("· 42 tok/s", nothing with none; prompt speed and turn count, or "no turns in the past day", in the tooltip, from `endpointUses`), plus "· checked 20 s ago" in mono for the cloud ones, ticking as time passes; each item's tooltip holds the whole line; ranked by `GET …/models/page`'s `endpointUses` counts; nothing is drawn with no endpoints), and the user. The **Sort
  menu** ("Sort: By date ▾") has the sorts By date (sections Today, Yesterday,
  Previous 7 days, Previous 30 days, Older), Last activity, Start date, Title and My groups (one
  section per group with its count, then Not in a group, and a New group
  form), then the General, Private and Hidden checkboxes (Hidden's tooltip:
  "Hidden threads are left out of the list and of search."), then All threads,
  Only projects or No projects. The sort, the checkboxes and the projects
  choice are saved per user (`Display`). Pinned threads come first under a
  **Pinned** eyebrow, whatever the sort. A thread unread for this user
  is bold; private threads carry a small lock in the private colour; a
  thread at work (`busy`, or a project thread's `working` state) pulses its
  pool dot or lock, steady under reduced motion; child
  threads (Lyrica's, branches, forks, copies) sit behind `›`, a child
  showing when it works or waits and a count of its unseen updates (at most
  two badges a row: waiting, then the count, then hidden).
- **Projects in the sidebar:** a project row has the project icon in the
  pool dot's place (amber-dotted when one of its threads waits on the user)
  and its threads nested under it, open by default, each with its pool dot,
  its state as a word (Working, Waiting on you, Waiting for approval,
  Queued, Blocked, Idle; Blocked's tooltip reads "Blocked until it agrees
  with <thread> on who changes <file>.") and its unseen count, the ones pinned from their cards
  first; resolved ones fold under a **Resolved** row with their count. The
  list's own menu (right-click or a long press on its empty space) has
  **New project** (General or Private: an empty, pinned project chat) and
  **New group…**.
- **Thread menu** (`src/ThreadMenu.tsx`): right-click a thread, or hold it
  for half a second on a touch screen. **Open beside** (B) first, on a child
  row where the sidebar passes it (from 1180 px up with a thread open): it opens
  the child in the panel beside the open thread; Shift+click or Shift+Enter on
  the row does the same, and below 1180 px Shift+click navigates itself. Mark as unread or read (U), Rename…
  (R, inline), **Share with** (S: the other users on this server, from
  `GET …/people`, linked personas marked; picking one confirms in a dialog
  that says the copy is as it is now, that later messages and memories
  don't go, and that the thread is private when it is; `POST …/share`;
  not on a project chat or a subagent's thread; a private thread's
  notification offers Add to Private only), Move to group (M: the groups, Not in a group, New group… N),
  **Pin** or **Unpin** (P, top-level threads; a toast says "Pinned to the
  top" or "Unpinned", the shell's one, gone after 4 s), **Make project…** (K, a
  top-level thread; confirms in a dialog, since there is no way back),
  **Continue as project** (C, keeps the source), and **Move to project**
  (top-level, non-project, non-subagent threads only): pinned then up to ten recent
  visible projects of the same pool, local-only destinations only for
  local-only work; omitted when none qualify. It reuses the hover flyout
  and phone submenu. Picking a project opens the shared `FoldConfirm.tsx`
  dialog used by FoldCard, listing children, losses and the one-way warning;
  Cancel leaves the work in place, Fold in calls the existing fold route
  and opens the project chat. Its unticked access box grants permissions
  through settings before folding. Losing cloud models is listed as
  "Cloud models" and cannot be restored by that box.
  **Resolve** or **Reopen** (E, a project's thread), Hide or Unhide (H), and
  Delete… (D), which confirms in a dialog and offers
  to delete child threads too. From the keyboard, Shift+F10 or the Menu key
  on a focused thread opens it under the row; the arrows move between items
  and Escape closes it. The thread header's ⋯ (Thread actions) opens the
  same menu under it, and pressing it again closes it; in the panel,
  Delete closes the panel. A project's thread also has a **Resolve** toggle
  in its header before the ⋯: a press resolves it (`POST …/resolve`); while
  resolved it stays, filled in the ok color, reads **Resolved** with the
  tooltip "Reopen", and a second press reopens it (`POST …/reopen`). The user menu works the same way. Groups and unread marks are
  the user's own (`thread_groups`, `thread_prefs` in `user.db`); opening a
  thread clears its unread mark.
- **Hidden pools:** with Show general or Show private off, a thread or
  memory from that pool shows "General is hidden" or "Private is hidden"
  instead, and memory search leaves the pool out.
- **Renaming in place** (`InlineRename` in `src/ui.tsx`): a double-click on
  a thread's or project's title, in its sidebar row or the thread header's
  h1, swaps the title for a field in the same place with the title
  selected; Enter or blur saves through `PATCH …/threads/:pool/:id`
  (`{ title }`) and reloads the list, Escape or an unchanged name puts the
  title back. Clicks inside the field never reach the row's link.
- **Thread:** a header with the title; under it the pool word, the model
  badge (cloud or local, model and endpoint; it opens the model picker,
  whose search box matches every word against model, endpoint and kind,
  `matchesModel` in `ModelLabel.tsx`), the
  thread's group as a link that changes it, the folders as words with the
  paths in their tooltip, and the granted machines', repositories' and MCP
  servers' names in mono; at the right Files, Settings and ⋯, which opens
  the thread menu. Below it the conversation and the composer.
  After the group, **Context** and the percent (`src/ContextMeter.tsx`)
  open a popover of the parts, the reserve and what's free, when measured,
  and the last turn's speed. It reads `ThreadSettings.context` and then each
  `context` stream event, so it follows every turn without a reload. After
  a rewind or a reset it is hidden until the next turn measures again.
  Then, while the thread has a checklist (her `threads steps`),
  **Checklist** and "2 of 5", its numbers in mono (`src/Checklist.tsx`),
  open a popover (full width under the header on a phone) listing the steps
  in order, each a mark in mono (✓ done, ✱ doing, ○ to do; hidden from
  screen readers, which read Done, Doing or To do) and its
  text, done ones muted and the doing mark in the accent; no heading, no
  buttons. It reads the stream's `steps` event (`live.steps`) once one
  came, else `ThreadSummary.steps`, so a new list redraws the fact and
  the open popover in place; with Checklists off it shows none, a list
  already streamed included. Her call itself is a tool marker.
  **Tokens** follows Checklist once a counted turn exists (`src/Usage.tsx`,
  `GET …/usage`, reloaded after turns and child updates). Its mono count and
  caret open model rows with muted local/cloud kind, mono **Input**, **Output**
  and **Total** tokens, **Cached** (the cache's share of input, `cacheHit`, or a muted “—”) and local **GPU time**, then Total; Input's header tooltip says “Counts every request, cached reads included.” and Total's
  “Tokens counted before input and output were kept apart count here alone.”
  On a phone it opens rows in place at the foot of Context.
  Then, while she has wake-ups waiting (`ThreadSettings.wakeups`, soonest
  first), **Wake-up** and the soonest time in mono (`wakeTime`: HH:MM today,
  the date before it otherwise) open a popover with each one's time and an
  ✕ (Remove, `DELETE …/wakeups/:id`), never her note. Each `wakeups` stream
  event replaces the list, so one set, removed or fired shows at once; the
  fact goes when none is left.
  **Changes** (`src/Changes.tsx`, docs/ux.md §6 "A thread's branch and pull
  request"): after the folder, machine, repository and MCP badges, one badge
  per checkout from `GET …/changes` (docs/daemon.md "Changes"), fetched when
  the thread opens and again when `ShellContext.activity` moves (a finished
  tool call or turn); a 409 (a locked home, an SSH machine) shows nothing.
  It opens `ChangesView`, a `dialog` like the file viewer: `…/changes/commit`
  for one commit's files, `…/changes/file` for each file's two sides, which
  `diff.ts` compares in the browser (Myers over the lines, the middle shown
  as replaced past 2,000 edits; a change's line pairs get `wordDiff`'s marks;
  unchanged stretches fold past three lines of context and open twenty at a
  time). **Unified | Side by side** is kept in `localStorage`
  (`lyrica.changes.view`); below 1180 px it is unified. Nothing of it is
  stored or logged: the texts come to this browser and go nowhere else.
  **Routine** (`src/Routines.tsx`, `ThreadSettings.routines`) opens the
  same style of popover listing schedules, next times in mono, Pause or
  Resume and Remove, never notes. Its fact shows the earliest active next
  time, or Paused when all are paused, and disappears when none remain.
  Web Pause, Resume and Remove reload settings and publish the existing
  `settings` event to the source thread; finished turns and focus refresh
  routines too.
- **Project chat** (`src/Project.tsx`): the facts line adds **Threads** with
  the count. From 1180 px up it is a toggle (`aria-pressed`, pressed look while
  shown) for the panel beside the chat showing the project's threads list
  (`{page:"threads"}`: `ThreadsPage`, the same groups as the popover below, each row
  its state word and its time in mono); below it a popover of the project's
  threads grouped Waiting on
  you, Working, Queued, Blocked, Idle and Resolved (each a link, with its unseen
  count). Each row carries the thread's **chips** (`ThreadChips`, root `.tchips`, docs/ux.md
  §6 "A project's threads at a glance"), plain spans inside the row's link:
  its checklist's count from `ThreadSummary.steps`, its open pull request
  from `ThreadSummary.pull` (the number, **Draft** muted while
  `OpenPull.draft`, and the checks' dot as the changes badge colours it,
  with the checks in a word for screen readers), and `ThreadSummary.subagents`, the subagents working
  for it now; a chip without anything to say is left out. In the popover, and where the
  panel's list is under 520 px wide (container `tlist`), the chips wrap onto
  a second line under the title. The facts line also carries **Tokens** for the whole project. Its rows add **By thread**,
  This chat first, then thread links by descending tokens, and **Recent
  calls** linking to the project's filter. On a phone Tokens opens in place
  at the foot of the Threads popover. The header has a **Project**
  button before Files and the Settings button (which opens the thread's
  drawer as in any thread): from 1180 px up it toggles the project's
  overview beside the chat, the same `ThreadsPage` the Threads fact shows,
  pressed while it shows (`aria-pressed`); below 1180 px it opens that
  page. The overview's header holds one link, **Project settings**, to the
  project settings page (one crumb deeper in the panel). The
  `child` stream event reloads the overview (`GET …/overview`) and the
  thread list, so cards and state words follow. A resolved project thread
  has a **Reopen** link where its message box was.
- **The panel** (`Shell.tsx`, docs/ux.md §6): from 1180 px up, a link in a
  conversation to a thread or a project's settings (a thread card or its
  **View thread**, a mention, the Threads fact, the header's Project button) opens it in a third column
  instead of navigating, and the address gains `/panel/<its path>`; so do
  **Open beside** (B) in a child row's sidebar menu and Shift+click or
  Shift+Enter on such a row (`showInPanel`, with the breadcrumb starting
  there). With the open thread the row's parent (`ThreadLink`'s
  `besideOnClick`: the project chat, or the thread the child was started
  from), a plain click on a child row opens it beside too, replacing what
  the panel shows. The sidebar's other rows navigate as before, and so does any other
  modified click. The row of the thread in the panel carries `data-beside`,
  drawn as a thin box without the open row's fill. The column
  is 280 to 1000 px (420 to start), dragged on its divider (a `separator`
  that the arrow keys move too), the width kept in `localStorage`
  (`lyrica.panel-width`); the grid holds it short of leaving the
  conversation under 48ch, and a conversation under 600 px wraps its
  header as on a phone. A link inside the panel replaces what it shows and
  the breadcrumb above its title grows (each crumb goes back to that page);
  a link to the conversation's own thread closes the panel (the Thread
  settings link opens the drawer). The page in the panel is the same
  component as on its own, rooted in a block instead of `main`, and its
  header gains **Open as a page** (a link to the page's own address) and **Close panel**; Esc closes
  it, and focus lands on its heading each time it shows something else. Open as a page remembers the
  conversation it left (in `sessionStorage`, `lyrica.beside`), so that page's header shows **Open in
  panel** instead, from 1180 px up, a link back to the conversation with the page in its panel as it
  is now (its drawer, file or section); Esc follows it too. Opening any other page forgets it. The
  panel is `role="complementary"` named by its breadcrumb. Below 1180 px the
  same address shows the panel's page on its own.
- **The Files panel** (`Files.tsx`, docs/ux.md §6): **Files** in a thread's
  header is a link to `…/t/<pool>/<thread>/files`, which the split view opens
  in the panel column (and the same link closes it); below 1180 px, or on a
  phone, it is the page. `…/files/<encoded path>` opens with that file shown
  and its folders open (a folder: opened), or says it wasn't found. A path in the thread folder
  that isn't there, as a relative link resolves, is looked for at the same place under `/shared`, then
  under each grant, first. Files lists one folder at a time from
  `GET …/files?dir=` (docs/daemon.md "Files"), the thread folder open at the
  start, then `/shared` for a thread with a folder of its own, such as a code thread (shown as Shared folder), then each grant; a search runs under every root; a file,
  an image from Images (`…/files/images`, filtered by source), or a clip from
  Videos (`…/files/videos`, the same filter, each tile its poster thumbnail or,
  for a clip without one, its own first frame), opens in
  the **file viewer** (below). The right-click menu (a long press, or the
  viewer's ⋯, which renders the same menu inside the viewer's dialog) attaches
  (the path goes into this thread's message box through a window event, or
  waits in session storage when the page has no box), selects, shows in the
  thread (the conversation scrolls to the first message naming the path, an
  upload or her call that wrote it, through the same channel), downloads (one file by its address, several as `…/files/zip`), copies
  paths, renames and deletes (a confirm dialog), uploads and makes folders;
  dropping files on the panel uploads them to the folder last opened. After a
  change the folders it touched are reloaded. A row in a writable folder
  has **Rename** and **Delete** icon buttons at its right (`.frow-acts`,
  shown on hover or focus-within, always where nothing can hover): Rename
  edits the name in place (`InlineRename`), Delete opens the menu straight
  at its confirm (`MenuAt.sub`). The tree follows the thread: the shell
  counts each open thread's finished tool calls and turns
  (`ShellContext.activity`, from the stream's `tool_end` and `turn_end`),
  and the panel reloads every folder it has listed when that count moves,
  and again when the window regains focus (the page on its own, below
  1180 px, has no stream and relies on focus). The grid shows each image's
  thumbnail (`…/files/thumb`, docs/daemon.md "Files"), or the image itself
  where the server makes none.
  The image tool also supplies `ImagePart` path/model/tier metadata on
  messages and `tool_end.image`, and an owner-only `…/file?path=` route.
  Messages render that part inline as described below. Settings manages
  portraits separately from the Files panel.
- **The file viewer** (`Viewer.tsx`, docs/ux.md §6): a modal dialog almost
  the window's size (the whole screen on a phone) holding the file large and,
  from 1180 px up, the thread whose library it is beside it (a `Thread`
  inside a `PanelFrame`, so its header carries Open as a page, then the
  viewer's Close at the far right, taken from the file's header while the
  thread shows beside it; below 1180 px Close panel in its place, which goes
  back to the file). That thread is
  the one that wrote the file (the entry's `madeBy`) when it is recorded and
  still in the list; otherwise the Files panel's own thread for a file in its
  thread folder, and the project chat for a file in Project settings → Files
  and images. A file in a grant has none and shows on its own. Below
  1180 px the **Thread** toggle (a labelled button, pressed while the thread
  shows) switches between the two; from 1180 px up it shows or hides the
  thread. The header names the file (mono), its facts
  (kind, size, time) and **Preview | Source** for HTML, SVG and Markdown.
  What it shows depends on the name: HTML in an `iframe` of
  `…/files/view` with `sandbox="allow-scripts allow-popups"`, its console
  messages (posted by the route's bridge, taken only from that frame's
  window, at most 200, shown as text) in a **Console** section under it;
  with the thread's internet off (its settings' `network.internet`) the
  route runs nothing, and a muted line above the page says "Scripts don't
  run here: this thread's internet is off.";
  SVG as an `img` of `…/files/view`; a PDF in an `iframe` of
  `…/files/view` (the browser's own viewer); images, audio and video from
  `…/files/content` in their own elements; Markdown rendered by `Prose`
  (raw HTML skipped); other names by the type `…/files/content` answers,
  text up to 512 KB as text and anything else with Download. An image or
  SVG opened among others (the caller's `list`: the Files panel's folder,
  its search hits or its Images grid, as filtered; Project settings' folder
  shown or its Images grid) steps through the images and SVGs of that list
  with **Previous image** and **Next image**, round 44 px buttons on its
  sides, and with Left and Right, except in a field, a menu or the thread
  beside. It stops at the ends, where that button is disabled, and the
  facts read "Image 2 of 4". Escape closes
  a menu inside first, then the viewer, and so does any navigation.
- **The changes view** (`Changes.tsx`): the same kind of dialog for a
  thread's branch, described under Chat ("Changes").
- **Project settings page** (`…/p/<pool>/<project>/general`, `/memory` or `/files`),
  sections at the left. **General**: Goal, the Paused and **Watching
  threads** switches (`watchThreads`; the tooltip says what a look does), **New
  threads** (Model, Code mode, Thinking and Fallback the project's threads start with;
  "Same as coordinator" is the project's coordinating chat, which this page can be
  opened away from; Model becomes a new thread's
  Coding in Code mode and its Main conversation otherwise), **Workspace**
  (Group, then **Folders**, **Machines**, **Repositories** and **MCP
  servers**, the drawer's own controls,
  then a **Thread settings** link that opens the project chat with its
  drawer showing, `…/t/<pool>/<thread>/settings`, for its own models, network
  and local-only; the chat's model and Mode are not on this page), then **Commands**: a mono prefix field per
  rule, an Allow | Ask | Forbid segment, Remove, and **Add rule**. Empty
  reads "No rules: commands ask as the mode says." Empty rows are ignored and dropped on Save, and duplicate prefixes (spaces collapsed) fail validation.
  Then **Checks**: a mono command field per check, Remove, and **Add check**
  (at most 8). Empty reads "No checks: <name> runs what the repository asks.";
  a multi-line or over-long check fails validation. The page has one Save, which patches the thread
  (`goal`, `paused`, `commandRules`, `checks`, `watchThreads` when it changed, `threadsModel`,
  `threadsThinking`, `threadsFallback`, `group`) and, when they changed, its
  settings (`grants`, `machines`, `repositories`, `mcpServers`); `lyricad`'s
  reason shows when it refuses. Every thread the project starts gets these
  folders, machines and repositories or fewer. A folder, machine or
  repository taken off here leaves the
  project's running threads at once, and their open views show it gone. **Memory**: the
  Instructions kept on the project page (2,000 characters, counted under
  the box), and a link to that page in the memory browser. **Files and images**
  (`ProjectFiles.tsx`): the project folder (the project chat's `/workspace`)
  through the Files panel's routes on the project chat, one folder at a time
  with crumbs, Files | Images | Videos, Upload… (to the folder shown, or by dropping
  files on the section), New folder, and per row Open (a folder in the list,
  a file in the file viewer with the project chat beside it) and a ⋯: Download, Rename… in place, Move
  to… (a drawer listing up to 500 folders, found folder by folder; `rename`
  moves) and Delete… with its dialog. Images is the panel's grid with its
  filter, a tile opening the image in the file viewer; Videos is the same for clips. It reloads when any thread finishes a tool call or a turn, and on
  focus.
- **Thread settings drawer:** Models has the preset, **Conversation** (the
  `code` task in Code mode, else `chat`, as `ModelBadge`), **Thinking**
  (`thinking`, Default while `thinkingSet` is false), Fallback, then the
  nested groups **Helpers** (subagents, Titles, and **Watching threads** only in
  a project chat) and **Images and speech** (**Images**, **Image edits** and
  **Image upscaling**, offering the models that do each, recipes by name;
  **Videos**, offering host recipes that make any kind of clip;
  Dictation, Read aloud). Each option says cloud or local first, and each
  model select's label shows `TaskModel.fallbacks` as "+N fallbacks" or "no
  fallback" (its description, not its name);
  a task's problem shows in red under its select only for the thread's own
  model, a choice made in the thread, or a refusal, never for an optional
  task nobody set), local-only, the internet and
  Local services (localhost) switches (each following the user's default until
  changed), allowed hosts, folders from the allowed paths (read-only or
  read-write), **Machines** (the sandbox, always, then each granted machine
  in mono with its limit and an ✕ to take it off, a machine that no longer
  exists included; **+** (Add machine) opens a search of the pool's other
  machines by name or address, Enter picks the first), **Repositories**
  (each `owner/name` in mono with its account muted and an ✕; **+** (Add
  repository) opens a search, "Search, or paste a URL", of what each Git
  account of the thread's pool can see, grouped by account, a pasted URL
  under each account on its host, with a **Git accounts** link at its
  foot; a change applies at once), **MCP servers** (each name in mono, its host muted, with
  an ✕; **+ Add server** opens a search of the pool's other servers, "No
  general MCP server yet" when there's none, with an **MCP servers** link at
  its foot; a change applies at once), the mode, the
  **Code mode** (Behaviour, saved at once), Web search and Images switches, the Claude Code switch (only where
  `claudeCodeOffered`, or while on), "Do not log", rename and hide (deleting is the thread menu's Delete…). `lyricad` validates every
  change and its reason is shown. Code mode selects the Coding model in the
  header and its picker; turning it off restores Chat. Its tooltip says
  "Focus on the code: a coding model, a short persona, and only this
  project's memory and your working preferences." Project settings →
  General → New threads has the same switch, applied with Save. Models →
  Tasks has a Coding row under Conversation, initially Same as Strong
  subagents, editable in presets and columns like the other tasks.
- **Subagents live inline**, not in the sidebar: see the `delegate` card
  under Chat. Opening a subagent's thread by link shows the same thing as
  its card: a link to its parent, its transcript and a message box, never
  the composer or settings.
- **Subagents drawer** (`src/Subagents.tsx`): once a thread has delegated,
  its header shows **Subagents** with the count after Files. It opens a
  drawer (one drawer at a time: it and Thread settings close each other)
  from `GET …/subagents`, reloaded as a run starts, works or ends: a facts
  line ("3 subagents · 1 working · 38k tokens"), then a row per run, those
  working or asking first and otherwise newest first. A row is the link to
  the subagent's thread (beside, from 1180 px up) and closes the drawer: its role
  and title ("Coder – Fix the pool scripts", from the run's `title`), its state as a dot and a word (Working,
  Asking, Done, Failed, Stopped, Interrupted), its task on one line (unless the title is only its start) when
  its `delegate` card is loaded (`delegateTasks` in `src/Messages.tsx`),
  then the model's short name, start time and tokens in mono.
- **Memory** (`src/Memory.tsx`, `src/memory.ts`; [memory.md](memory.md), The
  memory browser): a notebook. The browse pane lists one layer (Pages, Notes,
  WAKE, Journal) newest first (Journal previews one entry with Show all
  beside its History eyebrow), filtered by pool and User introduced, with
  tags for notes; a search replaces the list. A memory without a title is
  named by its first words (`firstWords`), with citations and Markdown's
  marks taken off. The memory at the right shows
  its citations as titles with a hover preview (`linkCitations` turns each
  citation into a link whose word comes from `MemoryDetail.links`, its title's
  mention tokens rendered first by `readableLinks`; the raw ID is never shown), Came from and Used in with the citing sentence. Each
  previews four cards; a right-aligned Show all link expands longer lists
  in place with their own scroll (maximum height 320 px), becoming Show less.
  Either expansion hides History; Came from expansion also hides Used in.
  The memory and earlier sections stay visible; collapsing restores the
  hidden sections. History shows
  the newest earlier version open, with **Show all** at the right of its eyebrow.
  `…/history/memory/<pool>/<id>` lists versions newest first, with
  word differences (`wordDiff`, computed in the browser) and Restore, and
  Edit in place with a `[[` popover of pages and people (a page shows as
  `[[Title]]` and saves as `[p:<slug>]`; the title, summary and text show
  users as `[[Name]]` and save them as tokens). Archive, Delete, Export and Forget… on a
  selection, and Add a memory with a Write | Import segment (export and
  import in [memory.md](memory.md#export-and-import); the downloaded file
  is made from the response in the browser and kept nowhere else). The **Recent** layer (`kinds=entry`) lists
  the logged messages written since sleep last consolidated
  (`PoolStore.recentEntries`), newest first and paged by `before`; one
  opens as a memory of kind `entry` (`GET …/memory/<pool>/e:…`), read-only
  (no Edit or ⋯; the API answers 405 to a change), with its thread under
  Came from. `…/memory/<pool>/<id>` is a memory on the
  page; `…/t/<pool>/<thread>/panel/memory/<pool>/<id>` is the same memory in
  the panel beside a conversation, where recall markers and citations open
  it (a recall marker's `e:` entry opens the message as a memory,
  `recalledHref`; a citation of a message in her prose opens its thread,
  `idHref`); the panel is named Memory, and a memory followed from it adds its title
  to the breadcrumbs. The lineage names the memory being read as itself, never
  as gone. Mention tokens show as current names; the editor shows them as
  `[[Name]]` or `[[Name:obj]]` and saves them back as tokens. Nothing of a
  memory's text is kept in the browser's storage.
- **Sleep** (`src/Sleep.tsx`; [sleep.md](sleep.md) "Sleep in the UI";
  docs/ux.md §6 "What she did at night"): `#/u/<user>/sleep`, from the
  sidebar's Sleep link, whose badge counts her new items (`GET …/sleep`,
  reread on user-stream events, on focus and after each action; while the page is open
  `GET …/sleep/events` reloads it as a run starts, changes phase or ends,
  and a `thread` event opens the thread a manual run leaves). Items first,
  newest first, with **Start a chat** (`POST …/items/<id>/chat`, then the
  new thread) and **Dismiss** (`DELETE`). Then **History** shows only the newest visible run,
  read at once for its summary line, with **Show all** right-aligned beside
  the eyebrow. `…/history/sleep` lists all runs newest first and reads a run
  when its row opens
  (`GET …/runs/<id>`). A row shows Notes, Pages with their word diff, Questions,
  Thoughts, the Dream and the WAKE, each linking to the Memory page at that
  memory (`…/memory/<pool>/<id>`; a `t:` or `e:` source links to its thread);
  a skipped run is one line and does not open. **Sleep now** ▾ picks the
  pool (`POST …/sleep/<pool>`); a `confirm` answer becomes a dialog whose
  **Sleep now** resends with `confirm: true`; a 409 is shown as a toast in
  `lyricad`'s words. Text arrives in stored form and is shown with the users of
  the runs already read; an unknown mention reads "someone". The foot names
  the schedule and links **change** to Settings → Sleep, where the
  **Sleep** select (Nightly at the server's time, or Only when I ask) sits
  above Sleep fallback and saves at once (`PUT …/sleep/mode`). A pool hidden in
  the Sort menu is left out: its items, runs and **Sleep now** choice, with the
  same "<Pool> is hidden. Turn on <Pool> in the Sort menu to see it." line as
  Memory, and the sidebar badge counts only the pools shown.
- **Models** (`src/Models.tsx`, its frame and what the tabs share in
  `src/ModelsFrame.tsx`; [models.md](models.md); docs/ux.md §6
  "Models, hosts, downloads, clean-up"): `#/u/<user>/models[/<tab>]`, from
  the sidebar's Models link, whose badge counts Clean up's items
  (`GET …/models/cleanup`, reread with `…/models/page` in the shell's tick,
  every 30 s and on focus). Tabs down the left (a scrolling row
  on a phone): **Overview**, **Tasks**, **Text models**, **Image models**,
  **Hosts and endpoints**, **Downloads**, **Clean up** and **Recent calls**.
  The shell reads `GET …/models/page` app-wide (on load, every
  30 s and on focus) so the sidebar's status panel shows everywhere; Models
  and Home read it from the shell rather than fetching their own. It probes
  each endpoint (3 s each, one seen down in the last 30 s not asked again). Overview: a banner for a paused host or a stale
  endpoint; tiles Endpoints (n of m up, then a dot and "All reachable" or
  the first one down, "+N" for more), Backend (the first `chat` model of
  the General and Private columns, following their presets and Same as,
  each with its pool and preset beneath; links to Tasks) and Clean up (the count, the tile's
  tooltip "To decide" or "Nothing to clean up"); then the hosts and
  endpoints summary (a host with its combined VRAM bar, Pause or Resume,
  and Dashboard as a link; a plain endpoint with its model count) and the newest visible
  call under **History**, with **Show all** beside the eyebrow. Hosts and endpoints: **Add endpoint** (a drawer: Name, Kind, Base
  URL, API key, Shared for administrators; a plain-HTTP warning for a local URL off
  loopback and the tailnet. Kind also offers ChatGPT plan, with **Sign in with
  ChatGPT**, which opens OpenAI's page in a new tab, then **Redirect URL**
  and **Finish** in place of the URL and key; and Grok plan, with **Sign in with Grok**, which opens
  xAI's page, then its **Code** and **Finish**; closing the drawer cancels
  the sign-in) and **Add model host** (the one primary; a page
  at `…/models/hosts/add-host`: Name, Addresses, Pairing code, Shared,
  **Pair**, then the fingerprint in mono; with `?host=<id>`, **Pair again…**
  for that host: "Pair <host> again", only the Pairing code, `POST …/pair`). A
  host card: name (its ID as the tooltip), state (Online, Paused, Pausing,
  Restarting, Unreachable with the duration, Moving, Updating, or Unpaired
  when the host has revoked this server), an "update available" pill while
  it runs another commit than Lyrica's release, then Pause or Resume
  (administrators on a shared host; disabled with "Nothing is loaded"), or
  **Pair again…** in its place while Unpaired, **Edit** and the ⋯ (Update
  while an update is available, `POST …/update`; Read its models; Pair
  again…; the endpoint actions). One facts line: the first address and "+n",
  "version" and the version, for its managers "models folder", its path and
  free space, shared or only you, "N models" opening its model list (a
  speaking model's **Settings** there, and for its managers a missing or
  gone model's **Remove**, `DELETE …/offerings/:id` after a confirm dialog) and **Dashboard** (a link, `GET
  …/dashboard`, a new tab). **Edit** opens the host's drawer: Name (`PATCH
  …/endpoints/:id`), Addresses (`PUT …/addresses`) and Models folder (`POST
  …/models-folder` after a confirm dialog, enabled only when the host's
  updater can move it) and, on a host that reports `systemRam`, **System
  RAM** (GB "of <most>", empty is off, clamped; `PUT /host/v1/memory`
  through …/manage), one Save. The state Updating while
  it updates, with Pause disabled, a warn line after a failed update, per GPU its card and PCI ID (`10de:1df4`), used/total in mono,
  a bar of pinned, loaded-on-demand and vLLM-share segments, the loaded
  models and the queue when nonzero; `CpuBlock`, on a host that reports
  `machine`: "CPU · <name>" and "<c> cores · <t> threads · <n> GB RAM",
  no bar; then, while the host has an
  allowance, `RamBlock`: System RAM, used/allowance in mono, a bar of
  in-system-RAM segments, each spilled model with its GB, and a foot
  "llama.cpp · Edit" (the legend gains In system
  RAM). A plain endpoint row: name, kind,
  ChatGPT plan or Grok plan versus API key, and cloud Text, Vision and Image
  pills (only when a marked image model has a callable provider and the
  required key). Capability pills wrap under the name on a phone. Facts:
  a plan's kind, only you and explicit account label in mono if supplied,
  hiding its placeholder URL; a keyed endpoint's URL, masked key suffix in
  mono, shared or only you and ID. Short keys show the mask alone. Local rows
  keep unencrypted and stale pills. State, "N models", **Edit** (the same
  drawer; API key "leave blank to keep",
  Remove key; a plan's drawer has Name only). Add endpoint suggests ChatGPT
  for that plan and OpenAI for api.openai.com without replacing a name the
  user typed. Names preserve capitals. A plan whose sign-in lapsed
  reads **Signed out**. Each row's ⋯: Sign in again (plans), Read its models, Add a model by hand, Pair
  again… (hosts), Reset IDs…, Merge into… (same kind and sharing), Remove,
  the last three confirmed by a dialog. Clean up: a row per item with a
  stale, gone or empty pill, "Unreachable for N days." / "Missing for N
  days." / "No members left.", where it is used or "Nothing uses it.",
  **Replace with <model · endpoint>** when the server suggests one and
  **Remove**; the notice lines as a dashed note with Dismiss. The
  thresholds are the pills' tooltips (stale: unreachable 14 days or more;
  gone: missing 30 days or more), and Replace with… carries the redirect
  sentence as its tooltip. Recent calls opens **Call history**, using shared search and numbered paging, and has a **Project** select in its
  header: **All projects**, then title-sorted projects grouped General and
  Private, hidden pools omitted. Its hash address retains `?project=&pool=&q=&page=`
  and `GET …/models/calls/history` applies both filters. The project list comes from
  `threads?all=1`, with display visibility applied here, so the sidebar
  project filter does not remove choices. Recent calls: Time (mono), Thread (a link; private
  kind mark; "a forgotten thread" when gone), Task, Answered by ("model ·
  endpoint"), Note (the fallback or note, warn text); hidden pools left
  out; the table stacks on a phone. Tasks (`GET …/presets`) has two columns, **Private threads** and
  **General threads**, with a **Preset** menu in each head, and the
  header's **Free models only** switch (`PresetsChange.freeOnly`). Local is private;
  Cloud is general; named presets follow their scope. The menu holds Search
  presets, the available presets with Edit beside user presets, Save to and
  Save as preset… while Custom, then New preset…. Picking a preset sends
  `PUT …/columns/:column`; editing a task copies its lists to Custom without
  changing the preset. Preset creation and renaming use the drawer, and
  Delete preset… confirms in a dialog.
  Rows group Conversation, Memory, Sleep, Images and Speech. A cell shows
  the first model's state, +N fallbacks or no fallback, or = Chat for a
  shared task. Dictation has a Private cell only. The drawer names the
  column and preset, with **Its own list** or **Same as**, **Task to share
  with**, ordered models with Move up, Move down and Remove, and **Add…**.
  General lists mark where fallback crosses local/cloud; Private offers
  local models only. Changes send `PUT …/columns/:column/:task` at once.
  The model picker, Tasks entries, Text models copies and Image models show
  a muted endpoint name after each model, truncating the endpoint first.
  `ModelLabel.tsx` shares that display. A model shows by `shortModel`: a
  local model's ID is often its file's path, so the file's name without its
  extension ("Qwen3.8-27B-UD-Q4_K_M"), with the whole ID as the tooltip; the
  thread header's chip, a reply's header line, the Backend card and the
  thread drawer's selects (the select's tooltip holds the chosen model's
  whole ID) all use it.
  Settings → Sleep holds Sleep mode and Sleep fallback;
  `…/settings/profiles` remains a redirect to Tasks.
  Text models (`src/TextModels.tsx`, its pure parts in `src/library.ts`)
  reads the whole library (`GET …/library/text`, 200 a request) and filters
  in the page, so the facts line ("<n> models · <c> copies on <e> endpoints
  · <g> groups · <s> starred"), the search (name, raw name or label) and the
  chips (Any endpoint or one; Local, Cloud, Vision, Starred) see every
  model; 40 rows at a time with Show more. An info banner names the models
  whose copies are the same file on several hosts (the strong `GET
  …/groups/suggestions`), each a link that opens its row. A row: **Star** or
  **Unstar** (`PUT …/star` on every copy), the name with finetune and gone
  pills, "<kind> · group of <n> | <n> copies · built on <base> ·
  <endpoints>", opening in place to a table of its copies, the group's
  members first in order (Move up, Move down, Remove from the group: `PATCH
  …/groups/:id`), then the others (**Add to group** when the row's group is
  the user's to change). A Copy cell: raw model name with its endpoint muted
  after it, kind, status and "same file" pills (the Models page's checksum),
  "downloaded by Lyrica" or "shared folder", tok/s, the price and retirement
  day where the endpoint says (`Price` and `Retires` in src/ModelsFrame.tsx;
  the picker's facts line shows them too) and **Settings**; Context and Vision
  cells tinted where the copies differ; a ⋯ with **Not this model** (`PUT
  …/separate`; the new row reads "Separated from <name> · Undo", the name
  known for the visit, else "Separated") and **Delete from host…** (a dialog
  from a first `delete-copy` without confirm: what goes and what it frees,
  unloaded first when loaded, the lists that skip it, a shared host's
  sentence; a file the host kept goes to a toast). Under the table: the
  group's warn lines, a note per suggestion with **Group** (a new group, or
  into the row's), the lineage line, and "Group · shared with every user |
  only you" with **Rename** and **Ungroup** (confirmed). A copy's
  **Settings** opens a drawer: **Sampling** (`GET|PUT …/settings`; **Yours**
  | **Everyone's** for an administrator on a shared endpoint; a row per key
  with its source word; an empty field's placeholder is what applies instead:
  the shared value ("shared"), else the model's own (`defaults`, "model's"),
  else for Maximum reply length the cap; a dropped key
  disabled with "not sent", Maximum reply length "of <cap> tokens" (`replyCap`
  of the context in effect, the endpoint's kind and the offering's `maxOutput`; clamped on leaving the
  field and on save, and a saved value above it shown clamped), Reset; on a
  plain endpoint **Context window**, its placeholder the window planned by,
  marked "loaded" (LM Studio) or "assumed" when nothing says,
  `PATCH …/offerings/:id`) and, on a model host, **Serving** (`GET|PUT
  …/serving`, the server read from the raw name: a `.gguf` is llama.cpp,
  else vLLM): Placement (Auto or Choose GPUs, Split ratio or Parallelism,
  Memory share, Pinned through the host's pin route, the KV cache estimate,
  and "<n> GB stays in system RAM, so it runs slower." from `ramBytes`),
  Memory (Context length "of <max>", Stretch, Original context, KV cache,
  **System RAM** (Auto or Off, the setting `systemRam`, shown while the
  host has an allowance), **Embedding table** (Disk or RAM, the setting
  `layerTable`, shown when the host reports `layerTableBytes` and has an
  allowance; the system RAM estimate leaves a table kept there out),
  Flash attention, **Projector** (the setting `mmproj`, picked
  from the host's `projectors`), Vision, MTP; **Look up**, `POST …/lookup`,
  with a **Repository** popover on `need_repo`), **Missing files**
  (`MissingCompanions`: for a model with an `origin` that lacks a projector
  or MTP file, `GET …/hosts/:id/hub/files` for its repository, the missing
  companions with the one the host would pair first, and **Download**,
  `POST …/hosts/:id/downloads`), Throughput and Template (a custom
  file read in the browser). The foot: Cancel, **Save and reload** (`POST
  …/reload`) when the model is loaded and the serving draft changed, **Save
  anyway** after `above_recommended` (it repeats the refused save, reload
  included), and Save; a toast after. A speaking model's Settings opens its
  Voice drawer. The header's **Download model**, the tab's one primary,
  opens Download text model.
  Image models (`src/ImageModels.tsx`, its pure parts in `src/images.ts`)
  reads each model host's library (`GET …/hosts/:id/images`: recipes, and
  parts by role) and the plain endpoints' image models from the Models page.
  Cloud model rows and the Cloud group's collapsed **Other cloud models**
  (a keyed endpoint's other models) share `CloudImageControls.tsx`:
  **Generate** and **Edit** checkboxes, and Use for (Fast | Quality | Both)
  while Generate is on. Hosts and endpoints has no image switches; its
  Image pill links to Image models.
  Each change PATCHes the offering's capabilities and reloads the Models
  page; controls are disabled for a shared endpoint's non-administrator.
  These use ux §3's controls, §4's names and §6's model blocks.
  The facts line counts models, parts, hosts and the groups holding them,
  then links "<n> to review" when a host the user manages proposed
  anything. **Models** | **Parts** and a search (name or file) filter in the
  page; for Models, **Role** in the header (All, Generate, Edit, Upscale) and
  **Where** (All, Local, Cloud), for Parts the architecture and type chips.
  Models groups every image model by architecture (the first copy's), then
  Other (local plain endpoints) and Cloud; each architecture's group ends
  with a collapsed "Parts for <architecture>" from every host's library.
  Recipes are a row per recipe name across the hosts, confirmed copies
  first; a name only proposed or ignored is left out. A row opens to a
  block per host (template and defaults, a row per part with precision, "downloaded by Lyrica" or "shared folder",
  the other recipes using it, its size and an underlined **Change** or
  **Remove** at the right, then **Add part**, a segmented **Use for**
  (**Fast** | **Quality** | **Both**, default Both), **Steps** for a
  confirmed recipe whose defaults have steps, and **Delete model…**).
  A ChatGPT plan's one row is ChatGPT Images, its kind's tooltip saying it
  runs on the plan's image tool. Part filenames and facts wrap
  within their column on a phone. Every change is a recipe action
  (`POST …/hosts/:id/recipes/:recipeId`, models.md "Image models"):
  **Use for** saves at once (`change { op: "useFor", useFor }`), disabled
  while saving or when the user cannot manage the host. **Steps** is a
  number "of 150", clamped to a whole number from 1 to 150 when left or on
  Enter, and saves `change { op: "defaults", defaults: { steps } }` when it
  changed; disabled likewise. The row's facts say
  "fast", "quality" or "fast and quality", combining the copies' tiers. This follows principles 1 and 8 and ux §3's segmented
  control, §4's names and §6's recipe block; no caption or new widget.
  **Change** for a text encoder or VAE (`swap`, or Download another… to the
  download page), **Remove** for an added part or LoRA, **Use this recipe**
  (`confirm`), **Download the missing parts** (`download-parts`),
  **Ignore**, the **Add part** side drawer and the delete dialog. **Add part**
  lists the host's files of the part's kind and architecture, with what
  uses each, and adds a VAE or text encoder to a checkpoint
  (`addPart`) or a LoRA with its strength (`addLora`), by default into a
  copy named "<name> + <LoRA>" (`copy` first) so the recipe stays as it is.
  Its Strength is a number from 0 to 1.5, clamped when the field is left.
  **Delete model…** (shown when Lyrica downloaded the recipe's main file) works
  out from the parts' `downloaded` and `usedBy` what goes and what stays
  (an ignored recipe keeps nothing, as on the host), names the lists that skip it from a first `delete-copy` without confirm on
  its offering (`recipe/<id>`), then sends `delete`; a file the host kept
  goes to a toast. A recipe copied from another links to it. Parts lists
  every file of the chosen type (or Unused files) with its host, facts and
  the recipes using it, each a link to its row or to To review. **To
  review** (`…/models/images/review`) lists the proposals on hosts the user
  manages, by host, 50 at a time, with Use, Download parts and a ⋯ (Select,
  Details, Ignore); it selects as Files does (`useSelection` and
  `useLongPress` in `src/ui.tsx`, which Files uses too), and the bar sends
  the action to each selected recipe in turn. **Download image model**
  (`…/models/images/download`) starts on **Starter recipes**: the host's
  starters (`GET …/starters`) as radios, each with its parts and the size
  left to download or "every part is on this host", and "added" once the
  host made a recipe from it. **Add model** makes it (`POST
  …/starters/:id/install`), first asking in a dialog, "Download the missing
  parts?", which names each missing file and its size, when anything is
  missing; nothing downloads before Download there. It then opens Downloads,
  or Image models when nothing was missing. The page shares the text page's
  host field, lookup, token handling and link fields: a Hugging Face repository's files as
  checkboxes (`POST …/downloads` with `files`), a link, or **Scan now**,
  which asks the host to read its models folder (`POST …/manage` with
  `/host/v1/scan`) and shows what it proposed as To review's rows. Its
  Cancel goes back as the text page's does. A row on Image models has
  **Star** or **Unstar** at its left, as on Text models (`PUT …/star` on
  each copy's offering; `GET …/models/page` marks a starred offering
  `starred`), and starred rows come first in their group (`starredFirst`
  in `src/images.ts`).
  Downloads (`src/Downloads.tsx`, its wording in `src/downloads.ts`) lists
  the downloads of every host the user may manage (`GET
  …/hosts/:id/downloads?preview=1`; a shared host's need an administrator),
  active downloads and the newest finished entry per host, read again 2 s
  after each answer while
  anything runs; that count is the Downloads link's, which elsewhere in the
  area is the hosts' own `downloads.active`. A running download has its
  bar and **Cancel** (`DELETE …/downloads/:id`); a finished one its ending
  and, once it is a model, its group or **Add to the group “<g>”** (a group
  holding a copy the strong suggestions pair it with); **Clear finished**
  collects finished IDs in one walk over the pages, then deletes each once. **History** shows only
  the newest finished download, with **Show all** beside its eyebrow opening
  `…/models/downloads/history`: server-side search and numbered pages,
  retaining the existing ending and group actions. The header has **Download text model** and
  **Download image model**. **Download text model**
  (`…/models/downloads/text`) looks the repository up on the chosen host
  (`GET …/hub/files`; owner/name or the page's link), offers each GGUF file
  (a split one as one choice) or, with no GGUF in it, the whole repository,
  names the big files the host refuses with its reason, and starts the
  download (`POST …/downloads`), then shows the queue. lyricad sends a hub
  only a saved token, so one typed for a gated repository is saved first
  and removed again after the start when Save it for next time is off; if
  that removal fails, the download still counts as started and the token
  stays under Accounts. The page's Cancel goes back to the Models address
  it was opened from, else to Downloads. **Accounts** (`GET|PUT|DELETE …/hub-tokens`) shows per hub
  the token a download uses, the user's own before a shared one, as its
  last four characters; Remove is there only where the user may remove it
  (a shared token needs an administrator).
- **Notifications** (`src/Notifications.tsx`; docs/ux.md §6 "Anything
  waiting for the user"): a page of its own (`#/u/<user>/notifications`), one list from
  `GET …/notifications`. Chips filter by type (All with the count, Needs a
  decision, then the types that exist now); Sort offers Newest first,
  Oldest first, By type and By pool (the last two group the rows under eyebrows); Where
  narrows to a pool. Each row has its kind, pool and time, Open thread or
  Open where the item leads, and its actions as buttons (an action that
  answers with a thread goes there); acting on a row also reloads the sleep
  overview, since a From sleep row is the same item as on the From sleep card
  and the Sleep page. A **From sleep** row carries its item's whole text
  (`GET …/notifications` no longer shortens these titles) and shows three lines;
  **Show more** under the text opens the rest in place and reads **Show less**, so
  reading one needs no chat. The welcome card's rows do the same, since they are the
  same row. Checkboxes select rows for the bulk bar; a row's checkbox is named
  "Select <its first words>" (`firstWords(title, 80)` in `src/memory.ts`), so
  announcing it does not read out a whole sleep item before the listener can
  move on, and the row keeps its full text either way. The bulk bar has a
  button for each action every selected row shares, with the count
  (Add to Private 2, Decline 2), and none when they share none. Twenty rows at a time, with
  Show more. The welcome page shows the first four decisions in a card
  with All N.
- **Set up Lyrica** (`src/Setup.tsx`; docs/ux.md §6 "Setting her up";
  [briefs/web-bootstrap.md](briefs/web-bootstrap.md)): while
  `GET /api/state` says `setup`, this page stands where the unlock page
  would. One card, steps as sections with eyebrows: Code and passphrase
  (the code from `lyrica admin setup-code`, the passphrase
  twice, **Start unlocked** when `State.credentials` allows it, else the
  reason), her name, Administrator (login, password, name, pronouns);
  **Create** posts `/api/setup` and the page continues signed in as that
  administrator: Tailnet (the state, an Auth key with Hostname and Advanced →
  Control server, **Connect**, then a **Web access over the tailnet** switch
  applied on Continue; or Skip), Models (one endpoint, shared, its first
  chat model set for the preset; or Skip), Done (the addresses to open her
  at with the fingerprint, the administrator's login, the tailnet, and a
  sentence when she starts locked), **Start a chat**. The current step's
  button is the one primary; a done step's turns secondary; the fields of a
  done step stay editable until Create. A wrong code says so at Create and
  counts on the unlock limiter; too many say to wait, longer after each
  wrong code, up to 15 minutes.
- **Settings** (`src/Panel.tsx`): a page with its sections listed at the
  left (a scrolling row on a phone): Profile (name, pronouns, **Time zone**,
  accent colour, monogram), Appearance (theme; the **Checklists** switch, which saves
  `Display.checklists` at once and reloads the thread list: off, the API
  sends no steps, so no card or header shows one; then Read aloud while
  agent writes under Speech), **Push** (`src/Push.tsx`: URL, optional masked Token,
  Include a link and Save; saved host/masked path and token presence only,
  with fresh credentials required to replace settings; Send a test shows Sent
  or receiver status and reason inline, refreshes the last failure, and Turn
  off clears the destination; the heading tooltip and hidden description
  explain what leaves the server), Unlock and lock (saved credentials, stay
  unlocked after logout, and `lyricad`'s warning when the two contradict),
  Password, Your personas (linking a separate persona needs both passwords),
  Persona suggestions (edit, send on to the administrators, or drop),
  Sleep (the **Sleep** mode select and the **Sleep fallback** switch;
  model presets moved to Models → Tasks and endpoints to Hosts and
  endpoints, so `…/settings/profiles` and `…/settings/endpoints` go there), Network (New threads: the default
  mode and Fallback; then network defaults per pool), and **Machines**
  (`src/Machines.tsx`, docs/ux.md section 6): a row per machine with its
  name, a facts line in mono (address, pool, "SSH · key" or "Proxmox API ·
  token", "up to Accept edits") and at most one state as a dot and a word
  (Online, Unreachable with the duration in mono, Key changed, Off
  network; none if never probed; a machine whose host key was never
  confirmed shows Key changed). The row opens a drawer: address, folder,
  pool and **Mode limit** as the message box's three-item mode list, with
  one Save. The row's ⋯ has Replace key, **Use anyway** (only on a private
  machine that is Off network: the same dialog as Add machine's, then
  `confirm-off-network`) and Remove, Remove in a dialog with its one
  sentence. **Add machine** is a link to its own card in the section
  (`#/u/<user>/settings/machines/new`): a kind segment (SSH | Proxmox), then
  steps as sections with eyebrows. Name and address (name, address, folder
  for SSH, pool); leaving the address or pressing Enter asks `lyricad` for
  her key and the setup commands. Key, or Token for Proxmox (the commands in
  a code block, **Copy**, and the token field). Test (**Test** probes again
  and says Logged in or the problem). Fingerprint (the host key or
  certificate fingerprint in mono, **Confirm**). The current step's button
  is the one primary; a done step's turns secondary; nothing is saved before
  Confirm. A private machine that resolves off network gets a dialog (**Add
  anyway** or Cancel) before Confirm saves it. Replace key
  (`#/u/<user>/settings/machines/<name>/key`) opens the same card at the
  Fingerprint step, with a Replace token field for Proxmox.
  **Git accounts** (`src/Git.tsx`): a row per account, its name, a facts
  line in mono (host, pool, kind, account) and one state (Signed in, Token
  rejected, Unreachable with how long, Off network). A row opens the drawer
  (Name, Kind, Host, Account, Pool; a GitHub account's Pool is the fact
  General, with the reason as its tooltip), with Replace token, Use anyway
  (a private account Off network) and Remove behind ⋯; Remove names what
  leaves in its dialog (**Keep** / **Remove**). **Add account** opens the
  same drawer with a Token field; Add account checks the token against the
  host (`POST …/git-accounts/probe`, then `POST …/git-accounts`), and a
  private account off network asks first. The token is never sent back.
  **MCP servers** (`src/Mcp.tsx`), after Git accounts: a row per server,
  its name, a facts line in mono (host, pool, tool count) and one state
  (Online, Token rejected, Unreachable with how long, Off network). A row
  opens the drawer (Name, URL, Pool, with the server's description under
  it), with Replace token, Use anyway and Remove behind ⋯; Remove says it
  leaves every project and thread at once (**Keep** / **Remove**). **Add
  server** opens the same drawer with an optional Token field and checks
  the server first (`POST …/mcp-servers/probe`, then `POST
  …/mcp-servers`); a private server off network asks first (**Add
  anyway**, or **Save anyway** for a changed URL).
  **Claude Code and Codex**, after MCP servers (`settings/codex` opens it
  too), two cards. Claude Code (`src/ClaudeCode.tsx`): a Token field and
  **Save token** (`PUT …/claude-code`), or once saved Signed in and
  **Remove** (`DELETE`), confirmed in place; Not installed when the server
  lacks the program. The token is never sent back. Codex
  (`src/Codex.tsx`, `GET …/codex`): **Sign in** (`POST …/codex/sign-in`)
  shows the Sign-in page link and Code with Waiting for Codex, polling
  every 3 seconds until Signed in, then **Sign out** (`DELETE …/codex`),
  confirmed in place; Not installed when the server lacks Codex.
  **Routines** (`src/Routines.tsx`), after Claude Code and Codex: every routine of
  the user across both pools (`GET …/routines`), sorted by pool and thread, its
  thread linked, schedule from `describe()`, next time in mono or Paused,
  **Pause** or **Resume** (`PATCH …/threads/:pool/:threadId/routines/:id`
  with `paused`) and the bordered Remove icon (`DELETE` at the same path).
  Listings contain no notes. Empty: "No routines."
  **Skills** (`src/Skills.tsx`, `GET …/skills`, the pools the display
  shows), after Routines, its explanation the heading's tooltip
  (`Section`'s `hint`): the
  **Approve her skills automatically** switch (`PUT …/skills/auto-approve`),
  then each skill with its name in mono, Waiting or Declined as a state, Yours
  or her name, Private when it is, its description and its steps folded under
  **Steps** (a button with the chevron turning down while open, `--tap` tall
  on touch). A waiting one has plain **Approve** and **Decline**
  (`POST …/skills/:pool/:name/approve|decline`); the others have **Remove**,
  confirmed in place (`DELETE`). **Add skill** opens Name, When to use it and
  Steps with Save and Cancel (`POST …/skills`); its ⋯ holds **Export all**
  (`POST …/skills/export`, the file made in the browser from the response)
  and **Import…** (Choose files…, Pool, Import and Cancel, then a status
  line and Done; `POST …/skills/import`). Empty: "No skills yet." In
  the conversation, her `save_skill` call is a card (`SkillCard`): **New
  skill**, the name in mono, the description and the folded steps, with
  Approve primary and Decline while it waits, and otherwise its outcome as a dot and
  words (In her skills, Declined, Replaced or removed).
- **Portrait photos** (`src/PortraitPhotos.tsx`, `…/settings/portraits`): a card with the photo count pill and a grid of square
  thumbnails (132 px minimum, 12 px gap), the filename in mono underneath,
  and the existing row menu for Download and Delete…. The existing confirm
  dialog asks "Delete <name>?". Add photos is secondary and opens a multiple
  PNG/JPEG/WebP picker; each file over 20 MB is refused with its filename in
  the error line, while the remaining files are uploaded. Empty: "No photos yet."
  The select Sending them to a cloud image model has Ask once a day (default),
  Never and Always; it saves immediately. Its explanation is a tooltip.
  Listing, raw uploads and deletion use `…/photos-of-me`; thumbnails and
  downloads use the authenticated `…/photos-of-me/:name`; the setting uses
  `GET|PUT …/photo-cloud`. This follows the Images brief and principles 1
  and 2; controls reuse §3's secondary button and menu, §4's short labels
  and tooltips, and §6's confirmation dialog. No drawer or extra captions.
- **Administration**, for administrators: Status (`StatusSection` in
  `Panel.tsx`: "Updated" time and a refresh icon button in its head, and it
  re-reads Status, the sleep runs, memory counts and the Models page every
  minute while visible and on focus; stale Debian systemd units with the
  action to run `install.sh`, the server's network self-test, sleep time,
  last sleep per shown pool from `GET …/sleep`, memory pages and notes from
  `GET …/memory`, start unlocked; **Model hosts** from the shell's Models page,
  each host's state word and Models' `GpuBlock`s, `CpuBlock` and `RamBlock`; then **Model calls · last 24
  hours**: `ModelCallFacts.tsx` draws from GET Status's `modelFacts` a facts
  line, one legend, four Vega-Lite charts (calls and output tokens per hour,
  speed per call, calls by task; drawn live by `charts.ts`'s `drawChart` with
  a hover tip, hours on the user's own clock) and a row per offering ID with
  calls, output, median generation and prompt tok/s and recorded fallbacks.
  Series take the chart colours by label; past eight copies the least used are
  Other. Changing shown pools drops the old aggregate and loads Status again.
  The scope line names the displayed pools and latest-500-record retention
  per user, not a complete day's activity. No measured speed reads — with a
  "Not measured" tooltip; empty reads No retained calls in the last 24 hours.
  Tooltips explain scope, pace and fallback markers; no errors or retries are
  inferred), **Her name** (Name, 1–40 characters
  on one line, one Save disabled when invalid or unchanged; `PUT …/admin/name`,
  then her displayed name updates and the page re-reads `/api/state`), Users with the administrator flag,
  **Change password…** (the new password and the administrator's own, in
  the row; the user's data stays, they are logged out and told at their
  next visit), **Delete user…** on every row but your own (`src/DeleteUser.tsx`:
  Wipe memory's dialog, titled "Delete <name>?", on `POST`/`GET
  …/admin/users/:targetId/delete`, its stopping state "Stopping <name>'s
  work"; done, the row goes and the section says "<name> was deleted.") and
  their allowed folders, Sleep (**Sleep time**, `type="time"`, one Save;
  `GET`/`PUT …/admin/sleep`), Start unlocked (saving the `self.db`
  passphrase, and **Change passphrase…**: Current passphrase, New passphrase and
  New passphrase again stacked in place, hiding Passphrase and Save meanwhile, `POST …/admin/passphrase/change`; a 403 says "That
  isn't the current passphrase.", a 429 "Too many tries. Try again in <n> min."
  with the button disabled; the fields clear after a success or Cancel), **Tailnet**, Web access, **Web search** (`src/WebSearch.tsx`:
  **SearXNG address** in mono, without its password (a basic-auth password
  is kept when the user@host is unchanged), one Save, and Reachable or Unreachable as a
  dot and a word, what failed as its tooltip; `GET`/`PUT …/admin/web-search`),
  **Updates**, **Persona**: the persona changes that users sent on, the
  file now and the proposed text side by side, rendered as Markdown
  (who sent them, whether they edited them, and a confirmation when the file
  changed since), and **Reset** (`src/Wipe.tsx`): **Wipe memory…** opens a
  dialog with its sentence, **Keep everyone's skills** (ticked; `keepSkills`), an unticked "I understand this can't be undone",
  **Your password**, Cancel and **Wipe memory**, enabled once both are given
  (`POST …/admin/wipe`; a 401 says "That isn't your password."). When
  something was running the same dialog becomes **Stopping everything**: a
  spinner beside its sentence and "<n> running" as a disclosure listing each
  (Reply, Subagent or Sleep · user · pool), polling `GET …/admin/wipe` until
  nothing runs, when it says **Everything has stopped** and **Wipe memory**
  enables again. Done, the section says "Memory wiped.". Settings ends with
  its own **Reset**: **Wipe my memory…** opens the same dialog, "Wipe your
  memory?", with **Keep my skills**, on `POST`/`GET …/me/wipe`, which wipes and lists only the user's
  own; its stopping state is titled **Stopping your work**. Her name (`src/name.ts`, `her()`) is what every label,
  placeholder and sentence says where this doc says Lyrica, and the tab's
  title. **Tailnet** (`src/Tailnet.tsx`; docs/ux.md §6 "The tailnet"): a
  facts line in mono (tailnet, address, MagicDNS name, control server) and
  one state (Connected, Disconnected, Not installed with the reason, Not
  joined); **Connect** and **Disconnect**; Leave and Connect to another
  tailnet behind ⋯, each asked in a dialog; joining in a drawer (Auth key,
  Hostname, Advanced → Control server; `PUT …/admin/tailnet`). A `409`
  from leaving over the tailnet itself is shown as its sentence. **Updates**
  (`src/Updates.tsx`; docs/ux.md §6 "Updates"): the running version in mono,
  **Check**, the newest update note (its tag in mono, its text in a block),
  **Update** as the one primary (disabled while an update runs), a state
  line beneath (Draining with the count of busy threads and the user's own
  linked, Building, Testing, Probation, Failed with the error), the last
  rollback as a sentence, and the kept releases as rows (commit in mono,
  date, the first line of its update note when it has one, Running) with **Roll back** in the row's ⋯, asked in a dialog that
  names the commit and says when messages since the snapshot are lost.
  While an update drains, the page polls every 5 s; sending a message that
  gets `409 {updating:true}` keeps the text in the box and says Updating.
  Where no updater is installed (a development run) the section says so.
  A failed probation also shows in Notifications as "Update <commit> rolled
  back" for a week. **Web access** has:
  - the mode: only this machine, **Direct** (her own HTTPS on the
    machine's LAN and Tailscale addresses, port 7340, her own certificate
    with its fingerprint shown), **Tailnet** (HTTPS at her tailnet name
    through `tailscale serve`; needs a joined tailnet), the built-in Caddy,
    or a proxy elsewhere;
  - the hostname (Caddy and proxy modes), with a hint that its DNS record points at the Tailscale address;
  - for the built-in Caddy: the Tailscale and LAN addresses to serve on, the
    DNS provider with its credential fields and its token-scoping hint, an
    email for certificate warnings, and, under Advanced, testing with
    untrusted certificates (the status warns while it is on);
  - for a proxy: the address and ports to listen on, the proxy addresses,
    the certificate to pin, and a Caddyfile snippet;
  - the status of Caddy, the certificate, and the last certificate error;
    for Direct the addresses listening and the fingerprint, for Tailnet the
    name and whether it answers.

  Applying waits as long as `lyricad` needs (a new hostname can take about 90 s)
  and shows the time so far.

## Home

The header's heading is a greeting by the hour with the user's name ("Good
evening, Ada."). Beneath it are the date, the time, then the version and build
in mono, titled "Version 1.2, build abc1234"; her name is not repeated here —
the sidebar's link carries it. Its shared composer row has
the **+** menu (Attach a file, Web search, Internet for commands and Images),
the mic, and **General / Private**; no Mode or Thinking controls. On home the
menu opens downward, since the box sits near the top. The menu reads
new-thread defaults from `GET …/thread-defaults?pool=general|private`; switch
changes and attached File objects stay in component memory per pool. Only Send
creates the thread, then PATCHes its changed settings, uploads its files and
sends the first message with their paths. Dictation uses `POST …/transcribe?pool=`
without creating a thread. Leaving home discards the unsent text and files.

The content is one column in a centred block at most 960 px wide.
Beneath the box the cards sit side by side (auto-fit, each at least 240 px) and
stack when they don't fit. Each card has a plain h2 with its link on the right:
**From sleep** with Sleep and shows new visible-pool items, each clamped to
three lines with **Show more** under it opening the rest in place (as a
Notifications row does; `ClampedText` in `src/ui.tsx` is the one place that
measures), with Start a chat and Dismiss, private locks, or "Nothing she wants to raise." and the latest run's
time in mono. **Notifications** has All <n> and "Nothing waiting." when
empty. **Backend** has Models and lists each pool's first chat model, host,
local/cloud chip and preset, then each model host's state as a dot and word.

## Chat

- Her messages are prose, rendered with `react-markdown` and `remark-gfm`
  (`Prose` in `ui.tsx`): tables, task lists, strikethrough, footnotes and bare
  links. A table a model wrote on one line is put back on its rows first
  (`unfoldTables` in `markdown.ts`; a code block is left as written). Raw HTML is
  skipped and links open in a new tab. `RichBlock.tsx` draws a ```` ```mermaid ````
  block (Mermaid, `securityLevel: "strict"`, SVG labels), a ```` ```vega-lite ````
  block (`chartSvg` in `charts.ts`, which Status's charts share: Vega-Lite
  compiled to Vega, expressions interpreted by `vega-interpreter`, a loader that
  refuses every URL, and a spec naming a URL refused before it runs) and math (`remark-math` without single-dollar math;
  `mathMarks` turns `\( \)` and `\[ \]` into `$$`; KaTeX). Each library is its
  own chunk, loaded only when a message holds such a block, and the SVG is
  sanitized with DOMPurify before it is shown. The page's theme (`useTheme` in
  `ui.tsx`) colours them, redrawn when it changes. A path under `/workspace` or
  `/shared`, in her prose or the person's message, is a link to `…/files/<encoded path>`,
  which opens the Files panel with the file in the viewer (`paths.tsx`; a code block is left
  as written). So is a markdown link whose target is a file, not a URL or an
  anchor: an absolute path or `file://` URL as written, a relative one against
  `/workspace` (`fileTarget`); the panel refuses what she can't reach. In a
  project chat, whose `/shared` is its own `shared/`, a `/shared` path opens
  there. An image she writes from a file she can reach shows in the
  message by its thumbnail (`…/files/thumb`, or the image itself where the
  server makes none) and opens large, from `…/files/content`, in the
  shared Lightbox dialog; the conversation holds which image is open, so the
  stored copy replacing a live message doesn't close it (an SVG stays a link, since `…/files/content` serves it as text, never as a page); a remote image is never loaded and shows as a link with its
  alt text. An image her image tool already shows in the same turn (an
  image part before her text, up to the next user message) is rendered as
  its path link, not a second thumbnail (`conversationNodes` tracks the
  paths shown; `Prose skipImages`). In the person's message an image path
  on its own line, as an upload puts it, shows as the same thumbnail
  (`PathText large`, `paths.tsx`). A fenced code block has a strip along its top edge with the
  fence's language and **Copy**, which writes the block's text to the
  clipboard (`navigator.clipboard`, `CodeBlock.tsx`) and reads **Copied**, or
  **Copy failed** where the browser refuses, for 2 s; inline code, tool
  results, the permission card, the Files viewer and the Machines page's
  setup block have none.
- An image part, stored or delivered on `tool_end`, shows each path as a
  thumbnail up to 320 px tall with an 8 px radius and the filename as its
  accessible name. The facts line reads "Made with <model>" (the model's
  label without a shared endpoint's `shared.`) and, when given,
  "· fast" or "· quality". Its ⋯ holds Download, Copy path, Show in Files,
  Edit… and Delete…. Edit… fills the composer with "Edit <path>: " and enables
  Images. Delete… asks in a dialog ("Delete <name>?", Cancel and Delete),
  then deletes the file (`POST …/files/delete`); its place, and that of an
  image that fails to load and whose file the server then answers 404 for
  (a failed load alone, offline say, leaves it as it is), reads "No longer
  in Files", without the facts line. Full images use the thread's authenticated `…/file?path=` route;
  thumbnails use the existing thumbnail route and fall back to that file.
  A video part (a clip she made) shows its poster (`…/files/thumb`) at the
  clip's shape, at most 320 px tall and 420 px wide, with a round Play
  button in its middle ("Play <name>"); Play swaps it for the browser's own
  `<video>` player on `…/file?path=`, playing. Without a poster the player
  shows at once. Its facts line reads "Made with <model> · <seconds> s",
  and "· sound" when it has audio; its ⋯ holds Download, Copy path, Show in
  Files and Delete…, which asks as for an image; a deleted clip reads "No
  longer in Files". While an image call makes something, the stream's
  `making` (and `hello`'s) puts its placeholder (Making.tsx) under the
  marker until `made`: a card per image at the asked shape, a dot field in
  the accent lit from the top-right by the host's progress, and a pill with
  the percent, Waiting, or the time since it started (docs/ux.md).
  A clip's markers read Making a clip, Animating an image and Copying a
  clip's moves; a clip made in the background marks its call **started**, and the clip
  shows as her own message when a `notice` event brings its `video` (or the
  thread reloads), under the call's marker again, done, from the event's `call`; a failed one is a notice headed Clip with a down dot and
  "failed", then the reason.
  The shared Lightbox has a filename header, Download and Copy path behind
  ⋯, and Close. Image tool markers read Making an image with its tier,
  Editing an image, Upscaling an image, Rejecting an image (or <n> images),
  Picking an image or Deleting rejected images, then the word running, done
  or failed; expanding a failed marker shows the result's reason. Her
  rejected attempts (`src/rejects.ts`, from the tool's successful reject,
  pick and clear_rejected calls, matched by file name) leave their parts and
  fold into one closed "<n> rejected" marker per turn, where the turn's first
  reject was, opening to 160 px thumbnails at their `rejected/` paths with
  the usual facts and ⋯; a picked part takes the facts of the part that
  first showed it, and an image shown twice in a turn shows only the last
  time. After clear_rejected the marker reads "<n> rejected · deleted". The API currently sends no
  image step progress, so there is no step count or progress bar.
- A thread she mentions (`[t:<id>]`, `[e:<id>#<n>]`) shows as its current
  title, linked to the thread in the same tab; "a forgotten thread" once it's
  gone. Titles are fetched per thread and kept for 30 seconds, so a rename
  shows on the next look. This covers her prose, the notice cards, the task
  or message on a delegate or threads card, what a parent thread sent its
  child, and a subagent's task. Where a link can't go (the pinned list, a
  failed tool call's message) the title shows as plain text.
  The user's sit in a tinted block.
- Thinking, recalls, saved notes and tool calls are one-line markers that
  expand when tapped. Thinking's reads Show reasoning, and Hide reasoning
  while open. An expanded tool call stays open when the turn ends
  and the stored copy replaces the live one. A reply made only of markers
  (`isMarker` on every part: thinking, recall, remember, and tools other
  than delegate, propose_plan, image and a threads card other than steps
  or a poll) renders bare, with no header line or action row
  (`.turn.quiet`); consecutive ones are grouped, and three or more markers,
  or any run with a sleep or refused read in it (`waits`), fold into one
  **<n> tool calls** marker (`ToolRun`, "steps" when none is a tool call) that opens to a
  320 px box which scrolls (`.run-body`), each call its own marker inside,
  following the newest while the turn streams. Its open state is keyed by
  the first call's ID, so it survives the stored copy replacing the live
  one. A poll (`isPoll`) is a call that only waits: a bash `sleep N`,
  optionally followed by `echo` of plain words, whose output is empty or
  only that echo (running counts); a `threads read`; or the turn guard's
  refusal of a read made again. The guard's refusal doesn't mark the run
  failed, and its card shows the done dot with the sentence muted. The calls themselves stay allowed: polling is a wake's backup.
- An expanded `read` call of a text file (`readText`) shows its result as
  `ReadText`: the code block's strip with the file's name (a Files link
  when its path resolves under the thread's folders and the call isn't on a
  machine) and Copy, then the text in a `pre` that keeps its whitespace and
  scrolls sideways (`white-space: pre`), wrapped for `.txt`, `.log`, `.csv`
  and `.tsv`, or rendered with `Prose` for Markdown; at most 320 px tall.
  Pi's trailing "[Showing lines …]" or "[… more lines in file …]" note is
  taken off and shown as a caption without its "Use offset" advice.
- An expanded `read` call whose result says it read an image (`readImage`:
  "Read image file …", not on a machine, a path that resolves under the
  thread's folders) shows that image under the result as a thumbnail at
  most 160 px tall (`ReadImage`, `.read-image`), served by `…/files/thumb`
  and `…/files/content` as any file in Files is, so a path the panel
  refuses shows nothing. A tap opens the Lightbox. A 404 shows the muted
  "No longer in Files"; any other failure drops the thumbnail and leaves
  the result line.
- In a project chat, a look at its threads (a message with `from.kind ===
  "watching"`) is the marker **Checked the other threads**, with "· told 2"
  (the count in mono) when it messaged threads. A look made by one model
  call carries `from.told` (each thread told, `threadId`, and the line sent,
  `text`), and the count comes from that; her turn after it is her own. Its
  text is `In [t:<id>]: …` lines, then `Told` lines and maybe `Raised: "…"`.
  It expands to the threads looked at, each thread told with the line sent,
  and, when the look raised something, one line, "Raised with you: …"; the
  `Told` and `Raised` lines are not shown as text. An older look, stored
  before looks were one call, has no `told`: the count is the `threads
  message` calls of her next turn, which fold into the marker instead of
  showing as cards. Live, a look is a `notice` event with `status:
  "watching"` and `told`, or `received` when it raised something (its
  `Told` lines are read from the text); both draw the same marker until the
  stored copy replaces them (`src/looks.ts`). It is never the user's
  bubble, and nothing shows when the setting is off, since no look is sent.
- A `delegate` call is a card for its subagents (the tool part's
  `threads`), headed by their role (coder, scout, worker, or a role the
  user added) and, when they share one, the short name of the model they
  ran on, with the full label in its tooltip. Until they start it shows the
  role the call asked for, else "Subagent". Under the head is what the run
  was asked: its task, its steps numbered, a loop's task, a council's
  question or a workflow. With several subagents, each one's toggle names
  its role and number. The other actions say what they are: "Message to the
  <role>" with the message, Subagent status, Subagent wait, Subagent run
  stopped, Subagent models; status and models show the result's first
  lines. A failed call shows its error. Each expands to its work: the stored transcript, read-only,
  where each message says who sent it (Lyrica, the user by name, or the
  subagent's own work), reloaded as the subagent works; its waiting
  approvals; and a message box that writes to it as the user (Lyrica is
  told). What a run delivers later (a result, a question, a note, or what
  someone wrote to a subagent), as a `notice` event and stored as a
  `notice` message, shows as a card headed by what it is, linking to the
  subagent.
- Permission requests appear inline with Allow and Deny and the time left.
  A portrait request (`tool: "image"`) instead asks "Send your portrait
  photos to <model> (cloud) for this image? A yes lasts until the end of the
  day." The resolved model label comes from `args.model`; Send today is
  primary, Not today secondary, and there is no thread-wide Allow. Answers
  use the existing permission route with `{ allow }`, including for subagents.
  Her `models` tool's proposal is worded as its question ("Serve
  Qwen3.8-27B on Blackwell with 1,010,000 tokens of context for every thread? It reloads,
  and its KV cache grows to 17 GB."; an LM Studio model's ends "It reloads
  now, and replies in progress on it stop."), the numbers in mono.
  A call on a machine (`machine` on the request) leads with the machine's
  name in mono, says the folder the command runs in, and shows the command,
  path or Proxmox action and VM in mono; a suspect command (`suspect`,
  `warning`) adds its warning sentence above the command and a third,
  secondary **Allow in this thread**, which answers with `allowInThread`.
  An MCP call (`server`, `serverTool`) leads with the server's name and
  the tool in mono, shows the arguments as JSON, and has Allow, **Allow in
  this thread** and Deny. Its tool marker names the server, then the tool.
  A tool marker for a call on a machine names the machine first. A
  subagent's request shows in its parent's thread (in its card, when that
  is open) and on its own page, naming the subagent, and stays past the
  parent's turn; the first answer wins and the other view updates.
- Errors from the stream (a refused model, an endpoint that's down) are shown
  as sent, in plain words. When no model can be reached, one line says so
  ("No model can be reached. Your message goes when one is back."), with
  the models tried in its tooltip; the message shows as waiting, not as
  sent, until a turn starts. The line goes once a model starts answering,
  as a retry that got through does.
- A stored compaction shows as a one-line marker, **Compacted · 41k → 6k**,
  that opens to the summary stored with it. Her own `threads` compact call
  is a **Compaction** card whose head opens to the summary in its arguments.
  Both read what the session already holds; nothing else is written.
- A message sent during a turn waits as a follow-up and shows as waiting.
  Stop aborts the turn; `lyricad` drops the waiting follow-ups, so their text
  goes back into the composer. While she works, a waiting one has **Steer
  now** in its header line, which sends it into her turn after her current
  step; the `queue` event marked `steered` takes it out of the waiting list
  without showing it as sent, until `received` shows where it landed. A
  message from another thread or a look
  never waits there: it shows where it reached the turn (`received`).
- `src/live.ts` turns stream events into the in-progress turn. When a turn
  ends, the stored messages are reloaded and the live copy is dropped. A sent
  user message already in the stored page is shown only there, even before
  turn end or if the send response arrives after the reload. Copies match by
  text in send order, using the last stored message number before sending
  so an earlier identical message does not hide a new one.
  `src/stream.ts` listens for every `ThreadEvent` type by name, from a
  record keyed by the type, so a new type fails the typecheck until it's
  listed.
  `EventSource` reconnects with `Last-Event-ID`. If it gives up, a new one
  can't send that header, so the UI starts again from the stored messages,
  and one request checks whether the login still holds. A `reset` reloads
  the stored messages, and so does every `hello` that finds the thread idle:
  a turn may have ended between fetching the messages and opening the stream,
  such as a child thread opened as its first turn ends. A `settings` event
  (a question opening or closing) reloads them only between turns: mid-turn
  the page would hold her message while its live copy still shows, and the
  turn's end reloads them anyway. A view that opens mid-turn (the first send
  from New thread) can still load a message the stream then shows too, so a
  stored message that shares a tool call with a live one is hidden until the
  turn's end replaces the live copy (`storedLiveCopies` in `src/live.ts`).
  An `error` marked `reply` is the error of the reply that just ended, and
  shows under that reply as its stored copy does, so a retry Pi makes goes
  on below it; the turn's other errors show after the live turn until the
  next turn starts.
- **Sources** (docs/ux.md, The pages she read for a reply): `conversationNodes`
  collects her parts since the person's last message or her last words, and
  the next message of hers with words shows the pages its `web_fetch` calls
  read (`sourcesOf`: successful calls, http and https only, once each, with
  the `# ` title line that follows the outside-content marker) as links
  under its text, before the reaction chips.
- **Each message has an action row** under it (`MessageActions` in
  `src/Rewind.tsx`, after the reaction chips; docs/ux.md §6, A message's
  actions): quiet icon buttons, Copy (the message's text; Copied or Copy
  failed for two seconds), on her replies Regenerate (`rewind` with
  `action: "regenerate"`), on the user's Edit, which turns the message into
  a box (Save, Cancel) whose text is sent in its place, then Branch, Read
  aloud (hers), React and the ⋯ (More actions, `MessageMenu`): Pin or
  Unpin; Remember this (a labelled field under the message, prefilled with
  its first line, whose Remember button writes a user-introduced note in the
  thread's pool citing the message; `RememberBox` in `src/Messages.tsx`);
  Start a thread in a project chat; on her replies Regenerate with… (the
  thread's chat models, `isChatModel` in `ModelLabel.tsx`, the same filter
  lyricad uses, so image, speech and embedding offerings stay out); Delete
  on the messages of the last turn, and Delete from here on earlier ones,
  both in danger text. A marker's ⋯ (a look, a received message, a routine)
  has Branch from here instead of a row. The row is right-aligned under the
  user's message and its menus open leftwards; on a pointer device it
  appears on hover or focus (`.msg-actions`), on touch it is always shown
  with 44 px buttons. Removing turns hides them at
  once and waits five seconds with an Undo toast before the request goes
  (leaving the thread sends it at once): Delete, and Regenerate or Edit
  before the last turn. On the last turn, Regenerate and Edit go at once.
  Turns that did things are confirmed first: the rewind is previewed, and if
  it would undo files or branches, list commands, or take pins or subagent
  threads, a confirmation box (fixed above the composer) asks "Remove 2
  messages? 1 is pinned." and lists, under Undone, Kept and Not undone, the
  undos with a checkbox each, kept files with a badge saying why, and the
  commands behind "N commands ▾"; Remove goes on with what's ticked, Cancel
  leaves everything. A `rewound`
  event drops the removed messages from every open view; when it carries
  `resend`, the live copy of the message sent again is given `afterN` from
  the rewind point (`stream.ts`), so the stored copy replaces it instead of
  showing beside it. A new branch opens,
  under "Branched from" its parent, and its settings can be changed within
  its parent's.
- **A message's header line** (`.who.sent` in `Messages.tsx`) reads the
  sender's name, for hers the model, then the time it was sent, then the
  "pinned" badge; the actions are the row under the message. The name, model
  and time sit together in `.who-head`, without the line's gap, joined by
  dots (`Sep`) with the same air on both sides. The time is a
  `<time>` in mono, muted like the model: `wakeTime`'s HH:MM today and the
  date before it otherwise, in the reader's locale order ("11 Oct 14:32",
  "Oct 11 14:32" in en-US), with `fullTime`'s weekday, date and 24-hour
  time in the reader's locale as its tooltip ("Monday, October 12, 2026 at
  14:32" in en-US; `ui.tsx`). Every time of day in the app is 24-hour
  HH:MM through `clock` (lists, sidebar, Sleep, Updates, the welcome page),
  whatever the locale. Every time and day the app shows is in the user's
  own time zone (`Me.timeZone`), not the browser's: the shell sets it with
  `setTimeZone` before rendering, and `clock`, `dateText`, `dayNumber` (the
  sidebar's Today and Yesterday), `hourOf` (the greeting), `wakeTime` and
  `fullTime` read it. A user without one is given the browser's zone once,
  by `PATCH …/me/profile` (`useZone` in `Shell.tsx`). It comes from the stored message's
  `createdAt`, so a reply that is still streaming (or a message waiting to
  go) has none until its stored copy replaces it. Markers keep their own
  lines and show no time; there are no day dividers. The line never wraps:
  the name and model are the one part that shrinks (`min-width: 0`, an
  ellipsis, the model whole in its `title`), while the time keeps its size,
  so on a phone a long model name loses its tail.
- **Reactions** (`src/Reactions.tsx`; the picker styles its shadow root
  inline, so lyricad's CSP allows inline styles, scripts stay `'self'`): a React button (a face with a plus)
  in each message's action row, before its ⋯, opens a quick row (🙏 👍 ❤️ 🎉 👀 🚀, tooltips
  "React with tada") whose last button, More emoji, opens the full picker
  with search and categories (`emoji-picker-element`, loaded only then; its
  data is served with the UI, never from a CDN, and kept by the browser).
  Reactions show as chips under the message, each emoji with its count; the
  user's own are outlined in the accent and pressing one takes it off. Hers
  arrive by the `reactions` event, as do the user's from another tab.
- **Pinned messages** carry a "pinned" badge after the sender's name. The
  header's "N pinned ▾" badge (the number in mono) opens a popover listing
  them by sender and first line; choosing one scrolls to it and outlines it
  for a second. When the pins are over their budget the badge adds "shortened", with
  a tooltip saying the oldest reach her as their first line only.
- A `threads` call is a card headed by what it did: "Child thread: <title>"
  for a start, "Update to the parent thread" or "Message to <title>" for a
  message and "Read <title>" for a read (the thread's current title, on one
  line with an ellipsis and in full as the head's tooltip; "a thread" until
  it runs, and "a forgotten thread", with no Open, once that thread is
  gone), and "Thread read" before a read runs, "Thread stopped", "Thread resolved",
  "Threads" (list) and the like for the rest (`THREADS_HEADS`); a failed
  `ask` is "Question not asked" with its error, never a question card; it links
  to the thread — one **Open** link in its head, or when the run made
  more than one thread a **Threads <n>** button with the count in mono and a
  chevron (`aria-expanded`, turning down while open; `src/Messages.tsx`) that
  opens a dialog of them: each row the title cut to one line and its state as a
  dot and a word, a 44 px tap on coarse pointers, full width in flow at 390 px.
  Each opens the panel from 1180 px up and the page below. While the child has a checklist (its
  `ThreadSummary.steps` in the thread list), the start card shows its
  count and current step as a project's card does. A child's update shows
  in the parent as a card headed "Child thread", linking to it. **In a project chat** there is no
  card per start or update: each of the project's threads gets one card
  under the first displayed message at or after its anchor entry (some
  entries aren't displayed); threads whose anchor was removed sit under
  the last message. Cards stay there as later messages arrive, updated in
  place from the overview:
  title, state as a dot and word (Working blue, Waiting amber, Resolved
  green, Idle plain), its checklist's count while it has one
  (`ThreadSummary.steps`: "2 of 5" with its numbers in mono, a link named
  "Checklist, 2 of 5 steps done" that opens the header's popover; on a
  phone it opens in flow under the card's head, the card's width, with no
  shadow), then its pull request and subagent chips as in the threads list's
  rows (the pull request's a link to it on its forge, opening a new tab; on
  a phone the chips take their own line under the title), "wakes" and its next
  wake-up's time in mono while one waits (`ThreadSummary.wakeAt`);
  beneath, the step under way (or the first to do) with its mark, on one
  line with an ellipsis, left off once all are done or the thread is
  resolved; then the first line of its last update; **View thread** at its foot
  (`a.sm`) opens the thread — the panel from 1180 px up, the page below — as does a double-click on the card that lands on none of its links or buttons and, on its text, leaves nothing selected. Open, Stop,
  Pin or Unpin (`…/pin`, as the thread menu's, with its toast; a pinned
  thread sits first among the project's threads in the sidebar, never in
  the Pinned group), Resolve or Reopen behind ⋯. The sidebar rows show no
  checklist. A card waiting on the user carries
  `data-pending`, so the pending bar reads "Thread waiting for your answer".
  A `threads suggest` call is the **Suggested threads** card, like the plan
  card: each proposed thread with Start, one primary Start all; started ones
  show Open (`GET …/overview` says which, by call and index). **Start a
  thread** in a message's menu (project chats only) starts one from that
  message (`POST …/messages/:n/thread`). What a parent sent its child, or
  a project's thread sent a sibling (`from.kind` "parent" or "thread"), is
  one line, "Message received from <thread title>" with a chevron, until
  tapped (the text is shown once, not repeated in the chat); open,
  it is a tinted block headed "Lyrica · from <title>" with the message menu
  (Branch, Delete; not Edit), and one taller than twelve lines shows
  **Show more**. Deleting a thread with child threads asks
  whether to delete them too, ticked, in the thread menu's `ConfirmDialog`.
- When a wake-up fires (her `threads later`), her note arrives as a message
  with `from.kind === "wakeup"` (live, text starting `[Wake-up, set …]`). It
  is one line, **Woke up · set <time>**, with "· due <time>" when it fired
  late (the user was locked), the times in mono, and a chevron; tapped, the
  note opens as a tinted block under her name with the message menu, as
  Message received does.
- A routine's note is the same expandable marker, **Routine ran** with
  the schedule's `describe()` text. Stored messages carry
  `from.kind === "routine"`; live messages start `[Routine, <schedule>]`.
  Opening the marker shows her note as the wake-up's tinted block, with
  its message menu.
- Files attach from the "+" menu, by dragging onto the composer, or by
  pasting. Each shows its progress, and its path in the thread goes into the
  draft on a line of its own. An image path in the draft shows as a
  thumbnail above the box (`.attachments`, the thumbnail route) with an ✕,
  Remove <name>, a 24 px circle whose hit area is 44 px on touch, that takes
  its line out; the server names an uploaded
  image at random (docs/workspace.md), so the person's message shows the
  picture, not a telling filename.
- **The message box** (`src/Composer.tsx`, `src/Modes.tsx`): a bordered box
  holding the text and, at the right of it, Send as a borderless up-arrow
  icon, accent once there is text, or Stop as a square while she works and
  the box is empty. Under the box, a row of borderless controls: at the left
  the "+" icon, whose menu attaches a file and, after a separator, has the
  Web search, Internet for commands and Images switches (Web search's
  tooltip says "Search needs a SearXNG address in Administration" while the
  server has none, `ThreadSettings.searchProvider`); then the mic; at the right the
  mode, a link with a chevron that opens a menu of the four modes (a check on
  the current one, its line, its number key; a mode above a granted
  machine's limit reads "Asks on <machine>" in its line). Shift+Tab in the box cycles
  Ask, Accept edits, Plan, Auto, shown at once. Changes are saved one at a
  time in the order pressed, and a message sent meanwhile waits for them; a
  settings refresh that a change overtakes is dropped. A `settings` event (an approved plan)
  refreshes them. The unsent text is kept on lyricad as the thread's draft
  (`…/draft`), encrypted with the thread's store: loaded when the thread
  opens (only into an empty box), saved a second after typing stops, on blur
  and on leaving, and cleared by a send; nothing is kept in the browser. A
  draft over 64 KiB shows "The draft is too long to keep." in the error line.
  The + menu's Images switch has the tooltip "Lets the agent make and edit
  images in this thread."
- **Dictation** (`src/Voice.tsx`, DESIGN.md "Voice"): the mic in the row
  under the box records 16 kHz mono PCM through an AudioWorklet
  (`public/dictation-worklet.js`). While it records the icon is accent and
  pulses, the box's placeholder reads "Listening…" and the time runs beside
  the icon in mono. Pressing it again, or Enter in the box, stops and sends
  the clip as WAV to `…/transcribe`; the icon pulses in muted meanwhile, and
  the text goes in at the caret. Escape throws the clip away, and so does
  leaving the thread. A clip stops itself at ten minutes and is cut there
  before it is sent, so a late timer can't make lyricad refuse it whole.
  Where the browser won't connect the microphone to a 16 kHz context
  (Firefox), the recorder uses the device's rate and resamples. The browser's own
  speech features are never used, and nothing is kept in browser storage.
  With no Dictation model usable here (`ThreadSettings.speech.transcribe`:
  none set, or every one down), the mic
  is disabled and its tooltip is lyricad's reason. "Allow the microphone in
  your browser" and lyricad's refusals show in the conversation's error line
  above the box, never as a toast or in the placeholder.
- **Read aloud** is the speaker icon in her message's action row,
  before React and ⋯, that plays lyricad's PCM stream for that message
  (`…/messages/:n/speech`) through Web Audio as it arrives; the AudioContext
  is made in the press, which iPhone requires. While it plays the button is
  **Stop reading**, a square in accent. Only one thing plays at a time: Stop
  reading, the mic, sending, another Read aloud or leaving the thread stops
  it. Disabled with the reason as its tooltip when no Read aloud model can be
  used here. The message she is still writing has no button unless
  **Read aloud while agent writes** is on (`ThreadSettings.speech.readAloudLive`):
  then its actions hold one too, playing `…/messages/live/speech`, which
  follows her to the end; when her stored copy replaces it, the last
  message's button owns that reading (Stop reading until it ends). In a
  split view each pane's buttons are its own, and still only one plays.
- **Fallback** is a switch in the thread settings drawer's Models section,
  after Thinking, following the user's default until changed (Use
  default goes back); tooltip "When off, only the first model in each list
  answers; if it can't, the message waits for it."
- **Dictation** and **Read aloud** are selects in the thread settings
  drawer's Models section, under Images and speech, offering only models that
  transcribe or speak; "Preset (…)" names what applies without a pick
  (for Dictation, always the Private column's). A cloud pick for Dictation
  first asks in a dialog naming the model (Use cloud dictation or Cancel);
  confirmed, it is what sends that thread's voice to the cloud.
  **Read aloud while agent writes** (`Presets.readAloudLive`) is a switch
  under Speech in Settings, Appearance. Models → Tasks has a Read aloud
  row in both columns and a Dictation row under Private threads only, and
  a speaking model
  in an endpoint's model list (Models → Hosts and endpoints, "N models") has
  a Settings link opening its drawer: a voice per
  language (English, Mandarin) and the speed (a number, of 4, clamped when
  the field is left), each with its source word (shared or yours) and a
  Reset link. The thread drawer's Read aloud select has the same
  **Settings** link after it, opening that drawer over the thread drawer
  for the model the select shows (the thread's pick, else the column's),
  when it speaks and the thread may use it; Escape closes the voice
  drawer first, and focus goes back to the link.
- **Question cards** (`src/Question.tsx`, principles 1 and 6; ux §6): a
  `threads ask` call shows its question, optional muted context and each
  option's label and consequence. Only the recommended option is primary,
  marked **Recommended**; on phones options stack full width at `--tap`
  height. A tap posts `{ option }` to `…/questions/:n/answer`; while it
  saves every option is disabled. The closed card keeps the question and a
  check with the chosen label, **Answered in words.**, or **Withdrawn.**
  `MessagePage.questions` supplies state, joined by the call's entry number;
  the settings event reloads the page even while a turn is running. An open
  card participates in the pending bar; the sidebar shows Waiting on you.
  A project's thread card reads the question from that thread's messages
  (paging back to the call if needed) and offers the same answers without
  leaving the project chat. Question changes refresh the thread list and
  Notifications. Notifications' **Question** rows count under Needs a
  decision, with the recommended consequence as detail, recommended-first
  answer buttons and then Open thread. Private questions follow the Private
  filter. A selection containing a question offers no bulk action.
- **The plan card:** a `propose_plan` request shows "Plan", its step count
  when it has numbered or bulleted steps, the plan as prose, a primary
  "Go ahead in…" whose menu offers Ask, Accept edits or Auto, Keep planning,
  and the time left. Its tool marker stays hidden until it is answered.
- **Waiting for an answer:** when the latest card waiting for her answer (a
  plan, an approval or a question) has scrolled out of view, a thin accent bar across the
  top of the conversation says "Plan waiting for your answer" (or
  "Approval…") and scrolls to it.
- **Jump to latest:** when new messages or streamed text land while the person
  has scrolled up, a small secondary **Jump to latest** button at the foot of the
  conversation offers to take them back down to the latest text
  (`useStickyScroll` in `src/Thread.tsx`; docs/ux.md §6). Clicking it scrolls to the
  bottom, and it is gone once the person is at the bottom again by any means.

A content refusal's image marker says "The model declined this image." (never
the code) and the small text
links Edit message, Resend and Try <model> (ux §5's agreed action exception
and §6's image row). The server computes choices from the current task list
and portrait policy. Edit message appears only for the last user message
and copies it into the composer through an in-memory event; Resend repeats
the image call, Try selects the next eligible endpoint. Resend shows at once;
the other two join it when the options arrive. Busy calls hide the links. Both retries save results in the conversation and recheck consent.

## History

`src/History.tsx` supplies the heading link and shared history list for sleep
runs, journal entries, memory versions (including WAKE and journal versions),
model calls and finished downloads.
Only the latest entry appears in each preview. **Show all** is a plain link
in the History eyebrow's row, at its right edge. The page has a **Search**
field and numbered secondary **Page** buttons with “Page n of m” in mono;
large page counts show the ends and nearby numbers. Search resets to page 1
and requests after 300 ms; the APIs filter, page and return totals. Rows keep
their existing appearance and actions. Older memory versions show their
position as N of M (page offset plus row index, of the filtered total),
while the current version says current. No new widgets, icons or captions.
`…/history/journal[/<pool>]` lists journal entries and links each to its
memory page. Kept releases are bounded, and current routines and runs in a
thread describe active work.

## Look

`src/app.css` holds the design tokens as custom properties and follows
[docs/ux.md](ux.md): IBM Plex Sans and IBM Plex Mono, self-hosted from the
`@fontsource` packages (their licence ships as `OFL.txt`); type sizes 22,
15, 14, 13, 12 and 11; three button looks (primary, secondary, link) plus
icon buttons; one 16 px line icon set in `src/icons.tsx`, never a text
glyph; labels are nouns and hints are tooltips. Controls (buttons, fields,
the message box) have a 3:1 boundary (`--edge`); separators and cards use
the lighter `--line`. Text colours meet 4.5:1 in both themes. The accent is the user's
(`--user-accent`), lightened in dark mode; cloud, local and private keep
fixed colours. The theme follows the device unless the user overrides it.

From 1100 px an open thread drawer takes its width from the thread, so the
header wraps beside it instead of under it; narrower it overlays the thread.
From 760 px up the sidebar's right edge drags it from 200 to 440 px (248
to start), the same `Divider` as the panel's, the width kept in
`localStorage` (`lyrica.sidebar-width`); the grid holds it to 40 % of the
window (never under 248 px) and, beside the panel, to what leaves the
conversation 48ch. Below 760 px the sidebar and drawer become overlays, and the model picker
spans the screen. Touch screens get 44 px tap targets. The app is sized to the visual
viewport (`--vvh`, for iOS) and the page asks for
`interactive-widget=resizes-content` (for Android), so the composer stays
above the keyboard, and the login and unlock card scrolls. `public/manifest.webmanifest` makes it installable. Reduced motion
turns animations off.

## Checks

- `npm run typecheck` covers `web/` (`tsc -p web`), and `npm run build` builds
  it.
- `web/test/` has unit tests for the stream reducer (`live.test.ts`), memory
  links and word diffs, mentions, which paths become links, which code
  blocks get Copy and what it copies (`codeblock.test.ts`), a checklist's
  count and current step (`checklist.test.ts`), question card states and
  notification options (`question.test.ts`), the welcome cards' empty states,
  hidden sleep pools and backend presets (`cards.test.ts`), routine facts and paused
  schedules (`routines.test.ts`), the recorder's context
  fallback and clip limit (`voice.test.ts`), and a text model group's warn
  lines (`library.test.ts`), and flyout placement and hover intent (`flyout.test.ts`).
- `npm run e2e -w @lyrica/web` runs Playwright (after a build). The upload
  test needs `gocryptfs`, as `lyricad` does. The specs are
  `web/e2e/web-chat.spec.ts`, `web-projects.spec.ts` and `web-admin.spec.ts`,
  sharing `web/e2e/helpers.ts`, plus `setup.spec.ts`. Each runs its tests in
  order. Each project in `playwright.config.ts` (every `web-*` spec at phone
  390×844 with touch and at desktop 1280×800, and a desktop one for
  first-run setup, on ports 17341 to 17347, clear of `lyricad`'s own
  ports, which a sandbox can't reach even on its loopback) gets its own real `lyricad` from
  `web/e2e/serve.ts`, on a temporary runtime with a fake model server, which
  also serves a fake speech endpoint (whisper and kokoro, under `/speech/v1`,
  and `/speech/down` to make it fail). Its nightly sleep time is set half a
  day from its start, so no run reaches it. Chromium runs with a fake microphone.
- Push e2e checks cover Save, masked saved credentials across reload, Send a
  test, inline receiver failure and recovery, and Turn off at both widths.
  Browser API interception supplies the Push contract and forwards test
  POSTs only to a local fake receiver; daemon tests separately cover the real
  routes, validation, encrypted storage and sender. Phone targets and
  horizontal overflow are checked. `SCREENSHOTS=<dir>` saves
  `push-settings-1280.png` and `push-settings-390.png` with the failure line.
- Question-card e2e checks use the fake model's `ask:`, `ask twice:` and
  `start ask:` commands with the real daemon. At both widths they cover
  option taps, persisted collapsed cards, answers in words, Notifications,
  project-card answers and withdrawal on replacement and Resolve. They
  check phone target sizes and horizontal overflow. `SCREENSHOTS=<dir>`
  saves open, answered, Notifications and project-card views in that folder.
- For development, `npx tsx web/e2e/serve.ts 7340 7350` starts the same
  throwaway `lyricad` (passphrase `correct horse`, login `ada` / `pw`), and
  `npm run dev -w @lyrica/web` serves the UI with `/api` passed to it.
- `npx tsx web/e2e/shot.ts [page]...` (after a build) saves screenshots of
  ada's pages from that same throwaway `lyricad`, at both widths, light and
  dark (docs/workspace.md, "Her own code").

A project sandbox command card offers secondary **Always allow `<prefix>`**
between Allow and Deny, only when lyricad supplied `alwaysAllow`. It answers
with `alwaysAllow: true`; the prefix is never sent back. Commands uses the
existing segment and Remove icon (UX rules 2–3), its home in rule 6 and one
Save with validation in rule 7; rows wrap at phone width (rule 8).

Empty project chats show the welcome card (principle 1): Set up from recent
work, Add repository using the existing popover, and Make a plan (`POST …/plan`, one call) opening a
Plan thread, under a plain "Let's get to work!" line. Recent work uses the existing dialog, full screen on a phone,
with ten eligible same-pool threads ticked initially. Only the selection is
sent with the short setup message; lyricad adds the directions to that turn's context. Closing the dialog refocuses its button, and with no recent work it offers only Close. Fold in calls render suggestion rows, each loaded on its own (an unreadable thread drops its row); applied
rows disappear, and access losses appear under their titles. Fold in and Fold in all open a
confirm dialog (threads and their child threads, the losses with a "Give <project> access to these" checkbox that widens the project through its settings route before folding); the card's Cancel dismisses it in the browser.
Continue as project (C), beside Make project… with their distinct tooltips,
asks in a dialog, then opens the new project's settings. Draft Goal and Instructions populate their
fields without applying them; Save applies edits and Discard draft clears
the drafts. Model settings use the current preset API.

A project thread card shows a muted “No worktree: <reason>” line when a code
thread could not isolate a granted host folder (docs/ux.md §6, existing thread
card). A thread with repositories and no writable host folder shows none,
since it works in its own clones. This adds no control.
