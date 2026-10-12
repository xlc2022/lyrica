# Lyrica's interface: the rules

Read this before changing anything a user sees: the web UI, a mockup, a
dashboard page, a notification's wording. It exists because interfaces drift
one addition at a time. Each rule is checkable; a reviewer applies them as a
list, and a PR that breaks one isn't done.

The thesis: **the conversation comes first, and everything else is quiet,
familiar and in its one place.** When a rule here and your idea disagree, the
rule wins. When no rule covers your case, stop and ask the design thread
before building; don't guess and add.

## 1. Before you add anything

Work through these in order. Most additions end at step 1 or 2.

1. **Does it already have a home?** Section 6 lists where every kind of thing
   lives. Put yours there. A new control somewhere else, a new row of
   buttons, a new panel or a new page needs the design thread's agreement
   first.
2. **Is it a fact, a state or an action?** Facts go in the line beneath a
   name, in plain text. State is a badge or a dot with a word, at most two
   per row. Actions are buttons, links or menu items, and look like it.
3. **Does it work on a phone?** At 390 px wide, with no sideways scrolling,
   and with a long press where a desktop right-clicks.
4. **Does it use what's already there?** The icon set, the three button
   looks, the segmented control, the drawer, the context menu, the
   confirmation dialog. A new widget is a design change, not a feature.

## 2. Look

- **Calm and plain.** Colour comes from the user's accent; nothing else is
  coloured for decoration. Light or dark follows the device.
- **Type:** IBM Plex Sans for text, IBM Plex Mono for every number, size,
  time, path and address, with tabular figures. Served by `lyricad`, never
  fetched from elsewhere; system fonts as fallback.
- **Sizes, and no others:** 22 (page title), 15 (chat body), 14 (admin
  body, row titles), 13 (meta, tables, small buttons), 12 (captions), 11
  (uppercase section eyebrows, 0.06 em tracking). Nothing smaller than 11.
- **Headings:** one `h1` per page, never repeated as a card heading below
  it. Section heads are 15/600. A page header states facts (counts, status),
  not what the page is for.
- **Icons:** one family of 16 px line icons. Never a text glyph (☰ ⚙ ▤ ◔ ▣)
  standing in for an icon. An icon sits beside its word; a row of icon-only
  buttons has `aria-label`s and a border on each. The one exception is the
  message box: its "+", the mic and Send are plain icons, because the box is the
  border.
- **Spacing:** a 16 px gutter on phones; cards and drawers share one radius.

## 3. Controls

Three looks, and no more:

| Look | When | How it looks |
|---|---|---|
| **Primary** | the one main action on a screen, drawer or dialog | filled accent, 600 weight. If two things want it, neither gets it |
| **Secondary** | every other action, including Cancel and Delete (Delete in `--danger` text) | 1 px border, panel background |
| **Link** | going somewhere, revealing more of a list, or opening one thing's settings or picker | accent text, underline on hover, a caret ▾ when it opens a menu |

Rules:
- Nothing pressable is plain grey text, ever.
- A thing you press is a **button** when pressing changes something here, a
  **link** when it takes you somewhere, a **menu item** when it is one of
  three or more rare actions on a row, or destructive and must not sit next
  to the common action.
- At most two visible actions per row; the rest go behind ⋯ at the row's end.
  Settings reached often are a **link in the thing's own line**, never a
  button on every row.
- A **segmented control** picks one of two to four views of the same data
  (Sampling | Serving, Files | Images, All | Uploaded | Made by Lyrica).
  Never for navigation between pages.
- Heights: 36 px on pointer devices, 44 on touch; small buttons in rows 30 px
  with 13 px text. A segmented control cannot shrink below its buttons.
- A badge that opens something carries a caret ▾. A badge that doesn't,
  doesn't.
- Keyboard: a context menu's items have letter shortcuts; Escape closes the
  topmost thing (selection, then menu, then panel).

## 4. Words

