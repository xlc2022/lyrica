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
  person), logs in as another, logs one out, or **Lock**s one. Logging in as a
  user who isn't linked signs the browser's users out first, and a short
  notice says so without naming them. Logging out says when the user stays
  unlocked because another browser still holds them.
- **Home:** the header reads "Lyrica 0.1.0 · b110619" (the version from
  `package.json`, the build from `LYRICA_BUILD` or the git commit; both
  come with `GET /api/state` once unlocked) with the date and time under it, then a greeting by the hour and a
  message box that starts a thread in General or Private with its first
  message.
- **Sidebar:** New thread (General or Private), Search (filters the list by
  title), Memory, the Sort menu, the thread list, and the user. The **Sort
  menu** ("Sort: By date ▾") has the sorts By date (sections Today, Yesterday,
  Previous 7 days, Previous 30 days, Older), Last activity, Start date, Title and My groups (one
  section per group with its count, then Not in a group, and a New group
  form), then the General, Private and Hidden checkboxes, then All threads,
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
  (R, inline), Move to group (M: the groups, Not in a group, New group… N),
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
  paths in their tooltip, and the granted machines' names in mono; at the
  right a Settings button. Below it the conversation and the composer.
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
- **Project settings page** (`…/p/<pool>/<project>/general` or `/memory`),
  sections at the left. **General**: Goal, the Paused and **Watching
  threads** switches (`watchThreads`; the tooltip says what a look does), **New
  threads** (Model, Thinking and Fallback the project's threads start with;
  "This chat's model", "This chat's fallback" follow the project chat), **This chat** (Model, Mode,
  Group, then **Folders** and **Machines**, the drawer's own two controls,
  then a **Thread settings** link that opens the project chat with its
  drawer showing, `…/t/<pool>/<thread>/settings`, for network, local-only
  and the other task models), and one Save, which patches the thread
  (`goal`, `paused`, `watchThreads` when it changed, `threadsModel`,
  `threadsThinking`, `threadsFallback`, `group`) and, when they changed, its
  settings (`grants`, `machines` among them); `lyricad`'s reason shows when
  it refuses. Every thread the project starts gets these folders and
  machines or fewer. A machine taken off here leaves the project's running
  threads at once, and their open views show it gone. A folder taken off
  doesn't yet: a thread that still holds it fails its next command or Files
  call with "isn't in the parent thread's folders" until its own folders
  are narrowed. **Memory**: the
  Instructions kept on the project page (2,000 characters, counted under
  the box), and a link to that page in the memory browser. Files and
  images come with the Files panel.
- **Thread settings drawer:** a model per task (each option says cloud or local first), local-only, the internet and
  Local services (localhost) switches (each following the user's default until
  changed), allowed hosts, folders from the allowed paths (read-only or
  read-write), **Machines** (the sandbox, always, then a switch per machine
  of the thread's pool; a granted machine that no longer exists keeps its
  switch so it can be taken off), the mode, the
  Web search and Images switches, "Do not log", rename, hide, and forget. `lyricad` validates every
  change and its reason is shown.
- **Subagents live inline**, not in the sidebar: see the `delegate` card
  under Chat. Opening a subagent's thread by link shows the same thing as
  its card: a link to its parent, its transcript and a message box, never
  the composer or settings.
- **Memory:** search filtered by pool, layer and User introduced; a memory
  with its lineage as links, edit (each edit a revision), history with
  restore, archive and delete; forgetting selected results as a topic; and
  adding a note or page, linked or free. Mention tokens show as current names;
  the editor shows them as `[[Name]]` or `[[Name:obj]]` and saves them back as
  tokens. A thread mention (`[t:<id>]`, `[e:<id>#<n>]`) in a memory's text or
  history shows as a link with the thread's current title, as in her
  messages.
