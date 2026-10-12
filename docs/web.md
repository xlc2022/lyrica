# Web UI

The browser interface to `lyricad`, in `web/`: React and TypeScript, built
with Vite into `web/dist`, which `lyricad` serves under its Content Security
Policy. It talks to the API in `daemon/src/api.ts` with `fetch` and one
`EventSource` per open thread, and imports only its types (and
`THREAD_TASKS`). It also imports `core/src/mentions.ts`, a pure function, to
render mention tokens.

## Pages

Routes are in the URL hash (`#/u/<user>/t/<pool>/<thread>`, `…/p/<pool>/<project>/<section>`
for a project's settings, `…/memory`, `…/settings/<section>`, `…/admin/<section>`,
`#/login`), so `lyricad` serves a single file. The old `…/panel` opens Settings.
A thread's address may carry what the panel beside it shows:
`…/t/<pool>/<thread>/panel/t/<pool>/<other>` or `…/panel/p/<pool>/<project>/<section>`.

- **Unlock** while `lyricad` is locked, then **login**. A browser holds one
  person's users: the user menu at the foot of the sidebar opens Settings and
  Administration, switches between linked personas (separate users of the same
  person), logs in as another, and has **Lock** and **Log out** for the
  current user. Logging in as a
  user who isn't linked signs the browser's users out first, and a short
  notice says so without naming them. Logging out says when the user stays
  unlocked because another browser still holds them.
- **Home:** the header reads "Lyrica 0.1.0 · b110619" (the version from
  `package.json`, the build from `LYRICA_BUILD` or the git commit; both
  come with `GET /api/state` once unlocked) with the date and time under it, then a greeting by the hour and a
  message box that starts a thread in General or Private with its first
  message.
- **Sidebar:** New thread (General or Private), Search (`src/Search.tsx`,
  "Search titles and messages": the list filters by title as it is typed;
  from 2 characters, 300 ms after the last key, `GET …/search` turns it
  into a group per thread in the order of their newest hit, the thread's
  row then up to three hits of up to two lines, each who wrote it and its
  time in mono (as a message shows it: HH:MM today, "11 Oct 14:32"
  otherwise, the full date as its tooltip) with the sentence and its
  matches marked, and "<n> more in this thread" to
  open the rest in place; after the groups, the threads whose title alone
  matched; **Show more** under a full page of 50; "Nothing matches." when
  nothing does; Escape clears it. A hit opens its thread at that message,
  loading older messages as needed, and marks it a moment, as the Pinned
  popover does; only the thread and the message number wait in session
  storage for a thread not yet open), **Notifications** with the count of decisions waiting (read with
  the thread list, every 30 seconds and on focus), Memory, the Sort menu, the thread list, and the user. The **Sort
  menu** ("Sort: By date ▾") has the sorts By date (sections Today, Yesterday,
  Previous 7 days, Previous 30 days, Older), Last activity, Start date, Title and My groups (one
  section per group with its count, then Not in a group, and a New group
  form), then the General, Private and Hidden checkboxes (Hidden's tooltip:
  "Hidden threads are left out of the list and of search."), then All threads,
  Only projects or No projects. The sort, the checkboxes and the projects
  choice are saved per user (`Display`). Pinned threads come first under a
  **Pinned** eyebrow, whatever the sort. A thread unread for this user
  is bold; private threads carry a small lock in the private colour; child
  threads (Lyrica's, branches, forks, copies) sit behind `›`, a child
  showing when it works or waits and a count of its unseen updates (at most
  two badges a row: waiting, then the count, then hidden).
- **Projects in the sidebar:** a project row has the project icon in the
  pool dot's place (amber-dotted when one of its threads waits on the user)
  and its threads nested under it, open by default, each with its pool dot,
  its state as a word (Working, Waiting on you, Waiting for approval,
  Queued, Idle) and its unseen count; resolved ones fold under a
  **Resolved** row with their count. The list's own menu (right-click or a
  long press on its empty space) has **New project** (General or Private:
  an empty, pinned project chat) and **New group…**.