- **Labels are short nouns** (Sampling, Serving, Pinned, Excluded, Memory,
  Template, Group, Notifications, Backend) or the words a person would say
  (Not this model, Start a chat, Read aloud). Never a description of what the
  thing does ("How it's served"), never a sentence as a label.
- **No explanatory captions** under headings, in page headers, at the foot
  of a form, or beside a control. Where a word needs explaining, the
  explanation is a tooltip on that word.
- **A sentence appears only where an action has a consequence**: deleting,
  sharing, replacing, anything that leaves the server. It says the
  consequence, not the concept: "Its messages are deleted, and so are the
  memories that came only from it."
- **Facts, not reassurance.** "Online", "2 GB free", "Paused since 20:38".
  Not "Everything is fine", not "Loading your models…".
- **Names in use** (don't invent synonyms): General and Private (pools),
  Hidden, Notifications, Backend, Models, Tasks, Text models,
  Image models, Hosts and endpoints, Downloads, Clean up, Recent calls,
  Model hosts, Plain endpoints, Add endpoint, Add model host, Pairing code,
  Pair, Pair again…, Dashboard, Pause, Resume, Read its models, Add a model
  by hand, Reset IDs…, Merge into…, Replace with, All details, All calls,
  Answered by,
  Settings, Administration, Files, Images, Thread folder, Attach to message,
  Download, Download as zip, Copy path, Show in thread, Upload…, New folder…, Uploaded,
  Made by Lyrica, Search files, Pinned, Branch, Regenerate,
  Share with, Send a copy, Needs a decision, Shared with you, Add to General,
  Add to Private, Decline, Dismiss, Select all, Everywhere, By pool, By type,
  Newest first, Oldest first, Open thread,
  Move to group, Change password…, Change password, Sampling, Serving, Placement, Memory,
  Throughput, Template, Pinned, Excluded, Servers, Keep free, Not this
  model, Group, Add…, Reset, Dictation, Dictate, Read aloud, Stop reading,
  Read aloud while agent writes, Local services (localhost), Fallback, Sleep fallback, Sleep, Sleep now, Start a chat, Last night, Earlier, Questions, Skipped, Stopped early, Nothing changed, Sleeping…, Thoughts, Dream, Sleep time, Nightly at, Only when I ask, Voice, Speed, Pin, Unpin, Project, New project, Make project, Project settings, Thread settings, New threads, This chat, Threads, Watching threads, Checked the other threads, Message received from, Show more, Show less, Open as a page, Close panel,
  Start a thread, Suggested threads, Start all, Resolve, Reopen, Resolved,
  Memory, Pages, Notes, WAKE, Journal, User introduced, Add a memory, Came
  from, Used in, History, Restore, Archive, Preview, Edit, Remember this,
  React, React with, More emoji, Reactions,
  Waiting on you, Goal, Instructions, Paused, All threads, Only projects,
  No projects, Machines, Add machine, Mode limit, Replace key, Use anyway,
  Git accounts, Add account, Kind, Host, Account, Token, Replace token, Save
  token, Repositories, Add repository, Signed in, Token rejected,
  Allow in this thread, Online, Unreachable, Key changed, Off network,
  Updates, Update, Roll back, Running, Updating, Draining, Building, Testing,
  Probation, Set up Lyrica, Persona, Tailnet, Connect, Disconnect, Leave,
  Stay, Auth key, Hostname, Control server, Skip, Remove,
  Use a host outside your network?, Add anyway, Save anyway, Keep, Look up.
- Numbers get units beside the field (GB, %, tokens), and a maximum shown
  where one exists ("of 128k").

## 5. State and badges

- **Badges carry state only**, never facts. At most two per row. State is
  what changes: Online, Paused, New, Stale, gone, parts missing, a fallback
  in use. Quantisation, context, "shared", "vision" are facts and go in the
  line beneath the name.
- **Status is a dot and a word**, 8 px dot, four colours used identically
  everywhere: green ok, amber warning, red problem, blue information. The
  word says why: "Unreachable 16 days".
- Counts that need attention are the accent-coloured round count used in the
  sidebar; the same shape everywhere.

## 6. Where things live

| Thing | Its home |
|---|---|
| A thread's title, pool, model, group, folders, pins | the thread header: title, then **one line of facts** with the model picker as the only chip, then **two actions**, Files and Settings. One state badge at most |
| Picking a model, a group, a pinned message | a popover from its word in the facts line |
| A thread's own files and images | the **Files** panel: **Files** in the thread header opens it in the panel column (the page on its own below 1180 px), with **Files** and **Images** as a segmented control in its header. Files: a search box, then the tree, one folder at a time, **Thread folder** first and each granted folder after it with `rw` or `ro`; a file shows beside the tree, or in its place when the column is narrow (a **Files** back button returns). Images: All, Uploaded, Made by Lyrica, and a grid that opens an image large. Every action is in the **right-click menu** (a long press on a phone, or the **⋯** beside a shown file): Attach to message, Select, Show in thread, Download, Copy path; Rename… and Delete… where the folder is writable; Upload…, New folder… and Download as zip on a folder. Ctrl- or Cmd-click and Shift-click select several; a bar at the foot names the count with the selection's ⋯. Dropping files on the panel uploads them to the folder last opened. Delete is confirmed by a **dialog** named after the file ("Delete plan.md?") with its one sentence, which in a grant says the file is your own, not a copy |
| A file or image named in a message | a path under the thread folder, in her prose or the person's message, is a **link** that opens the file in the Files panel with its folders open (a command in a code block stays as written); an image she writes from the thread folder shows **in the message** as its thumbnail, at most 320 px tall, and opens **large** in the Images tab's dialog; a remote image stays a link with its alt text |
| Anything looked at without leaving a conversation (a thread from its card, a mention or the Threads popover; a project's settings from the chat's header) | the **panel**: a third column from 1180 px up, 360 to 520 px wide (420 to start), dragged on its divider, the width kept per browser. One panel; a link inside it replaces what it shows and the breadcrumb above its title grows. Its header is the page's own with **Open as a page** and **Close panel** as icon buttons at the end; Esc closes it. The divider takes focus and shows itself on hover. Below 1180 px the same address is the page. The sidebar's rows, Search and the welcome page navigate |
| Editing one thing in context (a task's list, a model's settings, a GPU's settings) | the **drawer** on the right, sections with eyebrows, one Save at its foot when saving has a consequence |
| Confirming an action with a consequence | a **dialog** with the sentence and two buttons. Dialogs confirm; they never hold forms or flows |
| A flow with steps (download a model, pair a host) | a **page** with its own address, never a dialog |
| Actions on a thread (pin, rename, share, move, hide, delete) | the thread's **right-click menu** in the sidebar, letter shortcuts, long press on a phone |
| Rare actions on a row | the row's **⋯** menu |
| Sorting and what's shown | the one **Sort** menu above the thread list: the sort choices; below a line, General, Private and Hidden; below another, All threads, Only projects or No projects |
| Sharing a thread | **Share with** in the thread's right-click menu, a submenu of the server's other people (or "No one else on this server."); picking one opens a **dialog**, "Send a copy to <name>?", one sentence, **Send a copy** primary and Cancel |
| Anything waiting for the user | **Notifications**: the sidebar link with its count, the Settings section, and the Notifications card on the welcome page (the first decisions with their buttons, and **All <n>** to the section). Never a banner elsewhere, except the chat's pending bar. The section: filter chips (All <n>, Needs a decision, then the kinds present, such as Shared with you), **Sort** (Newest first, Oldest first, By type, By pool) and **Where** (Everywhere, General, Private) as selects, the count in mono, **Select all** with a bulk bar of buttons for the actions every selected row shares, each with the count (Add to Private 2, Decline 2); none when they share none, the count only; each row has its title, a fact line with numbers in mono, a facts line of kind, pool as the kind eyebrow and time in mono, Open thread or Open where it leads, and its actions as buttons (Add to General, Add to Private, Decline on a share; Dismiss on anything with no decision) |
| A user's own settings | **Settings**, sections on the left |
| Server-wide settings | **Administration**, shown only to administrators |
| Changing a user's password | **Change password…** on the user's row in Administration › Users; it opens two fields in place (New password for <name>, Your password) with **Change password** primary and Cancel; afterwards a one-line status in the row, "Password changed. <name> is logged out and told at their next visit."; a wrong own password or a missing recovery copy shows its sentence in the row instead |
| Updates (the running version, the update note, kept releases) | the **Updates** section of Administration: the running version in mono; the newest update note as its tag in mono, then its text in a block; **Update** as the section's one primary, disabled while an update runs. The state is a status line beneath it, a dot and a word (Draining, Building, Testing, Probation in blue; Failed red); while draining the line continues "waiting for 2 threads" with the count in mono and the threads linked beneath. Kept releases as rows (commit in mono, date, Running as the one state); **Roll back** in each row's ⋯, except the Running row's, disabled while an update runs, confirmed by a **dialog** with its one sentence ("Roll back to the release from 9 October?" with the commit in mono after it, then "Messages since 14:02 will be lost." only when it restores a snapshot). A failed probation is a **Notification** naming the commit and the check, and saying it rolled back |
| Models, hosts, downloads, clean-up | the **Models** area (the sidebar's Models link, its badge the Clean up count): tabs down the left, a scrolling row on a phone: Overview, Tasks, Text models, Image models, Hosts and endpoints, Downloads, Clean up, Recent calls. Overview is tiles (Endpoints, Backend, Clean up) over the hosts summary and the last five calls. Hosts and endpoints: **Add endpoint** (a drawer) and **Add model host** (the one primary, a page with steps) in the header; on a phone the two header actions stay as text buttons under the title, since two add icons would read the same; a **card** per model host with its state as a dot and a word, Pause or Resume, Dashboard, "N models", a facts line in mono and one GPU bar per card (pinned, loaded on demand, vLLM share); a **row** per plain endpoint with its pills, facts line, state, "N models", Edit and a ⋯ menu for the rare actions. Clean up is a list with one pill per row and Replace with… or Remove. Recent calls is a table that stacks on a phone, never any message text |
| The app's version | the header, "Lyrica (ver. …, build …)" |
| Lyrica's inner workings (recall, tools, notes) | one-line **markers** in the conversation that expand when tapped |
| A user's memory | the **Memory** page (the sidebar's Memory link): the Files panel's layout, a browse pane at the left with a search box above a segmented control of the layers (**Pages** \| **Notes** \| **WAKE** \| **Journal**), a pool select and **User introduced** in one filters row, and the list (title, date in mono, pool word and summary or tags); the memory at the right, or in the pane's place on a phone with a **Memory** back button. The page header states facts (pages, notes, when she slept, in mono) and holds one action, **Add a memory**. The memory: its title, a facts line (pool, layer, origin as a word, updated date in mono, folders in mono), its summary, the text, then **Edit** and a **⋯** with Archive and Delete…, then **Came from**, **Used in**, **History** as eyebrow sections. Delete is confirmed by a **dialog** named after the memory with its one sentence |
| What she did at night, and what she'd like to raise | the **Sleep** page (the sidebar's Sleep link, after Memory, with the count of new items as its badge, or a pulsing dot while a run is going): her items first, each with its text, a facts line (pool, kind, time, **Came from**) and two small secondary buttons, **Start a chat** and **Dismiss** ("Nothing to raise." when there are none); then **Last night** (the newest run of each pool) and **Earlier** by day: a row per run with the pool, its time in mono and one line (the skip reason in words, "Sleeping… dreaming", or "2 notes added · 1 page changed · 1 question · dream and WAKE written"), opening to **Notes**, **Pages** (title, then the word diff), **Questions**, **Thoughts**, **Dream** and **WAKE**, each a link to the Memory page at that memory; at the foot a secondary **Sleep now** ▾ (General or Private; in manual mode a dialog with her sentence first; a refusal as a toast) and the line "Scheduled nightly at 04:00 · change" or "Manual: only when you ask · change". The mode is a **Sleep** select above Sleep fallback in Settings → Model profiles (**Nightly at 04:00** or **Only when I ask**, saved at once); the hour is **Sleep time** with one Save in Administration → Sleep |
| A memory looked at from a conversation (a recall marker, a citation in her text, a sleep item's source) | the **panel**, like a thread; below 1180 px the Memory page at that memory |
| A link inside a memory's text | a page link reads as the page's **title**, a thread citation as the thread's title, a note citation as a small dated **source mark** in mono (the note has no title); each is a link that opens the memory in place (the breadcrumb grows) and shows a **preview** of its first lines on hover or focus. Never the raw ID; the stored text keeps it |
| What a memory came from, and what uses it | **Came from** and **Used in**: a card per memory with its title (or first words), its date in mono, and the citing sentence beneath |
| A memory's versions | **History**: a row per version with its time in mono and its author (Lyrica, sleep, or yours), the current one open; a version opens to the word differences against the current text (removed words struck through in the danger colour, added words in the ok colour) and a **Restore** button |
| A note's tags | its `about` words as **tag** chips under the facts line, in mono; the Notes layer lists the pool's tags above its list, and a tapped tag filters it |
| Reacting to a message | **React** (an icon button beside the message's ⋯) opens a **quick row** of six favourites, each with the tooltip "React with <name>", ending in **More emoji**, which opens the full **picker** (search, categories). Reactions are **chips** under the message, the emoji and its count in mono; the user's own chip is outlined in the accent and pressing it takes the reaction off; the tooltip says who ("You and Lyrica reacted with 🎉"). Lyrica's reactions look the same |
| Remembering a message | **Remember this** in the message's ⋯ menu: a field under the message labelled **Remember this as a note** with the pool word in eyebrow style, prefilled with the message's first line, **Remember** primary and Cancel; afterwards one line, Remembered as a note, linking to it |
| Forgetting several memories | Ctrl- or Cmd-click and Shift-click select list rows; a bar at the foot of the pane names the count, with **Clear** and **Forget…**, confirmed by a dialog |
| Editing a memory | in place where the text was: an **Edit** \| **Preview** segment, the textarea, **Save** as the one primary and Cancel; typing `[[` opens a popover of pages and people (a page is saved as its ID, a person as their name token). Notes cite by ID in the editor, since they have no title. No draft is kept in the browser |
| A message written in another thread (what a parent sent its child, a sibling's in a project, a look at a project's threads) | collapsed to one line, **Message received from <thread>** with a chevron (the look is its own marker, Checked the other threads); tapping it shows the message as a tinted block with its menu; a long one shows its first lines and **Show more**. Never shown open by default: said elsewhere, it would crowd this conversation |
| The message box | one box holding the textarea and Send as a plain icon (Stop while she works); under it, a row with "+" (Attach and the tool switches), the mic, and, at its end, the mode word with a caret |
| Anything in the conversation waiting for an answer (a plan, a permission, a question from a subagent) | a **card** in the conversation, with its actions at its foot and one primary action at most. When the latest such card has scrolled out of view, a thin bar in the accent colour across the top of the chat names it and jumps to it; it is the one bar the chat may show |
| A subagent | a **card** in the conversation that expands to its work and takes messages |
| Dictating a message | the mic in the message box's row; the box's placeholder while listening |
| Hearing a message read aloud | her message's actions; with **Read aloud while agent writes** on, also on the reply she is still writing |
| Read aloud while agent writes | a switch under Speech in Settings, Appearance |
| Dictation and Read aloud models | selects in the thread drawer's Models section, under Titles; a cloud Dictation pick there first opens a dialog ("Send your voice to the cloud?", **Use cloud dictation** primary and Cancel), and confirming it is the consent to send that thread's voice to the cloud (no separate switch); the profiles' rows in Settings → Model profiles, Dictation in Local only |
| Fallback (only a list's first model answers when off) | a switch at the foot of the thread drawer's Models section; its default beside Mode (Settings, Network, New threads); a project's under Project settings → New threads, a select beside Thinking; sleep's as **Sleep fallback** at the top of Settings → Model profiles. Tooltip "When off, only the first model in each list answers; if it can't, the message waits for it." |
| A speech model's voice and speed | its Settings drawer in Models |
| A machine (an SSH account, a Proxmox token) | a row in the **Machines** section of Settings: name; a facts line in mono with the address, the pool, "SSH · key" or "Proxmox API · token", and the limit as a phrase ("up to Accept edits"); at most one state (Online green, Unreachable amber with the duration in mono after the word, Key changed red, Off network amber; none if never probed). The row opens the **drawer** (address, root, pool, **Mode limit** as the message box's three-item mode list); Replace key and Remove behind ⋯, Remove with its one sentence; a private machine that is Off network also has **Use anyway** there, which opens the Add machine dialog with the consequence, **Use anyway** primary and Cancel, and the row stays Off network |
| Adding a machine | the **Add machine** page, like pairing a host: one h1, a kind segment (SSH \| Proxmox) at the top, steps as sections with eyebrows (Name and address, Key or Token, Test, Fingerprint), one primary on the page: the current step's action (Copy, then Test, then Confirm); a done step's button becomes secondary. Confirm is the last step; nothing is saved before it. Commands in a code block, the fingerprint in mono, no captions. Replace key and a changed key open it at the Fingerprint step. An off-network private machine gets a **dialog** with the consequence, **Add anyway** primary and Cancel |
| A thread's machines | one Machines row in the thread's Settings drawer next to Folders (and under This chat on Project settings): the sandbox ("always"), then the granted machines as a list, each with its limit ("up to Ask") and an ✕; a **+** (Add machine) below opens a search popover of the pool's other machines (name in mono, address muted), shown only while one is left; their names in mono in the header's facts line beside the folders. The mode word stays the thread's mode; in the mode menu, a mode above a granted machine's limit reads "Asks on <machine>" |
| A Git account (a token for GitHub, Forgejo, Gitea or another Git host) | a row in the **Git accounts** section of Settings, after Machines: name; a facts line in mono with the host, the pool, the kind and the account name; at most one state (Signed in green, Token rejected red, Unreachable amber with the duration in mono after the word, Off network amber for a private one; none if never checked). The row opens the **drawer** (Name, Kind, Host, Account, Pool; for a GitHub account Pool is the plain fact General, with the reason as its tooltip and as a visually hidden description, "A GitHub account is general. Private threads use only self-hosted accounts on your own network."; for the other kinds a select, described "A private account must be on your own network: LAN, this machine or the tailnet."); the pool word in the facts line is plain, as a machine's; **Add account** opens the same drawer with a Token field, and the token is checked against the host before the row is saved; Replace token and Remove behind ⋯, Remove confirmed by a dialog with its one sentence naming what leaves (**Keep** / **Remove**); a private account whose host is outside her network is confirmed by a dialog, "Use a host outside your network?", its sentence the consequence, Cancel and **Add anyway**, **Save anyway** or, behind ⋯ on a row that is Off network, **Use anyway** |
| A thread's repositories | one Repositories row in the thread's Settings drawer after Machines (and under This chat on Project settings): the granted repositories as a list, each `owner/name` in mono with its account's name muted and an ✕; a **+** (Add repository) below opens a popover with a search box ("Search, or paste a URL") and the repositories each account of the thread's pool can see, grouped under the account's name with its host muted (a pasted URL that two accounts can see is listed under each, so the pick names the account), a **Git accounts** link at its foot, and "No general Git account yet" (or private) when there is none; on a phone the popover sits in flow under the +, with no shadow, as the Machines picker does. Under This chat the + and ✕ edit the list and the page's one **Save** applies it ("Saved." afterwards), as for Folders and Machines; in the thread drawer a change applies at once. Their names in mono in the header's facts line after the machines |
| A remote action waiting for approval | the permission **card**, the machine's name first in its title, the command or path in mono; for a suspect command, one plain warning sentence above the command and a third secondary choice, **Allow in this thread**. Allow stays the one primary; no third colour. Each remote call is a **marker** naming the machine |
| A thread or message Lyrica mentions | a **link** in her text: the thread's current title, opening the thread; no state dot (the sidebar row and the pending bar carry the state) and no pool colour; "a forgotten thread" in plain text when it's gone. Never the raw ID |
| A serving change she proposes (her `models` tool) | the permission **card** worded as its question: "Serve **Qwen3.8-27B** with `1,010,000` tokens of context? It reloads, and its KV cache grows to `17` GB.", the numbers in mono, and "Qwen documents `4`." after it when the stretch is above the card's. **Allow** primary, **Deny** |
| A child thread | nested under its parent in the **sidebar**, with its state and unseen count as badges; its updates as a **card** in the parent's conversation that links to it |
| A project | a thread row in the **sidebar** with the project icon in the pool dot's place, its threads nested under it (each keeps its pool dot) and resolved ones folded under one **Resolved** disclosure row with the count in mono; an amber dot on the row when a thread waits on the user. **New project** in the thread list's own menu (right-click or long press anywhere that is not a row: an eyebrow, a gap, the strip under the last row), **Make project** in a top-level thread's menu; a new project starts pinned, at the top with the other pinned threads |
| A project's threads at a glance | **Threads** with its count in the project chat's facts line, a popover grouped Waiting on you, Working, Queued, Idle, Resolved, in the sidebar's words and order; full width on a phone |
| A thread of a project, in the project chat | one **card** under the message that started it, updated in place (no card per update): title, state as a dot and word (Working blue; Waiting on you and Waiting for approval amber; Resolved green; Idle the word alone), what it waits on beneath, the last update's first line, up to three file names in mono then "+n" (once the back end lists them); Open, Stop, Resolve or Reopen behind ⋯. Waiting on you counts as waiting for an answer, so the pending bar covers it |
| Threads she proposes | a **Suggested threads** card, like the plan card: a small secondary **Start** per row, one primary **Start all** at its foot; no Dismiss |
| Starting a thread from a message | **Start a thread** in that message's menu, in a project chat only |
| Resolving a project's thread | **Resolve** / **Reopen** in the thread menu and the card's ⋯; a resolved thread's message box is replaced by one **Reopen** link |
| A project's settings, files and images | the **Project settings** page (**Project**, a link with the project icon in the project chat's header before its Settings button, which keeps the thread drawer), sections on the left: General (Goal; the **Paused** switch, tooltip "Running threads stop and queued ones wait."; an h3 **New threads** with Model, Thinking and Fallback, tooltip "Threads Lyrica starts from this chat. Each one can be changed after it starts."; an h3 **This chat** with Model, Mode, Group, **Folders**, **Machines** and **Repositories** (the thread drawer's three controls, since every thread of the project inherits them), then a **Thread settings** link that opens the chat with its drawer for network, local-only and the other task models; one Save), Memory (Instructions with its count, a link to the project page), **Files and images** (a segmented control, Files and Images). Files in the header stays the quick view; the page manages the folder |
| Setting her up (no `self.db` yet) | the **Set up Lyrica** page in the unlock page's place: one h1, steps as sections with eyebrows (Code and passphrase, Lyrica, Administrator, Tailnet, Models, Done); the current step's button the one primary, a done step's secondary; Skip as a link on the optional steps; the code, addresses and names in mono; no captions. Each step's button applies at once, as the Add machine page's do |
| Her name | **Name** at the top of Administration's **Persona** section (the Persona changes section, renamed), one Save with its one sentence; shown wherever the interface says Lyrica |
| The tailnet | the **Tailnet** section of Administration: a facts line in mono (tailnet, address, MagicDNS name, control server), one state (Connected green, Disconnected amber, Not installed red, Not joined the word alone); **Connect** primary and **Disconnect** secondary; Leave and Connect to another tailnet behind ⋯; Disconnect and Leave each confirmed by a **dialog** with its one sentence (**Disconnect** / **Stay connected**, **Leave** / **Stay**); joining happens in the **drawer** (Auth key, Hostname, Advanced → Control server) |
| Web access over the tailnet, or straight to the machine | the **Tailnet** and **Direct** modes of Web access, next to Off, Built-in Caddy and External proxy; their state lines show the name and the certificate, or the addresses and the fingerprint in mono, as the other modes do |
| A project's usage | a fact in the project chat's facts line ("312k tokens"; on a phone, the first line of the Threads popover); the breakdown in Models → Recent calls, filtered to the project |

The project rows are drawn in the app mockup's projects frame
(https://claude.ai/artifact/96BoPXPoxL2LDBg8eLxjHx, version 22: `#t/p1` and
`#project/p1/general`); the Memory page in its memory frame (version 27:
`#memory/none/p:proxmox-homelab`, a note at `#memory/none/n:20261009-k3f9`;
the `local` and `pool` frames there are the graph options Li declined);
the Git accounts rows and drawer, and the Folders, Machines and Repositories
lists under This chat, in version 29 (`#settings/git`, `#project/p1/general`).

If your thing isn't in this table, it needs the design thread, not a new
spot.

## 7. Forms and settings

- Number fields over drop-downs. The field shows the maximum beside it and
  a value past the maximum becomes the maximum when the field is left.
- A row is a label, a control and its unit; nothing else on the row.
- An inherited value shows as the placeholder; a value's source, when it
  isn't the default, is one small word after the label ("shared", "yours").
  One **Reset** link per section, never a reset button per row.
- Save once, at the foot. If a change applies later, the Save button's
  tooltip says when. If a change can apply now, a second button says so
  ("Save and reload").
- Validation is a plain sentence in place of the estimate line, and Save
  is disabled until it passes.

## 8. On a phone

- Everything works at 390 px: the sidebar slides in, drawers and the Files
  panel go full screen, tables stack into rows, header actions become icon
  buttons with labels for screen readers. There is no panel: what would open
  in it is the page, at the same address.
- No horizontal scrolling, anywhere, ever.
- A long press does what a right-click does.
- Touch targets are 44 px.

## 9. Don'ts, from our own history

Each of these was built, looked tacked on, and was redone. Don't repeat them.

- A second row of buttons under a page title. Actions go in the header's
  action slot or the facts line.
- Text glyphs as icons, mixed with real icons.
- A modal dialog holding a settings form or a multi-step flow.
- Tab names that describe ("How it answers"); form footers that explain
  ("Sent with every call to this copy").
- A Settings button on every row of a table.
- A banner inside a list to announce things found elsewhere.
- Two primary buttons on one screen.
- A dropdown for a number the user knows better than we do.
- Per-row explanatory captions, and a caption repeating the heading.

## 10. The checklist for a PR that touches the interface

Say in the PR which rule each new control follows, and confirm:

- [ ] every new thing has a home from section 6, or the design thread agreed
      a new one;
- [ ] no new widget, button look, icon style or type size;
- [ ] labels are nouns from section 4; no captions were added; any
      explanation is a tooltip;
- [ ] badges carry state only, at most two per row;
- [ ] numbers are typed with units and a shown maximum;
- [ ] a screenshot at 1280 wide and at 390 wide, with no horizontal
      scroll;
- [ ] docs/web.md describes what changed.