- **Settings** (`src/Panel.tsx`): a page with its sections listed at the
  left (a scrolling row on a phone): Profile (name, pronouns, accent colour,
  monogram), Appearance (theme), Unlock and lock (saved credentials, stay
  unlocked after logout, and `lyricad`'s warning when the two contradict),
  Password, Your personas (linking a separate persona needs both passwords),
  Persona suggestions (edit, send on to the administrators, or drop),
  Endpoints with probe status, Model profiles (with the **Sleep fallback**
  switch above the profiles), Network (New threads: the default
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
- **Administration**, for administrators: Status (the server's network
  self-test, sleep time, start unlocked), Users with the administrator flag and
  their allowed folders, Sleep, Start unlocked (saving the `self.db`
  passphrase), Web access, and Persona changes that users sent on (who sent
  them, whether they edited them, and a confirmation when the file changed
  since). **Web access** has:
  - the mode: only this machine, the built-in Caddy, or a proxy elsewhere;
  - the hostname, with a hint that its DNS record points at the Tailscale address;
  - for the built-in Caddy: the Tailscale and LAN addresses to serve on, the
    DNS provider with its credential fields and its token-scoping hint, an
    an email for certificate warnings, and, under Advanced, testing with
    untrusted certificates (the status warns while it is on);
  - for a proxy: the address and ports to listen on, the proxy addresses,
    the certificate to pin, and a Caddyfile snippet;
  - the status of Caddy, the certificate, and the last certificate error.

  Applying waits as long as `lyricad` needs (a new hostname can take about 90 s)
  and shows the time so far.

## Chat

- Her messages are prose, rendered with `react-markdown`. Raw HTML is
  skipped, links open in a new tab, and images are never loaded: they show
  as a link with their alt text.
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
  (the count in mono) when her next turn messaged threads. It expands to the
  threads looked at and, for each thread she told, the thread and what she
  sent; those `threads message` calls fold into it instead of showing as
  cards. It is never the user's bubble, and nothing shows when the setting
  is off, since no look is sent.
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
  A call on a machine (`machine` on the request) leads with the machine's
  name in mono, says the folder the command runs in, and shows the command,
  path or Proxmox action and VM in mono; a suspect command (`suspect`,
  `warning`) adds its warning sentence above the command and a third,
  secondary **Allow in this thread**, which answers with `allowInThread`.
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
  The context meter, the stream's `context` events and a marker that expands
  to the summary are the Web UI 2 thread's.
- A message sent during a turn waits as a follow-up and shows as waiting.
  Stop aborts the turn; `lyricad` drops the waiting follow-ups, so their text
  goes back into the composer.
- `src/live.ts` turns stream events into the in-progress turn. When a turn
  ends, the stored messages are reloaded and the live copy is dropped.
  `EventSource` reconnects with `Last-Event-ID`. If it gives up, a new one
  can't send that header, so the UI starts again from the stored messages,
  and one request checks whether the login still holds. A `reset` reloads
  the stored messages, and so does every `hello` that finds the thread idle:
  a turn may have ended between fetching the messages and opening the stream,
  such as a child thread opened as its first turn ends.
- **Each message has a menu** (a bordered ⋯ icon button by the sender's
  name; `src/Rewind.tsx`): Pin or Unpin; Branch from here; on her replies Regenerate and
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
  tapped (Li, 2026-10-11: said elsewhere, it would clutter the chat); open,
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
  Web search, Internet for commands and Images switches; then the mic; at the right the
  mode, a link with a chevron that opens a menu of the four modes (a check on
  the current one, its line, its number key; a mode above a granted
  machine's limit reads "Asks on <machine>" in its line). Shift+Tab in the box cycles
  Ask, Accept edits, Plan, Auto, shown at once. Changes are saved one at a
  time in the order pressed, and a message sent meanwhile waits for them; a
  settings refresh that a change overtakes is dropped. A `settings` event (an approved plan)
  refreshes them.
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
  under Speech in Settings, Appearance. The Model profiles
  section has Read aloud rows in every profile and a Dictation row in Local
  only, and a speaking model
  in the Endpoints list has a Settings link opening its drawer: a voice per
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
- `web/test/live.test.ts` tests the stream reducer; `web/test/voice.test.ts`
  the recorder's context fallback and the clip's limit.
- `npm run e2e -w @lyrica/web` runs Playwright (after a build). The upload
  test needs `gocryptfs`, as `lyricad` does. Each viewport
  (390×844 with touch, 1280×800) gets its own real `lyricad` from
  `web/e2e/serve.ts`, on a temporary runtime with a fake model server, which
  also serves a fake speech endpoint (whisper and kokoro, under `/speech/v1`,
  and `/speech/down` to make it fail). Chromium runs with a fake microphone.
- For development, `npx tsx web/e2e/serve.ts 7340 7350` starts the same
  throwaway `lyricad` (passphrase `correct horse`, login `li` / `pw`), and
  `npm run dev -w @lyrica/web` serves the UI with `/api` passed to it.