- **Thread menu** (`src/ThreadMenu.tsx`): right-click a thread, or hold it
  for half a second on a touch screen. Mark as unread or read (U), Rename…
  (R, inline), **Share with** (S: the other users on this server, from
  `GET …/people`, linked personas marked; picking one confirms in a dialog
  that says the copy is as it is now, that later messages and memories
  don't go, and that the thread is private when it is; `POST …/share`;
  not on a project chat or a subagent's thread; a private thread's
  notification offers Add to Private only), Move to group (M: the groups, Not in a group, New group… N),
  **Pin** or **Unpin** (P, top-level threads), **Make project…** (K, a
  top-level thread; confirms in a dialog, since there is no way back),
  **Resolve** or **Reopen** (E, a project's thread), Hide or Unhide (H), and
  Delete… (D), which confirms in a dialog and offers
  to delete child threads too. From the keyboard, Shift+F10 or the Menu key
  on a focused thread opens it under the row; the arrows move between items
  and Escape closes it. The user menu works the same way. Groups and unread marks are
  the user's own (`thread_groups`, `thread_prefs` in `user.db`); opening a
  thread clears its unread mark.
- **Hidden pools:** with Show general or Show private off, a thread or
  memory from that pool shows "General is hidden" or "Private is hidden"
  instead, and memory search leaves the pool out.
- **Thread:** a header with the title; under it the pool word, the model
  badge (cloud or local, model and endpoint; it opens the model picker), the
  thread's group as a link that changes it, the folders as words with the
  paths in their tooltip, and the granted machines', repositories' and MCP
  servers' names in mono; at the right a Settings button. Below it the conversation and the composer.
  After the group, **Context** and the percent (`src/ContextMeter.tsx`)
  open a popover of the parts, the reserve and what's free, when measured,
  and the last turn's speed. It reads `ThreadSettings.context` and then each
  `context` stream event, so it follows every turn without a reload. After
  a rewind or a reset it is hidden until the next turn measures again.
- **Project chat** (`src/Project.tsx`): the facts line adds **Threads** with
  the count, opening a popover of the project's threads grouped Waiting on
  you, Working, Queued, Idle and Resolved (each a link, with its unseen
  count), and the project's tokens ("65 tokens", "312k tokens"; on a phone the tokens
  are the popover's first line instead). The header has a **Project**
  link to the project settings page before the Settings button, which
  opens the thread's drawer as in any thread. The
  `child` stream event reloads the overview (`GET …/overview`) and the
  thread list, so cards and state words follow. A resolved project thread
  has a **Reopen** link where its message box was.
- **The panel** (`Shell.tsx`, docs/ux.md §6): from 1180 px up, a link in a
  conversation to a thread or a project's settings (a thread card, a mention,
  the Threads popover, the header's Project link) opens it in a third column
  instead of navigating, and the address gains `/panel/<its path>`; the
  sidebar's rows navigate as before, and so does a modified click. The column
  is 360 to 520 px (420 to start), dragged on its divider (a `separator`
  that the arrow keys move too), the width kept in `localStorage`
  (`lyrica.panel-width`). A link inside the panel replaces what it shows and
  the breadcrumb above its title grows (each crumb goes back to that page);
  a link to the conversation's own thread closes the panel (the Thread
  settings link opens the drawer). The page in the panel is the same
  component as on its own, rooted in a block instead of `main`, and its
  header gains **Open as a page** (a link to the page's own address) and **Close panel**; Esc closes
  it, and focus lands on its heading each time it shows something else. The
  panel is `role="complementary"` named by its breadcrumb. Below 1180 px the
  same address shows the panel's page on its own.
- **The Files panel** (`Files.tsx`, docs/ux.md §6): **Files** in a thread's
  header is a link to `…/t/<pool>/<thread>/files`, which the split view opens
  in the panel column (and the same link closes it); below 1180 px, or on a
  phone, it is the page. `…/files/<encoded path>` opens with that file shown
  and its folders open (a folder: opened), or says it is gone. Files lists one folder at a time from
  `GET …/files?dir=` (docs/daemon.md "Files"), the thread folder open at the
  start and each grant after it; a search runs under every root; a file
  fetches `…/files/content` once and shows images as themselves, text (up to
  512 KB) as text, and anything else by its size with Download. Images lists
  `…/files/images`, filtered by source, and opens one large in a dialog.
  The right-click menu (a long press, or the ⋯ beside a shown file) attaches
  (the path goes into this thread's message box through a window event, or
  waits in session storage when the page has no box), selects, shows in the
  thread (the conversation scrolls to the first message naming the path, an
  upload or her call that wrote it, through the same channel), downloads (one file by its address, several as `…/files/zip`), copies
  paths, renames and deletes (a confirm dialog), uploads and makes folders;
  dropping files on the panel uploads them to the folder last opened. After a
  change the folders it touched are reloaded. The grid shows each image's
  thumbnail (`…/files/thumb`, docs/daemon.md "Files"), or the image itself
  where the server makes none.
- **Project settings page** (`…/p/<pool>/<project>/general` or `/memory`),
  sections at the left. **General**: Goal, the Paused and **Watching
  threads** switches (`watchThreads`; the tooltip says what a look does), **New
  threads** (Model, Thinking and Fallback the project's threads start with;
  "This chat's model", "This chat's fallback" follow the project chat), **This chat** (Model, Mode,
  Group, then **Folders**, **Machines**, **Repositories** and **MCP
  servers**, the drawer's own controls,
  then a **Thread settings** link that opens the project chat with its
  drawer showing, `…/t/<pool>/<thread>/settings`, for network, local-only
  and the other task models), and one Save, which patches the thread
  (`goal`, `paused`, `watchThreads` when it changed, `threadsModel`,
  `threadsThinking`, `threadsFallback`, `group`) and, when they changed, its
  settings (`grants`, `machines`, `repositories`, `mcpServers` among them); `lyricad`'s
  reason shows when it refuses. Every thread the project starts gets these
  folders, machines and repositories or fewer. A folder, machine or
  repository taken off here leaves the
  project's running threads at once, and their open views show it gone. **Memory**: the
  Instructions kept on the project page (2,000 characters, counted under
  the box), and a link to that page in the memory browser. Files and
  images come with the Files panel.
- **Thread settings drawer:** a model per task (each option says cloud or local first; **Watching threads**, under
  Titles, only in a project chat), local-only, the internet and
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
  Web search and Images switches, the Claude Code switch (only where
  `claudeCodeOffered`, or while on), "Do not log", rename, hide, and forget. `lyricad` validates every
  change and its reason is shown.
- **Subagents live inline**, not in the sidebar: see the `delegate` card
  under Chat. Opening a subagent's thread by link shows the same thing as
  its card: a link to its parent, its transcript and a message box, never
  the composer or settings.
- **Memory** (`src/Memory.tsx`, `src/memory.ts`; [memory.md](memory.md), The
  memory browser): a notebook. The browse pane lists one layer (Pages, Notes,
  WAKE, Journal) newest first, filtered by pool and User introduced, with
  tags for notes; a search replaces the list. The memory at the right shows
  its citations as titles with a hover preview (`linkCitations` turns each
  citation into a link whose word comes from `MemoryDetail.links`; the raw ID
  is never shown), Came from and Used in with the citing sentence, History as
  word differences (`wordDiff`, computed in the browser) with Restore, and
  Edit in place with a `[[` popover of pages and people (a page shows as
  `[[Title]]` and saves as `[p:<slug>]`). Archive, Delete, Forget… on a
  selection, and Add a memory. `…/memory/<pool>/<id>` is a memory on the
  page; `…/t/<pool>/<thread>/panel/memory/<pool>/<id>` is the same memory in
  the panel beside a conversation, where recall markers and citations open
  it; the panel is named Memory, and a memory followed from it adds its title
  to the breadcrumbs. The lineage names the memory being read as itself, never
  as gone. Mention tokens show as current names; the editor shows them as
  `[[Name]]` or `[[Name:obj]]` and saves them back as tokens. Nothing of a
  memory's text is kept in the browser's storage.
- **Sleep** (`src/Sleep.tsx`; [sleep.md](sleep.md) "Sleep in the UI";
  docs/ux.md §6 "What she did at night"): `#/u/<user>/sleep`, from the
  sidebar's Sleep link, whose badge counts her new items (`GET …/sleep`,
  reread every 30 s, on focus and after each action; while the page is open
  `GET …/sleep/events` reloads it as a run starts, changes phase or ends,
  and a `thread` event opens the thread a manual run leaves). Items first,
  newest first, with **Start a chat** (`POST …/items/<id>/chat`, then the
  new thread) and **Dismiss** (`DELETE`). Then the runs: **Last night** is
  the newest run of each pool, read at once for its summary line; **Earlier**
  groups the rest by day and reads a run when its row opens
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
- **Models** (`src/Models.tsx`; [models.md](models.md); docs/ux.md §6
  "Models, hosts, downloads, clean-up"): `#/u/<user>/models[/<tab>]`, from
  the sidebar's Models link, whose badge counts Clean up's items
  (`GET …/models/cleanup`, reread every 30 s and on focus; nothing probes
  an endpoint until the area is open). Tabs down the left (a scrolling row
  on a phone), so far **Overview**, **Tasks**, **Hosts and endpoints**,
  **Clean up** and **Recent calls**; Text models, Image models and Downloads
  come with their own PRs. The area reads `GET …/models/page` while open (30 s,
  focus), which probes each endpoint (3 s each, one seen down in the last
  30 s not asked again). Overview: a banner for a paused host or a stale
  endpoint; tiles Endpoints (n of m up), Backend (the first `chat` model of
  the general profile and of Local, following Same as; links to Tasks)
  and Clean up; then the hosts and endpoints
  summary (a host with its combined VRAM bar, Pause or Resume, Dashboard;
  a plain endpoint with its model count) and the first five calls. Hosts
  and endpoints: **Add endpoint** (a drawer: Name, Kind, Base URL, API key,
  Shared for administrators; a plain-HTTP warning for a local URL off
  loopback and the tailnet. Kind also offers ChatGPT plan, with **Sign in with
  ChatGPT**, which opens OpenAI's page in a new tab, then **Redirect URL**
  and **Finish** in place of the URL and key; and Grok plan, with **Sign in with Grok**, which opens
  xAI's page, then its **Code** and **Finish**; closing the drawer cancels
  the sign-in) and **Add model host** (the one primary; a page
  at `…/models/hosts/add-host`: Name, Addresses, Pairing code, Shared,
  **Pair**, then the fingerprint in mono). A host card: name, kind, state
  (Online, Paused, Pausing, Restarting, Unreachable with the duration),
  Pause or Resume (administrators on a shared host; disabled with "Nothing
  is loaded"), Dashboard (`GET …/dashboard`, a new tab), "N models"
  opening its model list (a speaking model's **Settings** there), the facts
  line (shared or only you, paired, ID and addresses in mono, **Edit** for
  the addresses, `PUT …/addresses`), per GPU its card, used/total in mono,
  a bar of pinned, loaded-on-demand and vLLM-share segments, the loaded
  models and the queue when nonzero. A plain endpoint row: name, kind,
  ChatGPT plan or Grok plan, unencrypted and stale pills, URL, shared or only you, ID, state, "N
  models", **Edit** (the same drawer; API key "leave blank to keep",
  Remove key; a plan's drawer has Name only). A plan whose sign-in lapsed
  reads **Signed out**. Each row's ⋯: Sign in again (plans), Read its models, Add a model by hand, Pair
  again… (hosts), Reset IDs…, Merge into… (same kind and sharing), Remove,
  the last three confirmed by a dialog. Clean up: a row per item with a
  stale, gone or empty pill, "Unreachable for N days." / "Missing for N
  days." / "No members left.", where it is used or "Nothing uses it.",
  **Replace with <model · endpoint>** when the server suggests one and
  **Remove**; the notice lines as a dashed note with Dismiss. The
  thresholds are the pills' tooltips (stale: unreachable 14 days or more;
  gone: missing 30 days or more), and Replace with… carries the redirect
  sentence as its tooltip. Recent calls: Time (mono), Thread (a link; private
  kind mark; "a forgotten thread" when gone), Task, Answered by ("model ·
  endpoint"), Note (the fallback or note, warn text); hidden pools left
  out; the table stacks on a phone. Tasks (`GET …/profiles`, the former
  Settings → Model profiles): a table of every task (grouped Conversation,
  Memory, Sleep, Images, Speech, with a hint under each name) by profile,
  **Private threads** (Local) and **General threads** (the default profile;
  **Use Custom instead** in its head sends `PATCH …/profiles`; **Show
  Custom too** adds the third column). A cell shows the first model with
  its state dot (up; away when only a later entry can answer; down when
  none can), then "+N fallbacks", "no fallback" (warn) or "= Chat" for a
  task following another; Dictation has a cell under Private threads only.
  A cell opens the task's drawer: **Its own list** or **Same as** a task of
  the same kind (**Task to share with**; a task with followers can't
  follow), the ordered list with Move up, Move down and Remove (in Custom,
  "Falls back to cloud from here" where the kind changes), and **Add…**, a
  picker with a search box, group chips and only models the task can use;
  each change is a `PUT …/profiles/<profile>/<task>` at once, a refusal
  shown as an error line. Settings → Sleep holds the Sleep mode select and
  Sleep fallback; `…/settings/profiles` goes to the Tasks tab.
- **Notifications** (`src/Notifications.tsx`; docs/ux.md §6 "Anything
  waiting for the user"): the first section of Settings, one list from
  `GET …/notifications`. Chips filter by type (All with the count, Needs a
  decision, then the types that exist now); Sort offers Newest first,
  Oldest first, By type and By pool (the last two group the rows under eyebrows); Where
  narrows to a pool. Each row has its kind, pool and time, Open thread or
  Open where the item leads, and its actions as buttons (an action that
  answers with a thread goes there). Checkboxes select rows for the bulk
  bar: a button for each action every selected row shares, with the count
  (Add to Private 2, Decline 2), and none when they share none. Twenty rows at a time, with
  Show more. The welcome page shows the first four decisions in a card
  with All N.
- **Set up Lyrica** (`src/Setup.tsx`; docs/ux.md §6 "Setting her up";
  [briefs/web-bootstrap.md](briefs/web-bootstrap.md)): while
  `GET /api/state` says `setup`, this page stands where the unlock page
  would. One card, steps as sections with eyebrows: Code and passphrase
  (the code from the journal or `lyrica admin setup-code`, the passphrase
  twice, **Start unlocked** when `State.credentials` allows it, else the
  reason), her name, Administrator (login, password, name, pronouns);
  **Create** posts `/api/setup` and the page continues signed in as that
  administrator: Tailnet (the state, an Auth key with Hostname and Advanced →
  Control server, **Connect**, then a **Web access over the tailnet** switch
  applied on Continue; or Skip), Models (one endpoint, shared, its first
  chat model set for the profile; or Skip), Done (the addresses to open her
  at with the fingerprint, the administrator's login, the tailnet, and a
  sentence when she starts locked), **Start a chat**. The current step's
  button is the one primary; a done step's turns secondary; the fields of a
  done step stay editable until Create. A wrong code says so at Create and
  counts on the unlock limiter; too many say to wait a minute.
- **Settings** (`src/Panel.tsx`): a page with its sections listed at the
  left (a scrolling row on a phone): Notifications, Profile (name, pronouns, accent colour,
  monogram), Appearance (theme), Unlock and lock (saved credentials, stay
  unlocked after logout, and `lyricad`'s warning when the two contradict),
  Password, Your personas (linking a separate persona needs both passwords),
  Persona suggestions (edit, send on to the administrators, or drop),
  Sleep (the **Sleep** mode select and the **Sleep fallback** switch;
  model profiles moved to Models → Tasks and endpoints to Hosts and
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
  **Claude Code** (`src/ClaudeCode.tsx`), after MCP servers: a Token field
  and **Save token** (`PUT …/claude-code`), or once saved Signed in and
  **Remove** (`DELETE`), confirmed in place; Not installed when the server
  lacks the program. The token is never sent back.
- **Administration**, for administrators: Status (the server's network
  self-test, sleep time, start unlocked), Users with the administrator flag,
  **Change password…** (the new password and the administrator's own, in
  the row; the user's data stays, they are logged out and told at their
  next visit) and their allowed folders, Sleep (**Sleep time**, `type="time"`, one Save;
  `GET`/`PUT …/admin/sleep`), Start unlocked (saving the `self.db`
  passphrase), **Tailnet**, Web access, **Web search** (`src/WebSearch.tsx`:
  **SearXNG address** in mono, without its password (a basic-auth password
  is kept when the user@host is unchanged), one Save, and Reachable or Unreachable as a
  dot and a word, what failed as its tooltip; `GET`/`PUT …/admin/web-search`),
  **Updates**, and **Persona**: her
  **Name** at the top (one field, Save, and the sentence that memories and
  threads written so far keep the old name; `PUT …/admin/name`, then the
  page re-reads `/api/state`), then the persona changes that users sent on
  (who sent them, whether they edited them, and a confirmation when the file
  changed since). Her name (`src/name.ts`, `her()`) is what every label,
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
  date, Running) with **Roll back** in the row's ⋯, asked in a dialog that
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

## Chat

- Her messages are prose, rendered with `react-markdown`. Raw HTML is
  skipped and links open in a new tab. A path under `/workspace`, in her
  prose or the person's message, is a link to `…/files/<encoded path>`,
  which shows the file in the Files panel (`paths.tsx`; a code block is left
  as written). An image she writes from the thread folder shows in the
  message by its thumbnail (`…/files/thumb`, or the image itself where the
  server makes none) and opens large, from `…/files/content`, in the
  Images tab's dialog; the conversation holds which image is open, so the
  stored copy replacing a live message doesn't close it (an SVG stays a link, since `…/files/content` serves it as text, never as a page); a remote image is never loaded and shows as a link with its
  alt text. A fenced code block has a strip along its top edge with the
  fence's language and **Copy**, which writes the block's text to the
  clipboard (`navigator.clipboard`, `CodeBlock.tsx`) and reads **Copied**, or
  **Copy failed** where the browser refuses, for 2 s; inline code, tool
  results, the permission card, the Files viewer and the Machines page's
  setup block have none.
- A thread she mentions (`[t:<id>]`, `[e:<id>#<n>]`) shows as its current
  title, linked to the thread in the same tab; "a forgotten thread" once it's
  gone. Titles are fetched per thread and kept for 30 seconds, so a rename
  shows on the next look. This covers her prose, the notice cards, the task
  or message on a delegate or threads card, what a parent thread sent its
  child, and a subagent's task. Where a link can't go (the pinned list, a
  failed tool call's message) the title shows as plain text.
  The user's sit in a tinted block.
- Thinking, recalls, saved notes and tool calls are one-line markers that
  expand when tapped. An expanded tool call stays open when the turn ends
  and the stored copy replaces the live one.
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
  `threads`). Each expands to its work: the stored transcript, read-only,
  where each message says who sent it (Lyrica, the user by name, or the
  subagent's own work), reloaded as the subagent works; its waiting
  approvals; and a message box that writes to it as the user (Lyrica is
  told). What a run delivers later (a result, a question, a note, or what
  someone wrote to a subagent), as a `notice` event and stored as a
  `notice` message, shows as a card headed by what it is, linking to the
  subagent.
- Permission requests appear inline with Allow and Deny and the time left.
  Her `models` tool's proposal is worded as its question ("Serve
  Qwen3.8-27B with 1,010,000 tokens of context? It reloads, and its KV cache
  grows to 17 GB."), the numbers in mono.
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
  sent, until a turn starts.
- A stored compaction shows as a one-line notice, **Compacted · 41k → 6k**.
- A message sent during a turn waits as a follow-up and shows as waiting.
  Stop aborts the turn; `lyricad` drops the waiting follow-ups, so their text
  goes back into the composer. A message from another thread or a look
  never waits there: it shows where it reached the turn (`received`).
- `src/live.ts` turns stream events into the in-progress turn. When a turn
  ends, the stored messages are reloaded and the live copy is dropped.
  `EventSource` reconnects with `Last-Event-ID`. If it gives up, a new one
  can't send that header, so the UI starts again from the stored messages,
  and one request checks whether the login still holds. A `reset` reloads
  the stored messages, and so does every `hello` that finds the thread idle:
  a turn may have ended between fetching the messages and opening the stream,
  such as a child thread opened as its first turn ends.
- **Each message has a menu** (a bordered ⋯ icon button by the sender's
  name; `src/Rewind.tsx`): Pin or Unpin; Remember this (a labelled field
  under the message, prefilled with its first line, whose Remember button
  writes a user-introduced note in the thread's pool citing the message;
  `RememberBox` in `src/Messages.tsx`);
  Branch from here; on her replies Regenerate and
  Regenerate with… (the models the thread may use); on the user's messages
  Edit, which turns the message into a box (Save, Cancel) whose text is sent
  in its place; Delete on the messages of the last turn, and Delete from
  here on earlier ones, both in danger text. Removing turns hides them at
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
  event drops the removed messages from every open view. A new branch opens,
  under "Branched from" its parent, and its settings can be changed within
  its parent's.
- **A message's header line** (`.who.sent` in `Messages.tsx`) reads the
  sender's name, for hers the model, then the time it was sent, then the
  "pinned" badge and the actions (Read aloud, React, ⋯). The time is a
  `<time>` in mono, muted like the model: `wakeTime`'s HH:MM today and
  "11 Oct 14:32" otherwise, with `fullTime`'s weekday, date and 24-hour
  time in the reader's locale as its tooltip ("Monday, October 12, 2026 at
  14:32" in en-US; `ui.tsx`). It comes from the stored message's
  `createdAt`, so a reply that is still streaming (or a message waiting to
  go) has none until its stored copy replaces it. Markers keep their own
  lines and show no time; there are no day dividers. The line never wraps:
  the name and model are the one item that shrinks (`min-width: 0`, an
  ellipsis, the model whole in its `title`), while the time and the actions
  keep their size, so on a phone a long model name loses its tail.
- **Reactions** (`src/Reactions.tsx`; the picker styles its shadow root
  inline, so lyricad's CSP allows inline styles, scripts stay `'self'`): a React button (a face with a plus)
  beside each message's ⋯ opens a quick row (🙏 👍 ❤️ 🎉 👀 🚀, tooltips
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
- A `threads` call is a card: the child thread started (title and task) or
  messaged, linking to it. A child's update shows in the parent as a card
  headed "Child thread", linking to it. **In a project chat** there is no
  card per start or update: each of the project's threads gets one card
  under the message that started it (its anchor; threads whose anchor is
  gone sit under the last message), updated in place from the overview:
  title, state as a dot and word (Working blue, Waiting amber, Resolved
  green, Idle plain), the first line of its last update beneath, and Open,
  Stop, Resolve or Reopen behind ⋯. A card waiting on the user carries
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
  **Show more**. Forgetting a thread with child threads asks
  whether to forget them too, ticked, in the shared `Confirm` with one option.
- Files attach from the "+" menu, by dragging onto the composer, or by
  pasting. Each shows its progress, and its path in the thread goes into the
  draft.
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
- **Read aloud** is a bordered speaker icon button in her message's actions,
  before ⋯, that plays lyricad's PCM stream for that message
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
  under the task models, following the user's default until changed (Use
  default goes back); tooltip "When off, only the first model in each list
  answers; if it can't, the message waits for it."
- **Dictation** and **Read aloud** are selects in the thread settings
  drawer's Models section, under Titles, offering only models that
  transcribe or speak; "Profile (…)" names what applies without a pick
  (for Dictation, always the local profile's). A cloud pick for Dictation
  first asks in a dialog naming the model (Use cloud dictation or Cancel);
  confirmed, it is what sends that thread's voice to the cloud.
  **Read aloud while agent writes** (`Profiles.readAloudLive`) is a switch
  under Speech in Settings, Appearance. Models → Tasks has a Read aloud
  row in every profile and a Dictation row under Private threads only, and
  a speaking model
  in an endpoint's model list (Models → Hosts and endpoints, "N models") has
  a Settings link opening its drawer: a voice per
  language (English, Mandarin) and the speed (a number, of 4, clamped when
  the field is left), each with its source word (shared or yours) and a
  Reset link.
- **The plan card:** a `propose_plan` request shows "Plan", its step count
  when it has numbered or bulleted steps, the plan as prose, a primary
  "Go ahead in…" whose menu offers Ask, Accept edits or Auto, Keep planning,
  and the time left. Its tool marker stays hidden until it is answered.
- **Waiting for an answer:** when the latest card waiting for her answer (a
  plan or an approval) has scrolled out of view, a thin accent bar across the
  top of the conversation says "Plan waiting for your answer" (or
  "Approval…") and scrolls to it.

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

Below 760 px the sidebar and drawer become overlays, and the model picker
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
  blocks get Copy and what it copies (`codeblock.test.ts`), and the
  recorder's context fallback and clip limit (`voice.test.ts`).
- `npm run e2e -w @lyrica/web` runs Playwright (after a build). The upload
  test needs `gocryptfs`, as `lyricad` does. Each project in
  `playwright.config.ts` (phone 390×844 with touch, desktop 1280×800, and a
  desktop one for first-run setup) gets its own real `lyricad` from
  `web/e2e/serve.ts`, on a temporary runtime with a fake model server, which
  also serves a fake speech endpoint (whisper and kokoro, under `/speech/v1`,
  and `/speech/down` to make it fail). Chromium runs with a fake microphone.
- For development, `npx tsx web/e2e/serve.ts 7340 7350` starts the same
  throwaway `lyricad` (passphrase `correct horse`, login `ada` / `pw`), and
  `npm run dev -w @lyrica/web` serves the UI with `/api` passed to it.
- `npx tsx web/e2e/shot.ts [page]...` (after a build) saves screenshots of
  ada's pages from that same throwaway `lyricad`, at both widths, light and
  dark (docs/workspace.md, "Her own code").
