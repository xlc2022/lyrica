# Lyrica: design

This is the current, agreed design. [PRINCIPLES.md](PRINCIPLES.md) explains
*why*; this document explains *what*. Component details live in `docs/`.

To change anything here, raise it in the design thread and update this document
in a pull request. Don't reopen a settled point without new evidence. Reversals
of earlier choices are listed under [History](#history) so they aren't relitigated.

## Who Lyrica is for

Lyrica is one continuous companion, running on a server Li administers. Each
person who uses her has one or more **users**. Li keeps several for herself
(for example a public-facing one and a private one), and someone else, such as
Li's partner, can have their own. Each user has its own password, its own
encrypted databases, its own endpoint and model settings, and its own memory.
To Lyrica, each user is a different relationship. She is still one
individual: her persona is the only thing users share.

- Users are either **administrators** or **normal users**. Administrators can:
  - change any account's administrator status from the control panel (the last
    administrator can't be demoted);
  - approve changes to Lyrica's persona;
  - edit global settings such as the sleep time and the endpoint list.

  They can also **set any user's password** from Administration → Users
  (2026-10-11, Li's decision): the server keeps a recovery copy of each
  user's key in `self.db`, so nothing is lost, and the user is told who set
  it, until they change it themselves. So each user's data is encrypted with
  that user's own key and private from other users, but an administrator who
  sets a password can log in as that user: users are protected from each
  other, not from administrators or the operator (below).
- **One browser, one person.** A browser holds several users at once only if
  they are **linked**: users that belong to the same person, linked by entering
  both passwords. Switching between linked users needs no password. Logging in
  as a user who isn't linked to the ones already there first ends their session
  in that browser. The menu says **Switch user**.
- **Words in the UI.** A person's own linked users are their **personas**
  ("Link separate persona"). Lyrica's own character is always **Lyrica's
  persona**, as in "Changes to Lyrica's persona", so the two are never
  confused.
- **Logging out** keeps the user's key in memory, so sleep can run, unless that
  user turns this off in settings. **Lock** always drops it.
- **Not protected from the operator.** Users are protected from each other in
  Lyrica, not from whoever runs the machines. Root on the running server can
  read an unlocked user's data. Shared endpoints run on accounts and model
  hosts the administrator controls, which may log prompts. A user who needs
  privacy from the operator should use only their own endpoints, or not use
  this server.- Accounts stay minimal: local users, Argon2id password hashes and a web login
  cookie. No identity providers or roles beyond administrator.
- **Names and pronouns.** Each user has a login name, a display name and
  pronouns. Users can change their display name and pronouns at any time in
  settings, and previous names are kept with dates. The first user is **Li**.
  Memory refers to users by token rather than by name, so a change never
  requires rewriting memories (see
  [docs/memory.md](docs/memory.md#names-and-pronouns)).
- No memory crosses between users. A one-way "may read" link between users can
  be added later if it's missed.

## Memory pools: general and private

Each user has two pools of memory.

| | General | Private |
|---|---|---|
| Models | Cloud models or a custom endpoint | Custom endpoint only, for every call |
| Reads | General only | Private and general |
| Writes | General | Private |
| Sleep | Its own, on the general sleep model | Its own, on a custom endpoint |

- **Private never reaches a general context or a cloud model.** This is
  enforced structurally, not by instructions to the model:
  - the pools are separate databases;
  - general code never holds a handle to a private database;
  - a private conversation's Pi runtime contains no cloud models at all.
- A **general** thread can also be switched to **local-only**. That keeps the
  conversation's own model calls on the custom endpoint. Its memories still
  belong to the general pool, so general sleep may later process them with a
  cloud model. Anything that must never reach the cloud belongs in the private
  pool.

## Interfaces and threads

- Web chat is the main interface. The CLI, Matrix and a forum come later, in
  that order, each built only once the previous one works well.
- **The web UI is React with TypeScript, built with Vite.** Models will write
  and maintain almost all of it, and React is what they know best; `tsc`
  checks its components like the rest of the code.
- **How the web UI looks** is set out in [docs/ux.md](docs/ux.md), the
  rulebook every interface change follows. In short: the conversation comes
  first and everything else is quiet, familiar and in its one place. IBM
  Plex, five type sizes, one icon set; three button looks; labels are nouns
  and explanations are tooltips; badges carry state only; numbers are typed
  with their maximum shown; editing in context happens in the drawer and
  dialogs only confirm; a thread's header is its title, one line of facts
  and two actions; everything works at phone width.
- **Where things are:**
  - **Sidebar:** New thread, Search (with a Pinned messages view),
    **Notifications** with its count (in orange), Memory, Sleep (with a
    count) and Models at the top; then her items from last night; then
    threads, with child threads nested under their parent and a project's
    threads under the project (see [Projects](#projects)); then a line of
    host status; then the user's button.
  - **Threads can be sorted** by date (grouped Today, Yesterday, Previous 7
    days, Previous 30 days, the default), by last activity, by start date or
    by title, or shown in **the user's own groups**, which they make, name
    and move threads into from a thread's header or the thread menu, or by
    right-clicking empty space in the thread list (**New group**). The
    choice and the groups are saved per user, in `user.db`. A group can hold
    general and private threads; hiding a pool still hides its threads.
    Pinned threads (Pin in the thread menu) sit at the top of the list,
    whatever the sort. A thread's pin is the user's own setting, in
    `user.db` like its group, never in the pool.
  - **One Sort menu** above the threads holds the sort choices; below a
    line, the General, Private and Hidden checkboxes; and below another,
    **All threads**, **Only projects** or **No projects** (one of three,
    All threads by default). Nothing on screen says that hidden content
    exists.
  - **The thread menu** opens by right-clicking a thread (a long press on a
    phone), with a letter shortcut for each item: Pin (P), Mark as unread
    (U), Rename (R), **Share with ›** (S), **Move to group ›** (M), Hide (H)
    and Delete (D); **Make project** (K) on a top-level thread, and
    **Resolve** or **Reopen** (E) on a project's thread. Delete confirms,
    says that what Lyrica learned from the thread is forgotten, and offers
    to delete its child threads too.
  - **Share with** sends another user a copy of the thread as it is now.
    They add it to their General or Private threads, or decline. The
    sender's later messages aren't shared, and none of the sender's
    memories go with it (the copy is the conversation alone: what she read
    from memory, wrote to it, or thought stays behind, and her citations are
    stripped); the copy is the recipient's thread from then on, and
    Lyrica remembers it in the recipient's pool. A private thread can be
    added only to Private, and a thread kept off the cloud keeps that in its
    copy, so the hard rules hold across users. Sharing a private thread
    asks first. Only users on the same server appear in the list.
  - **The user's button** opens a menu: Settings, Administration (shown
    only to administrators), Switch user, Lock and Log out.
  - **Settings** (the user's own) and **Administration** (administrators) are pages
    with a list of sections on the left. Notifications is the first section
    of Settings.
  - **Notifications:** one page for everything waiting for the user: sleep
    items, persona suggestions and approvals, permission requests, child
    thread updates, threads shared with them, image models to review,
    clean-up items, finished downloads, host problems. It sorts by newest, oldest, type, or host and
    pool, filters by type and place, has actions on each row and bulk
    actions, and pages through large numbers. Counts elsewhere link to it.
  - **Header:** "Lyrica (ver. …, build …)" with the date and time beneath;
    the daemon reports its version and build.
  - **Welcome:** a greeting, the message box with General or Private, her
    items from last night, Notifications, and Backend (what answers now).
  - **Files and images, in every thread.** **Files** in the thread header
    opens a side panel (full screen on a phone) with two tabs:
    - **Files:** a searchable tree of the thread's folder (uploads, images
      she made, her notes and scratch files) and each granted folder.
      Clicking a file shows it.
    - **Images:** thumbnails of the images in the thread's folder, with All,
      Uploaded and Made by Lyrica. Clicking one opens it large.
    - Actions are in a right-click menu (a long press on a phone, or ⋯):
      Attach to message, Show in thread, Download, Copy path, Rename and
      Delete on a file; Upload and New folder on a folder or empty space.
    - Ctrl- or Cmd-click and Shift-click select several (Select in the menu
      on a phone). The menu then acts on all of them: Attach, Download as
      zip, Copy paths, Delete.
    - Uploading from the panel, or dropping files on it, adds them to the
      thread's folder without sending a message. Her next turn gets one line
      naming the files added or removed since her last turn. Files attached
      in the message box go to `uploads/` and show in the panel too.
    - Rename and Delete work in the thread's folder and in read-write
      grants, never in read-only ones. Deleting is permanent, and deleting
      in a grant says it deletes on the server.
    - A panel upload belongs to the thread, not to a message, so removing
      turns never deletes it.
  - **Voice**, as in Claude: a mic in the message box for dictation, and
    **Read aloud** on her messages; later, voice conversation. See
    [Voice](#voice).
- **Each interface keeps its own threads.** Lyrica is continuous across
  interfaces because she remembers, not because threads are mirrored. Moving a
  thread to another interface is an explicit export that copies it. Nothing
  syncs.
- A thread belongs to one user, one pool and one interface, all chosen when it
  is created.
- **Threads are mentioned by ID.** Every thread has a permanent ID; its title
  is only a label. Lyrica writes a thread as `[t:<id>]` and a message as
  `[e:<id>#<n>]` (from a private thread, a general one as
  `[general/t:<id>]`), the form memory already cites them by. The web shows
  each mention as the thread's current title, linked to it, so a rename shows in every past mention without rewriting
  anything. A thread that's gone, or that this pool can't see, shows as "a
  forgotten thread". Where there is no link (Read aloud), the mention reads
  as the current title. Anyone can still name a thread by its title: the
  `threads` tool finds it by title or ID. This holds for every thread,
  subagent and session, not only projects.
- **Visibility:**
  - Two checkboxes in the Sort menu, **General** and **Private**,
    show or hide all content from a pool.
  - Any thread can be hidden, and **Hidden** reveals them.
  - **Only projects** shows just projects, with their threads nested under
    them; **No projects** leaves projects and their threads out.
  - These settings are saved per user. They only affect what's displayed:
    hiding doesn't change what Lyrica remembers.

## Models and endpoints

Lyrica runs on a mix of models: DeepSeek 4.1 Flash, GLM 5.3 Flash, Qwen 3.8
27B and Qwen 3.8 Flash Next.
- **Cloud:** through OpenRouter.
- **Local:** through LM Studio or KoboldCpp. The Qwen models and a local copy
  of DeepSeek run there.

- **Endpoints.** Every endpoint is declared **cloud** or **local** by the user.
  Its API type never decides this.
  - **Every endpoint and every model it offers has a permanent ID.** An
    endpoint's name is a label that can change.
    - Each model an endpoint offers is its own entry with its own ID, so the
      same model on two endpoints is two entries. "DeepSeek" in a private
      thread can only ever mean a local copy.
    - Profiles, thread overrides and recent calls refer to these IDs, so
      renaming an endpoint breaks nothing, and the same model on two
      endpoints can sit in one fallback list.
    - A model an endpoint no longer lists keeps its entry, marked
      **missing**, so a profile never changes silently.
    - The UI recognises the same model on different endpoints and can offer
      it as a fallback.
  - **Model groups.** A user can group entries from different endpoints as
    one model, for example "Qwen 3.8 27B" served by the Blackwell machine,
    the 3090 and a laptop, in their preferred order. A group has its own
    permanent ID.
    - Profiles and overrides can name a group or a single entry. A group in a
      fallback list expands in place into its members, in order.
    - The usual rules filter members: a private or local-only thread skips
      cloud members, and a group that mixes kinds is usable as a whole only
      in the Custom profile.
    - The router skips a member that can't handle the call, such as one
      without tool support when tools are needed, or one whose context
      window is smaller than the conversation, and moves on to the next.
    - Groups live in the model library, not on a page of their own: each
      model's row opens to its copies, and the grouped ones show how they
      differ (quantisation, context window, tools, vision), with warnings.
    - Lyrica suggests groups but never creates them. A strong suggestion is
      the same file on two hosts, matched by checksum; a weak one is a
      matching name. The user confirms.
    - Administrators make shared groups from shared endpoints. Each user can
      make personal groups from their own and shared entries.
    - When an entry is replaced or removed, the change applies inside groups
      too, and a group left empty is flagged in Clean up.
  - **Editing an endpoint never changes its IDs.** A new URL, address or key,
    or re-pairing a host, keeps them all, so moving a server means editing
    its address.
  - **Cleaning up** never deletes silently, because profiles, overrides and
    saved workflows refer to these IDs, including other users' profiles,
    which stay encrypted while those users are locked:
    - An endpoint unreachable for 14 days is marked **stale**, and a model
      missing for 30 days is marked **gone**. Fallbacks skip both.
    - A gone model that nothing refers to is removed after 30 days.
    - Everything else goes through a **Clean up** view. It shows where each
      stale endpoint or gone model is still used, and offers **Replace
      with…** (pre-filled with the same model on another endpoint, where
      there is one) or **Remove**.
  - **Redirects and tombstones.**
    - A replacement leaves a **redirect** from the old ID to the new one,
      and a removal leaves a **tombstone**. They are stored where the
      endpoint lives: `self.db` for shared endpoints, the user's `user.db`
      for personal ones. Routing follows them at once, for every user.
    - Each user's own lists are rewritten the next time they unlock, with a
      one-time notice on their Models page.
    - A redirect or tombstone is deleted once no user's lists still refer to
      it.
  - **History never breaks.** Recent calls and messages keep the model's name
    and endpoint label with its ID, so old entries read correctly after the
    ID is gone.
  - **Reset IDs** gives an endpoint and its models fresh IDs, for a server you
    want treated as new. It leaves redirects from the old IDs, so nothing
    breaks. The same mechanism **merges** two endpoints that turned out to be
    the same server.
- **Tasks.** Different tasks use different models: chat, cheap and strong
  subagents, titles, embeddings, each sleep phase, creating and editing
  images, and speech (dictation and Read aloud). Compaction always uses the thread's chat model (Pi has no
  separate setting for it), so it isn't a task to pick.
- **Profiles.** A **control panel** sets default models per task in three
  profiles:
  - **Local:** local models only. Private and local-only threads always use
    it.
  - **Cloud:** cloud models only.
  - **Custom:** local and cloud models mixed freely, for example a local
    model for titles and a cloud one for chat, or a local model with a cloud
    fallback. Only general threads that aren't local-only can use it.

  Each user chooses which profile general threads use by default, Cloud or
  Custom, and a general thread can switch. Each thread can also override
  which model handles which task, including the main conversation and its
  subagents. That applies to every thread, with or without folders.
- **Delegation.** When Lyrica delegates, she picks a tier, never a model,
  following a simple rule:
  - **cheap** for searching, reading, summarizing and checking;
  - **strong** for writing, judgment, and changing code or files.

  The thread's `subagent.cheap` and `subagent.strong` models decide which
  model that is.
- **`delegate` is Lyrica's own tool, built on Pi's SDK,** and covers what
  `pi-subagents` offers that makes sense for her. See
  [docs/delegation.md](docs/delegation.md) and History.
  - Roles (scout, researcher, reviewer, worker, oracle) and custom roles.
  - Parallel runs, chains, review loops, councils and saved workflows.
  - Background runs with status, wait and stop.
  - **Conversation both ways.** Lyrica sends a subagent a message at any
    point: it joins the work in progress, answers an open question, or
    continues a finished subagent in its own thread with everything it
    knew, even after a restart. A subagent asks Lyrica a question and waits,
    or sends her a note and keeps working.
  - **The user can talk to a subagent** from its card in Lyrica's chat. The
    message reaches the subagent as the user's, and Lyrica is told in her own
    thread. The subagent keeps the folders, permissions and model its parent
    gave it.
  - **Fork:** a subagent can start from a copy of Lyrica's conversation
    instead of a blank slate (off by default, since it costs more). It stays
    in the same pool under the same rules.
  - **Approvals from subagents.** Where the thread's permission mode asks
    before commands or changes, a subagent's request shows in its own thread
    and in its parent's, and any open view can answer it. Writers run in
    such threads instead of being refused.
  - Parallel writers get separate git worktrees.
  - Limits, cost tracking, and a live view in the web UI.
  - Everything runs inside `lyricad`. A background run interrupted by a
    restart is marked interrupted, never silently lost.
- **Subagents** work like Claude's: Lyrica hands one a bounded task and gets
  its result back. Underneath each is a stored thread, so it is encrypted in
  its parent's pool, inherits "Do not log" and the parent's workspace
  settings (or narrower), and is forgotten with its parent.
  - In the UI a subagent lives inline, as a card in the parent's chat that
    expands to its work and can be messaged. It is not listed in the sidebar.
  - **Child threads** are different: conversations of their own (forks and
    copies of a thread, and threads Lyrica starts), listed collapsibly under
    their parent in the sidebar, which the user opens and talks in like any
    thread.
- **Lyrica chooses between them the way Claude does.** A subagent when she
  needs an answer to carry on and the task is bounded (search, read,
  review, check). A child thread when the work is a stream of its own that
  outlasts the conversation, that the user may want to follow or steer, or
  that needs a long context of its own, such as "I'll keep going on the
  homelab migration in its own thread."
  - A child thread is full Lyrica: her persona, memory tools and the tools
    its settings allow. It inherits the parent's pool, "Do not log",
    local-only, permission mode and workspace settings, or narrower ones.
  - It and its parent message each other: it posts short updates at
    milestones (a badge on it in the sidebar, a card in the parent), and the
    parent or the user can message it at any time. Its approvals appear in
    the child thread, and in Notifications.
  - It keeps going in the background and stays until it is forgotten.
    Forgetting a parent asks whether to forget its child threads too, ticked
    by default.
- **The user can rewind, retry and branch at any turn,** because weak local
  models often need a few tries:
  - **Regenerate** on any of Lyrica's replies removes it and everything after
    it, then asks again. **Regenerate with…** does the same with another model
    the thread may use (local only in a private or local-only thread), and
    the thread keeps that model from then on.
  - **Delete** removes the last turn, as in LM Studio, again and again until
    the one to retry; **Delete from here** removes a message and everything
    after it.
  - **Edit** on one of the user's messages replaces it in place, as in
    ChatGPT: the edited text is sent and what followed is replaced.
  - **Branch from here** makes a child thread holding the conversation up to
    that message, and leaves the original as it was.
  - There are no versions to flip between inside a thread: a thread is one
    line, and branches keep alternatives.
- **What a removed turn takes with it.** Its entries are deleted like
  forgotten ones: notes written in those turns go too, sleep and search never
  see them, and pages that already rest on them are flagged for rewriting.
  Subagents started in them are stopped and forgotten. A short Undo follows,
  then it is final.
- **Pinned messages.** Any message, the user's or Lyrica's, can be pinned.
  - A pinned message is easy to find again: each thread's header lists its
    pins, and the sidebar's search has a Pinned view across threads.
  - It stays in Lyrica's context word for word, in a `pinned` section of
    the prompt read from the thread itself, so compaction can't summarise
    it away. The section has a budget of 2,000 tokens: when over, the
    oldest pins are cut to their first line, then left out, and the
    thread's header says so.
  - Sleep treats a pin as a sign the message matters when it consolidates.
  - Pins live with the thread, in its pool. A branch keeps the pins in the
    turns it copies. Removing turns that hold a pin says so in the
    confirmation.
- **Orphans are cleaned up.**
  - Lyrica's own leftovers go automatically: subagent runs and threads,
    images and other outputs in the thread's folder, uploads attached only to
    removed messages, and the thread's scratch files.
  - Files in the user's folders are restored, as Claude Code's rewind does.
    Before her `write` or `edit` tools change a file, Lyrica keeps a snapshot
    of it, encrypted in the user's home. Removing turns deletes files those
    turns created and puts back files they changed, but only files nothing has
    touched since; anything changed later is kept and listed. The
    confirmation lists each, ticked by default.
  - Changes made by shell commands can't be tracked reliably: files touched
    only by commands are listed as not tracked. Git branches left by
    subagents in removed turns are listed, ticked when they have no commits.
  - A nightly sweep removes what slipped through (thread folders of forgotten
    threads, worktrees with no live run) and snapshots older than 30 days.
  - A branch copies the earlier entries the way an export does, keeping
    their original IDs, so memories and citations that point at them still
    resolve, and sleep and recall don't count them twice.
  - It is a child thread like any other: the same pool, "Do not log",
    local-only and settings as its parent, nested under it in the sidebar.
    Subagents aren't branched with it; their results are already in the
    copied turns.
  - In version one, subagents can't start subagents of their own.
- **Local-only.** In a private or local-only thread, any attempt to use a cloud
  model, for any purpose, fails with an error. Nothing ever falls back across
  the local/cloud line.
- **Models page.** One area covers everything about models, with its own
  list of pages: **Overview** (one alert, four tiles: endpoints up, what's
  Backend, downloads, Notifications; compact hosts; the last calls),
  **Tasks**, **Text models**, **Image models**, **Hosts and endpoints**,
  **Downloads**, **Clean up** and **Recent calls**. Downloading a model,
  scanning and pairing are pages; a confirmation is a dialog. It covers:
  - endpoints and model hosts, each with its live status. **Add endpoint**
    takes any OpenAI-compatible URL, with an optional key, declared cloud or
    local, for quick testing or a server started by hand. **Add model host**
    pairs a managed host. A local endpoint over plain HTTP outside this
    machine or the tailnet is marked **unencrypted**;
  - **Tasks:** a table of tasks against **Private threads** (the Local
    profile) and **General threads** (the user's default, Cloud or Custom,
    with a switch to the other and a way to show it too). Each cell shows
    what answers that task right now and opens a side panel with its ordered
    list of models. A task can instead
    use another task's list (**Same as**), one level deep: by default titles
    follow cheap subagents, and sleep follows strong subagents. A task with no list of its own follows Chat, as before;
  - two libraries, **Text models** and **Image models**, because the two
    are managed differently. The image library is described under Images.
  - a **Downloads** page, with a count while anything is downloading: the
    queue with Cancel, finished downloads and deletions until cleared, both
    Download buttons, and **Accounts**. The libraries list no downloads;
  - the **text model library** stays usable with hundreds of models (an
    OpenRouter account, a large shared models folder):
    - one row per model, which opens to its copies on every endpoint. That
      is where groups are made, ordered and undone, and where Lyrica's
      suggestions to group copies appear. Each copy shows its **raw name**:
      the file under the models folder, or the endpoint's model ID. Search
      matches raw names too;
    - **what counts as the same model:** copies are the same weights in
      another quantisation or format. A model's identity is its base name,
      size and finetune, read from GGUF metadata (`general.basename`,
      `size_label`, `finetune`, `base_model.*`), from the hub's model card
      (`base_model` with `base_model_relation`, where only `quantized`
      makes a copy), or from the endpoint's model ID. A finetune, merge or
      adapter is a model of its own with a link to its base: never listed
      under it, never suggested for its group. A copy whose file records no
      finetune but whose name has words the model's name doesn't is flagged
      for a check, and **Not this model** moves any copy to a row of its
      own;
    - search, and filters by kind, endpoint and what a model can do (chat
      with tools, vision, embeddings, images), or groups only;
    - **starred** models, which pickers show first;
    - each picker offers only models suited to its task, so the embeddings
      task lists only embedding models;
    - **Download model**, in each library's header: ask a paired host to
      download one, from Hugging Face, ModelScope or a link (see Downloads
      under the model host);
    - **Delete** a copy Lyrica downloaded herself, after a confirmation that
      says where it's used. Nothing else can be deleted from the library. Lists that named it skip it, and its ID is
      kept as removed so other users' lists are tidied when they next
      unlock;
    - **Accounts:** saved tokens for gated repositories on Hugging Face and
      ModelScope. Like endpoint keys, a user's own token is encrypted in
      their `user.db`, and an administrator can share one for every user in
      `self.db`. A read-only token is enough;
  - each model host's GPUs, roles, pinned and loaded models, VRAM and queue,
    with pause, through the host's dashboard;
  - recent calls: which model answered, and when a fallback was used.

  Each user manages their own endpoints and profiles. Administrators manage
  shared endpoints and model hosts.
- **Fallbacks.** A profile can list several models for a task, in order. If
  the first one's endpoint is down, the next is used, and the thread shows
  which model actually answered.
  - In the Local and Cloud profiles a fallback never crosses the local/cloud
    line.
  - In Custom it may, because the user chose that mix. Each model is marked
    cloud or local, and a call that fell back to cloud says so.
  - Private and local-only threads never see the Custom profile, so this can
    never reach them.
  - When every model in a list is away, nothing crashes or hangs: chat,
    images and speech all report the same **offline** state, naming what
    was tried. A message no model took waits and is sent when a machine
    answers again.
  - A thread, a project's new threads, the user's default and sleep can
    turn **Fallback** off: only the first model in a list answers (a group
    there keeps its copies), so a smaller model never writes in that thread
    or touches its files. When that model is away the message waits; a
    plain switch, not a quality floor, since models carry no quality data.
- **Context and pace.** Lyrica and the user both see how full her context
  is and how fast her model answers.
  - After every turn lyricad records prompt and output tokens, the window,
    time to first token and generation time, in the call record. Counts and
    times only.
  - lyricad assembles the prompt, so it can break the total down: persona,
    the page about the user, pinned messages, memories recalled this turn,
    tool definitions, the conversation, Pi's compaction reserve, free space.
    The thread's facts line shows **Context 21%**, opening a popover with
    one bar, the parts, used of window, and the last turn's speed.
  - Her turn context carries one line of numbers: context used and free,
    tokens per second, prompt tokens per second. Two points before Pi's
    own edge, and never later than 90%, lyricad adds a line telling her to
    compact now; fifteen points before that, and never later than 75%, to
    finish the step, save what matters to memory and compact with a
    summary. From 32k up that is exactly 90% and 75%.
  - She compacts herself with the `threads` tool's `compact` action, giving
    her own summary. lyricad hands it to Pi's compaction, which cuts
    the old entries and keeps the recent ones; pinned messages stay. It
    shows as a marker, **Compacted · 41k → 6k**, expanding to the summary.
    Pi's automatic compaction stays on at the window's edge as the safety
    net.
  - Recent calls and the text library show measured speed; nothing acts on
    it automatically yet.
- **Reasoning level.** For models that support it, the message box has a
  thinking control (Off, Low, Medium, High, showing only the levels the
  current model offers), as in Claude and ChatGPT.
  - It is a per-thread setting, with a per-user default, and goes to the
    model through Pi's thinking level (`reasoning_effort` for
    OpenAI-compatible endpoints, the chat template's thinking switch for
    llama.cpp and vLLM models that use one).
  - Offerings carry a `reasoning` capability with their levels, from
    discovery or set by hand in the library.
  - When a fallback model can't think, the thread says so beside the model
    badge rather than failing. Subagent roles keep their own level.
  - Thinking text stays in the thread, encrypted like the rest, shown as a
    collapsed marker. It isn't indexed for recall.
- **Model settings, saved per copy.** Each copy of a model has settings
  that last between uses, edited from its row in the library:
  - **Sampling**, for any endpoint: temperature, top-p, top-k, min-p,
    repeat, presence and frequency penalties, maximum reply length, seed and
    stop strings. They go with every call to that copy; an empty one means
    the endpoint's default. An administrator sets them for shared
    endpoints, and each user can override them for themselves, in
    `user.db`. The library shows each value and where it comes from.
  - **Serving**, for models on a model host: context length,
    KV-cache type, flash attention, GPU layers, parallel requests and batch
    size, plus for vLLM its memory share, maximum sequences and dtype, and a
    chat-template override. They are saved on the host with the model's
    placement (administrators for shared hosts) and apply at its next load,
    with **Reload now** when it's idle.
  - The context length is the window Lyrica plans for, used by compaction
    and when a group skips a member too small for the conversation. For
    other endpoints it is discovered where the endpoint reports it, or set
    by hand.
- **Visibility.** The current model and endpoint, with a clear cloud or local
  badge, are always visible in a thread. Choosing an endpoint, public or
  custom, is easy.
- **Shared endpoints.** An administrator can set up endpoints once for every
  user, such as OpenRouter or the GPU machine. These live in `self.db`. Users
  can also add their own in their `user.db`.
- **Hardware.**
  - Lyrica runs in a VM with an RTX 3090 (24 GB).
  - Her larger models run on Li's workstation, on the LAN, with two RTX 6000
    Pro Blackwell GPUs. It is also Li's gaming machine and dual-boots
    Windows, so it is **not always available**. The 3090 VM is the
    always-on base.
  - Both count as **local**: the data stays on Li's network.
- **"Local" means on Li's own network:** the LAN, or Li's Tailscale tailnet.
  - A model host, SSH target or allowed host reached over Tailscale
    (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, or a `*.ts.net` name) counts as
    local, like one on the LAN.
  - Endpoints are still declared local by the user. As a guard against
    mistakes, Lyrica warns when a local endpoint resolves to an address
    outside private, loopback or tailnet ranges.
- **Later: Lyrica manages her own models.** A small **model host** runs on
  each GPU machine: the 3090 VM and the Blackwell workstation. It serves text
  models through vLLM or llama.cpp (`llama-server`), and images through
  ComfyUI (see [Images](#images)).
  - **Containers.**
    - The model host ships as a Docker Compose file with pinned images, run
      with Docker or Podman on Linux.
    - Containers keep the GPU stacks (CUDA, ROCm or Vulkan, vLLM) pinned and apart
      from the rest of the machine, which matters on a personal workstation.
    - Windows isn't a model host: when the workstation is booted into
      Windows, it is simply away.
    - `lyricad` itself stays a native service (see Deployment).
  - **NVIDIA and AMD**, through a compose profile per vendor (CUDA or ROCm
    images; Vulkan for llama.cpp on AMD GPUs ROCm's images don't cover, and
    integrated GPUs count their shared memory). The machine needs only the
    GPU driver and the container runtime's GPU support.
  - **Our images, pinned by digest.** The host API and ComfyUI images are ours,
    built in CI from pinned versions. vLLM and llama.cpp use their official
    images, also pinned by digest. Nothing is pulled as `latest`.
  - **One way in.** Only the host API container can be reached from outside.
    Lyrica connects to it over mutual TLS with pinned keys (see Pairing), and
    it passes requests on to the model servers (vLLM, llama.cpp, ComfyUI).
    - The model servers sit on an internal Docker network. The host API can
      reach them, but they can't reach the internet or anything else, and
      nothing outside can reach them directly.
    - **Over Tailscale**, the stack runs its own Tailscale container. The model
      host is then a device of its own on the tailnet (for example
      `lyrica-blackwell`), and Tailscale's access rules can allow only
      Lyrica's VM.
    - **On the LAN**, the published port is bound to the machine's LAN
      address, never to every interface, because Docker's published ports
      bypass the machine's firewall. The host API also accepts only the
      addresses of the Lyrica servers it is paired with.
  - **Models folder.** Models live in a folder chosen when the host is installed (run `install.sh` again to change it; the dashboard shows the folder and that command). That can
    be a shared folder on another drive that LM Studio also uses, for example.
    - It is mounted read-only into the model servers. Downloads go into a
      `lyrica` subfolder of it.
    - llama.cpp loads GGUF files from it directly, and ComfyUI finds
      checkpoints and LoRAs through its extra model paths.
  - **Downloads,** from Lyrica's model library or the host's dashboard: from
    Hugging Face, ModelScope or an https link. A shared host takes requests
    from administrators only, and a personal host from its owner.
    - A small **fetch** service is the only container with internet access.
      It can write only to the `lyrica` subfolder, and has no GPU and no way
      to the other containers. `host-api` asks it to list a repository's
      files and to download one, so nothing needs the Docker socket.
    - Only GGUF, safetensors and ONNX files are accepted. Pickle formats (`.bin`,
      `.pt`, `.ckpt`) can run code when they load, so they are refused. A
      model that needs `trust_remote_code` is never run.
    - Each file is checked against the checksum its hub publishes, or one
      given with a link. A link without one is marked **unverified**. A file
      downloads under a temporary name and appears only once it is checked.
    - Links are https only. Fetch checks every address it connects to,
      redirects included, and refuses this machine, the LAN and the tailnet.
    - An access token for a gated repository comes from Lyrica's saved
      tokens (see Accounts) and travels with each request. The host never
      stores it.
    - **Deleting** works only on files fetch downloaded. Fetch keeps a
      record of each download, with its path, size and checksum, and deletes
      only a file in that record that hasn't changed since. A file put in
      the `lyrica` subfolder by hand, and everything elsewhere in the shared
      folder, such as LM Studio's, is never deleted. A loaded model is
      unloaded first.
    - Free space is checked first. A paused host still downloads. A finished
      model gets its offering ID at once, and Lyrica suggests adding it to a
      group of the same model.
  - **No prompt logs.** Docker keeps container output on disk by default, so
    the serving containers log nothing. ComfyUI's folders are in memory
    (`tmpfs`).
  - **No Docker socket.** The host API manages VRAM through each server's own
    API: vLLM's sleep and wake, llama.cpp's model loading, and ComfyUI's
    `/free`. It never touches the Docker socket, which would amount to root.
  - **Dashboard**, served by the host API on port 7236. It shows:
    - GPUs and VRAM, loaded and pinned models, and the queue;
    - usage statistics: requests, tokens, images and time per model. Never
      prompts, results or who asked, and nothing leaves the machine;
    - pause, resume and restart;
    - the models folder, downloads, each GPU's allowed servers and free
      margin, and each model's placement and pin.

    It can be opened three ways:
    - **At the machine:** `http://127.0.0.1:7236`, with no login.
    - **From elsewhere,** for a headless host: the same dashboard over
      Tailscale or the LAN, behind a password set at first start and
      rate-limited. Over Tailscale it uses HTTPS with a real certificate for
      the host's tailnet name, from Tailscale. On the LAN it uses HTTPS with
      a certificate the host makes.
    - **From Lyrica's control panel,** which reaches it through the paired
      connection.

    It checks the Host and Origin headers, so a web page open in a browser
    can't drive it.
  - **Pairing.** A host's identity is a key it holds, not its address, so
    hosts can move.
    - On first start the host makes a key and certificate, kept in its data
      folder. `lyricad` has its own key in `self.db`.
    - On the Models page, **Add model host** takes a name and one or more
      addresses (a LAN address, a tailnet name). Lyrica tries them in order.
    - The host's dashboard (and its log) shows a one-time **pairing code**,
      about 16 characters long, which expires after 10 minutes. It is pasted
      into Lyrica. Each side proves it knows the code, tied to both
      certificates as it sees them, so a machine in the middle, or someone on
      the LAN without the code, can't pair.
    - Both sides then pin each other's certificate. Every connection is
      mutual TLS with those keys: no tokens. Over Tailscale it also runs
      inside WireGuard, and Tailscale's access rules remain an outer fence.
    - **Addresses** can be edited at any time, and trust stays with the key.
      A host whose key changed must be paired again, and Lyrica says so
      plainly.
    - **Unpairing** works from either side: remove the host in Lyrica, or
      revoke a Lyrica server on the host's dashboard. A host can be paired
      with several Lyrica servers, such as a test instance.
    - Administrators pair **shared** hosts, in `self.db`, for every user. Any
      user can pair a **personal** host, in their `user.db`, that only they
      can use. Hosts are always local endpoints, with the usual warning if an
      address resolves outside Li's network.
  - **Management API.** Each host serves an OpenAI-compatible endpoint plus a
    small, authenticated management API: list, load, unload, status, and
    download models. Lyrica can start, stop and switch models on it.
  - **Placement.** The same host runs on every GPU machine, and an
    administrator decides what runs where.
    - The **3090 VM** is the always-on base. It holds the small text models
      (titles, embeddings, cheap subagents), a capable fallback chat model,
      and a small image model.
    - The **Blackwell workstation** runs the large models and the best image
      models when it is up. Profiles list it first and the 3090 second, so
      Lyrica keeps working when it's off, paused or booted into Windows.
  - **Pause**, for games for example, is on the dashboard and in Lyrica's
    control panel. It finishes the current job, unloads every model, and
    declines new work until it is resumed. Lyrica then uses her fallbacks.
  - **Sleep** runs on the 3090's models when the workstation is away at the
    scheduled time. A pool whose sleep model is set to the workstation only
    waits until it is back, as with any endpoint that's offline.
  - **The host manages each GPU's VRAM.** No program can grab a GPU behind its
    back:
    - **Each model has a placement**, set on the dashboard or in Lyrica's
      control panel:
      - **Auto** (the default): one GPU that fits, else split across the
        GPUs it may use;
      - **chosen GPUs**: one, or several for a model too big for one GPU,
        with how it splits (llama.cpp's split by ratio; vLLM's tensor
        parallel across matching GPUs, else pipeline parallel);
      - its own **context length** (32k by default), and for vLLM its
        **memory share**, so one large GPU holds several vLLM models side
        by side.
    - **Each GPU says what it may run** (llama.cpp, vLLM, images) and how
      much memory to **keep free**, or it is left out entirely, such as a
      GPU kept for the display.
    - One GPU can hold several models of any mix; vLLM's share is reserved
      while that model is loaded.
    - A model split over several GPUs loads only when each has room, counts
      against each, and unloads from all at once.
    - Models can be **pinned** (always loaded, such as the embedding and
      title models). Every other model is loaded on demand.
    - A placement that can't work is refused when it's saved, with the
      reason: GPUs that don't allow that server, too little memory even
      when empty, or vLLM tensor parallel over GPUs that don't match.
    - When a model needs room, the host unloads idle models, least recently
      used first. It never unloads a pinned model or one in use, and asks
      ComfyUI to free its memory after it has been idle a while.
    - Requests wait in a queue per GPU (a split model waits for all of its
      GPUs). Interactive chat comes first, then
      images, then background work (sleep, cheap subagents). If a request
      can't fit, it fails with a plain reason, such as "the GPU is busy with a
      chat model", rather than running out of memory.
    - Each model's VRAM use is measured per GPU on its first load with each
      placement, and remembered. The
      control panel shows each GPU's use, what is loaded, and the queue.

## Images

Lyrica can create and edit images, the way ChatGPT does: she writes the image
prompt herself from the conversation, looks at the result, and tries again if
it's off.

- **One `image` tool**, with `create` and `edit`.
  - She picks **fast** or **quality**, never a model.
  - The profiles' `image.create` and `image.edit` tasks decide what those
    mean, so the router's rules apply as for text. Private and local-only
    threads use local image models only.
  - Results go to the thread's folder in the user's encrypted home and show
    inline in the chat. The prompts she wrote are part of the encrypted thread.
- **Local images** run on **ComfyUI**, inside the model host on a GPU machine.
  ComfyUI supports new open models (Krea 2, Z-Image, Qwen-Image, SDXL, and
  editing models such as Qwen-Image-Edit) as they appear. It is contained,
  because as it ships it has no login, runs every plugin with full rights, and
  saves prompts into images and history:
  - it listens only on the GPU machine, runs as its own user, and has no
    internet access;
  - there is no plugin manager, only a few custom nodes pinned to reviewed
    commits;
  - its input, output and temp folders are in RAM, image metadata is off,
    results come back over its websocket, and its history is cleared after
    every job;
  - Lyrica reaches it only through the model host's paired API (mutual
    TLS), which fills workflow templates kept in Lyrica's repository. She can
    never send ComfyUI a workflow of her own.
- **Image models are recipes.** An image model isn't one file: most need a
  diffusion model, one or two text encoders and a VAE, unless a checkpoint
  holds them all. A recipe names each part by its role (and an encoder by its
  slot, such as T5 or CLIP-L), any LoRAs built in with their strength, the
  workflow template for its architecture (one per architecture, not per
  model), and default settings (steps, CFG, sampler, size). Lyrica calls
  recipes, never files, so she never picks parts herself.
  - **Parts are shared.** One T5 encoder or VAE serves several recipes. Each
    part shows its raw file name, size, precision and which recipes use it.
    The host measures VRAM per part.
  - **Identity** follows the text rule. A recipe is its diffusion model plus
    its built-in LoRAs: a lower-precision encoder makes a copy that differs,
    and a built-in LoRA that changes the results (a Lightning LoRA, a style)
    makes a model of its own, linked to its base.
  - **Where recipes come from,** borrowing from Invoke's model manager:
    - **Starter recipes** shipped with the host for each supported
      architecture, with each part's known-good file and checksum. Download
      model fetches only the parts the host doesn't have.
    - **Scan folder:** the host reads each safetensors header (tensor names
      only, never loading the file) to tell a checkpoint, diffusion model,
      text encoder, VAE or LoRA and its architecture. Files are used in
      place, never copied or deleted. Lyrica proposes recipes from matching
      parts, and offers to download missing ones. A proposed recipe does
      nothing until the user confirms it (an administrator on a shared
      host). Proposals wait on a **To review** page of their own, with a
      count on the Image models tab: grouped by host, filtered by ready or
      parts missing, with **Use**, **Download parts** and **Ignore** for one
      or many at once, so a scan that finds dozens of files stays easy. A
      file with no template for its architecture is kept as a file.
    - Hugging Face, ModelScope and links, as for text models.
    - Unlike Invoke, parts are fixed in the recipe rather than chosen for
      each image, because Lyrica, not a person, makes the call.
  - **Editing a recipe.**
    - **Change** on a text encoder or VAE lists every file on that host with
      the same role, slot and architecture, from Lyrica's downloads or the
      shared folder, plus **Download another**. A custom VAE or encoder is
      chosen this way.
    - **Add a part** adds a LoRA with its strength, or a VAE or text encoder
      used instead of a checkpoint's own. A VAE or encoder keeps the model
      the same. A LoRA changes the results, so by default it saves a new
      model linked to the original, which stays as it was.
    - LoRAs and added parts can be removed again.
  - **The image library** lists recipes, and by type (checkpoints, diffusion
    models, text encoders, VAEs, LoRAs, unused files), filtered by
    architecture. Deleting a recipe deletes only the parts Lyrica downloaded
    that no other recipe uses, and says which it keeps and why.
  - Quantized GGUF diffusion models run through one more pinned custom node
    (ComfyUI-GGUF), so smaller GPUs can use them.
- **Upscaling** uses **SeedVR2**, through its pinned ComfyUI node
  (ComfyUI-SeedVR2_VideoUpscaler). It's an image model like the others: a
  recipe of its DiT (3B or 7B, at FP16, FP8 or GGUF) and its VAE, with
  defaults such as the scale and the largest size. The task
  `image.upscale` has its own list in each profile (7B on the Blackwell,
  3B on the 3090), and the `image` tool gains `upscale`. Portrait photos
  follow the same rule as for edits. Video is out of scope.
- **Cloud image services** are cloud endpoints like any other: OpenAI's image
  API first, then others (for example Black Forest Labs, Krea, Google, and
  aggregators such as fal or Replicate). They're used only where cloud is
  allowed.
- **Portrait photos.** Each user can keep reference photos of themselves in
  their encrypted home, for edits and for putting them in new scenes. Sending
  these photos to a cloud model is the user's choice, with a setting:
  - **Never.**
  - **Ask once a day**, the default. The first time a day that one would go
    to a cloud model, she asks first, the way she asks before a command. A yes
    lasts until the end of that day.
  - **Always.**

  This rule is enforced by the `image` tool, not by instructions to the model.
- **Later:** a personal LoRA, trained on the user's photos on the GPU machine
  for a closer likeness. It would be stored encrypted in their home, and loaded
  into the GPU machine's memory only for a job. Choosing a LoRA for one image
  (a style, a person) comes with it: the `image` tool would offer a short list
  of LoRAs the user enabled, with their trigger words, and each recipe would
  say which LoRA slots it takes. Until then, LoRAs exist only inside
  recipes.
- **Wireframes and diagrams** are drawn as code (HTML, SVG or Mermaid) and
  rendered to an image by a headless browser in her sandbox. Image models are
  poor at exact layouts and text. Storyboards suit the image models, with
  reference images keeping characters consistent.

## Voice

Li talks to her and hears her answer, in English and Mandarin. Speech is
two model tasks, **Dictation** (`speech.transcribe`) and **Read aloud**
(`speech.speak`), resolved by the router like any other task, so private and
local-only threads use local speech models only.

- **Where it runs.** `lyricad` routes each call and holds the audio only in
  memory; it runs no models. Locally, dictation runs Whisper
  (large-v3-turbo) on the model host's vLLM, and her voice runs in a
  **speech** container on the host, contained like ComfyUI: our image,
  pinned by digest, no internet, `tmpfs`, no logs. Both are pinned on the
  always-on 3090. Cloud speech is a cloud endpoint like any other (OpenAI
  first). The browser's own speech features are never used: Chrome sends
  dictation to Google, which can't keep the local/cloud line.
- **A user's voice is personal data.** Even in a general thread, audio
  goes to a cloud model only when the user picked that model in the
  thread's **Dictation** select, after a short warning dialog: the
  confirmed pick is the consent, for that thread
  (and its branches) only; threads she starts from it begin without it.
  Without one, Dictation uses the local profile's
  model, whatever the thread's profile (`voiceContext`). Li chose this over
  a separate Voice to cloud switch (2026-10-11). Her text read aloud is
  message text and follows the router's rules alone.
- **Nothing is kept but text.** Audio is never written to disk or logged,
  in `lyricad`, on the host or in the browser. What the user says becomes
  their message's text; call records hold the model and the seconds of
  audio, never text.
- **Dictation.** The mic records until it is pressed again; the clip is
  transcribed and the text goes into the box at the caret, to edit and send.
  Escape throws the clip away. A clip is at most 10 minutes.
- **Read aloud** on one of her messages reads it sentence by sentence as the
  audio arrives, skipping code, tables and links. Stop reading, the mic,
  sending, another Read aloud or leaving the thread stops it; only one thing
  plays at a time.
- **Read aloud while agent writes** is a per-user setting, off by default:
  speech may not keep up with her on every host. With it on, Read aloud
  also appears on the reply she is still writing and follows it to its end;
  her finished message then owns that reading. Nothing is read unasked:
  reading every reply belongs to voice conversation.
- **Her voice.** Each speech model's copy offers voices; the voice for each
  language and the speed are per-copy settings. An administrator sets the
  shared voice and each user can choose their own. Cloning a voice from a
  recording is out of scope.
- **Later: voice conversation.** A state of the message box in any thread,
  never a kind of thread and never saved. The wave button in the empty box
  turns it on; End or Escape turns it off, and so do switching threads,
  leaving the page or locking a phone. Mute stops the mic and stays in it.
  - The box keeps its shape: placeholder "Listening…", and Mute, End and
    the elapsed time in the row beneath, in place of "+" and the mode word.
  - Typing pauses listening; a typed message is a normal turn, and her
    reply is still spoken. A spoken message is stored as its text with a
    `spoken` flag.
  - While it is on, her turn context says the user is listening, so she
    answers in speakable sentences. Speaking over her stops her turn as
    Stop does, and what was said becomes the next turn.
  - Reading every reply aloud happens only here, never as a setting.

## Projects

A **project** is one place for a stream of related work, as in Claude's
Projects: a running conversation, the **project chat**, where Li drops tasks,
updates and questions as they come, and **threads** that Lyrica starts for
the work and keeps track of. Agreed 2026-10-10. The back end is built; the
web part and sleep's project page are not yet. The briefs are
`docs/briefs/projects.md`, `projects-web.md` and `projects-sleep.md`.

- **A project is a top-level thread marked as a project**, and its threads
  are its child threads (see [Models and endpoints](#models-and-endpoints)).
  So everything a child thread inherits holds: the project's pool,
  local-only, "Do not log", mode and workspace settings, narrower or the
  same, never wider. A project is in one pool; a private project is private
  all the way down. Depth stays 1: a project's thread delegates to
  subagents but starts no threads, and a project can't hold a project. A
  thread belongs to its project for good.
- **Lyrica coordinates in the project chat.** She is the same person
  there; only her guidance and context differ. She answers a quick question
  in place, starts a thread for each piece of work (several tasks in one
  message become several threads), sends a follow-up to the thread already
  on it and says which, and posts only what needs Li. When Li asks her to
  propose first, she suggests threads instead of starting them. How Li wants
  the project run ("two at a time", "only post when something is done") she
  saves as a project note and follows; it is guidance, not a hard limit.
- **Threads hang off messages.** Each thread is anchored to the message in
  the project chat that started it: her reply, or a message Li picks with
  **Start a thread**. A branch of the project chat is a thread of the
  project, anchored where it branched. A branch of one of the project's
  threads is also a thread of the project, beside its source rather than
  under it (its parent is the project chat, its anchor the source's), so
  depth stays 1.
- **Threads talk to each other.** Besides parent and child, any thread of a
  project can message any other thread of the same project. The message is
  that thread's next turn, marked as from the sender (a mark only `lyricad`
  writes), and shows there, so every exchange can be read where it landed.
  At most 3 such messages per turn, and waking an idle thread counts against
  the at-once limit. Such a message follows the same rule as a child's
  update to its parent: local-only covers a thread's own model calls, so a
  local-only thread's message can reach a thread that uses cloud models,
  within the one pool.
- **States:** Working; **Waiting on you** (an approval, an update that asks
  Li something, or a failed turn); Queued (started past the at-once limit,
  which stays 2 per user; it waits its turn instead of being refused); Idle;
  **Resolved**. A thread is resolved by Li, by Lyrica when its work is
  delivered and nothing is owed, or after 7 days with no activity; a message
  in it reopens it.
- **She watches her threads** (Li, 2026-10-11; a project setting, **Watching
  threads**, on by default). When Li writes in one of the project's threads,
  or a thread posts an update, the project chat takes one quiet turn a
  little later, batched across threads, with what was said. There she
  decides whether another thread is affected, messages it, and relays its
  answer; she posts in the project chat only what needs Li. A thread that
  isn't logged is left out, and so is a local-only thread unless the
  project chat is local-only too, since a look quotes Li's words. A run of such turns stops after 3 until Li
  writes in the project again, so threads can't keep each other going.
  With the setting off, updates only change their cards and she speaks in
  the project chat when Li writes. The back end is built; the switch and
  the notice are in the web part.
- **Context set once.** Every thread of a project starts with the same
  project context, assembled each turn in its own budget:
  - **Goal**: one line Li writes.
  - **Instructions**: Li's text on the project's page in memory, User
    introduced, so authoritative and never rewritten by sleep.
  - **What she knows**: the rest of the project page, kept by sleep from the
    project's notes and threads, citing them.
  - **Project notes**: notes she wrote in any of the project's threads since
    the last sleep (found by their citations, not stored apart), so a
    decision remembered at noon reaches a thread started at one.
  - In the project chat, the list of its threads with their state, what
    each waits on and the first line of its last update.

  All of it is in the project's pool, so a private project's memory never
  reaches a general context or a cloud model. An unlogged project keeps no
  notes and no page from sleep; its instructions still apply.
- **Files.** The project chat's folder is the project folder, granted to
  each of its threads (read-only to a read-only thread), shown in each
  thread's Files panel as a root named after the project. A folder,
  machine or repository taken off the project chat leaves its running threads at once
  (decided 2026-10-11; folders in
  [briefs/folder-narrowing.md](docs/briefs/folder-narrowing.md)). Two threads may
  write one file; her guidance is a subfolder per thread for its outputs.
- **What Li sees:**
  - In the sidebar a project is a thread row with a project icon, its
    threads nested under it with their state and unseen count, resolved ones
    folded under one **Resolved** row, and an amber dot on the project when a
    thread waits on Li. Projects sit in the thread list, sorted and grouped
    like any thread, and a project is **pinned** when it is made (New project
    or Make project), so it stays at the top; Unpin works as for any thread.
    **New project** is on the context menu of the thread list's empty space;
    it opens an empty project chat, like New thread. The Sort menu can show
    only projects or leave them out.
  - The project chat's facts line adds **Threads** with a count, opening a
    popover of its threads grouped by state, and the project's total tokens.
    Its actions stay **Files** and **Settings**.
  - **Thread cards:** one per thread, under the message that started it,
    updated in place: title, state, what it waits on, the first line of its
    last update, and the files it made. A card waiting on Li is covered by
    the chat's pending bar. **Suggested threads** is a card like the plan
    card, with **Start** per thread and **Start all**.
  - **Project settings** is a page with sections: General (Goal; Threads,
    the model and thinking new threads start with; Paused; then the project
    chat's own settings under **This chat**, including the **Folders**,
    **Machines** and **Repositories** every thread of the project inherits), Memory
    (Instructions, and a link to the project page in the memory browser),
    and **Files and
    images** (Files | Images), where the project folder is managed. Files in the header stays the quick view.
  - **Paused** stops the project's working threads and starts nothing new.
    **Hide** stops it too. **Delete** forgets the project chat, its threads,
    its page, the notes that came only from it, and its folder.
  - **Waiting on you** is a type in Notifications.
- **Not in projects, for now:** schedules (routines), moving an existing
  thread into a project, and sharing a project (Share with copies one
  thread).

## Machines

Lyrica works on Li's other computers: a VM, a single-board computer, the
NAS, and Proxmox nodes. Decided 2026-10-11 from
`/mnt/project-files/remote/proposal.md`, which surveys what other agents do.

- **Agentless.** Nothing of Lyrica's is installed on a machine. An SSH
  machine is reached with Lyrica's own SSH client and a dedicated account
  there; a **Proxmox** machine is reached over its API with a token. No
  Lyrica agent on the machine, no full-power server as VS Code and Zed
  install, unless real use hits a wall (a Windows machine, or policy that
  must be enforced on the machine itself).
- **A machine belongs to one pool.** A general thread uses general machines,
  a private thread private ones; a machine is never in both. A private
  machine whose address resolves outside Li's LAN, loopback and tailnet is
  allowed through a dialog that states the consequence (what she reads
  and writes there leaves the network, and so can the thread's private
  memory) with Add anyway as its one action, and its row shows **Off
  network** while that holds: the address is checked again on every
  connection, and a private machine that has newly gone off network is
  refused until Li confirms the dialog again, from **Use anyway** behind the
  row's ⋯. Changing a machine's pool
  removes it from every thread that grants it, and moving one from Private
  to General gets a dialog saying that what is already on the machine
  becomes reachable from general threads. The sandbox's
  internet switch and allowed hosts cover the sandbox only: a machine's
  network is its own.
- **A machine has a mode limit**, the loosest mode she may use there: Ask,
  Accept edits or Auto. New machines start at **Ask**; Li loosens each one
  as she proves reliable there. A call's mode is the strictest of the
  thread's effective mode (already the strictest of its ancestors) and the
  machine's limit, read on every call. Plan mode may `read` on a machine and
  nothing else.
- **Threads grant machines like folders**, from their pool's machines, in
  the thread's settings. `read`, `write`, `edit` and `bash` take an optional
  machine; without one they run in the sandbox. A subagent or child thread
  gets a subset of its parent's machines, never more, and is narrowed at
  once when its parent is.
- **Keys and tokens** are generated or entered once, stored in the user's
  encrypted `user.db`, handed to the client in memory, and never shown to
  her or to anything she runs. The `authorized_keys` line Lyrica gives
  carries `restrict` and `from=` Lyrica's addresses, so a stolen key is
  useless elsewhere, and the machine's setup puts it in a root-owned file
  (`AuthorizedKeysFile /etc/ssh/authorized_keys/%u`), so no command she
  runs can add a key to stay. Her sudo rights are the exact commands Li
  lists; she never has a password.
- **The host key is confirmed when the machine is added**, never pinned on
  first use: the Add machine page shows the fingerprint Lyrica sees next to
  the command that prints it on the machine, and on the tailnet also checks
  the key Tailscale publishes. A changed key fails every call, with no
  fallback, until Li re-pairs. Strict key exchange is required.
- **The SSH client runs outside `lyricad`**, in a sandboxed helper per
  connection that holds one machine's key and reaches one address, so a
  hostile server that breaks the SSH library gets one key it could already
  use, not every user's.
- **Approvals are bound to what was shown**: the machine, the exact command
  or path and the working folder on the card. Anything different is denied;
  an approval still pending when the turn ends is void; with nobody to
  answer, the call is denied. There is no "allow from now on", with one
  exception below.
- **Suspect commands always ask**, in every mode: a short fixed list,
  documented in docs/workspace.md and never grown one scare at a time, of
  commands almost never right on a machine (deleting `/`, `/*`, a home
  folder or a top-level system folder; `mkfs` or `dd` onto a device;
  recursive `chmod` or `chown` on `/`; `userdel`; shutdown and reboot;
  `qm destroy`). The permission card carries a warning sentence and a third
  choice, **Allow in this thread**: that exact command no longer asks in
  that thread, and nowhere else. The list is a warning layer; the boundary
  is the account's rights and the root-owned keys file.
- **The first call on a machine in a turn asks** if anything earlier in the
  turn ran somewhere else (the sandbox or another machine), whatever the
  modes, so output from one place can't quietly steer her onto another.
- **A floor no mode lifts** for `write` and `edit` on a machine: `~/.ssh/`,
  `/etc/ssh/` and `/etc/sudoers*` are refused.
- **Output** is capped as in the sandbox, stripped of terminal control
  sequences, and private-key blocks in it are replaced with a marker before
  she or memory sees them. Secrets live on machines, which is why a machine
  that holds them belongs in the Private pool.
- **Proxmox** is a kind of machine reached over its API, never a root shell.
  Li makes a privilege-separated token (`pveum user token add lyrica@pve
  agent -privsep 1`) with a custom role of `VM.Audit` and `VM.PowerMgmt` on
  the VMs or pool she may touch, plus `PVEAuditor` on `/` for reads; never
  the built-in PVEVMUser, whose console and guest-agent file rights amount
  to running code in the guest, and never `Sys.PowerMgmt`. One tool,
  `proxmox`, with named actions: status, list, start, stop, shutdown,
  reboot, snapshots (list only). No destroy. Shutdown follows the machine's
  mode limit like a command; stop and reboot are on the suspect list and ask
  with the warning in every mode until allowed in a thread. The node that
  runs Lyrica's own VM is not added until
  Li finds her reliable; the Add machine page refuses it where it can tell.
- **The record is the thread.** Each remote call is a thread entry,
  encrypted in its pool; `write` and `edit` changes are recorded with
  snapshots as in the sandbox, so removing the turns undoes them; commands
  on a machine can't be undone by Lyrica. The machine's own auth log and
  journal record every login and command independently, under the key's
  comment `lyrica:<user>:<machine>`. No command text reaches `lyricad`'s
  log.
- **In the interface:** a **Machines** section in Settings (rows that open
  the drawer; **Add machine** is a page, like pairing a host); machines
  beside Folders in the thread's settings drawer and header facts; the
  machine's name leading the permission card's title; markers naming the
  machine. The mode word in the message box stays the thread's mode; in the
  mode menu, a mode above a granted machine's limit reads "Asks on
  <machine>". See docs/ux.md.
- **Later, only when real use asks:** shared machines offered by an
  administrator to other users (a remote account per user, since users are
  protected from each other), short-lived SSH certificates from a Lyrica
  certificate authority, and an installed Lyrica agent.

## Storage, encryption and unlocking

- Each user's memory and threads live in encrypted SQLite (SQLCipher): a
  general database, a private database, and a `user.db` for settings.
- A shared `self.db` holds Lyrica's persona, global settings, and the user
  index: logins, administrator flags, profiles, and each user's
  password-wrapped key. Names and pronouns are therefore readable whenever
  `lyricad` is unlocked, even while that user is locked. Their memory is not.
- Each user's data key is wrapped by their password. It becomes available when
  the user logs in, or at startup if they chose **save credentials**, in which
  case it's kept with systemd credentials and sealed to the TPM where one
  exists. It is also kept under a **recovery key** that lives in `self.db`,
  so an administrator can set a new password without losing the user's data;
  that copy is readable only while `self.db` is unlocked.
- `lyricad` needs a passphrase to unlock `self.db`.
  - As a service, it starts **locked** and the web UI shows an unlock page.
  - Run by hand with `lyrica serve`, it can prompt in the terminal instead.
  - A "save credentials" option skips both, so it can start unattended.
- **Before `self.db` exists, `lyricad` is setting up** (2026-10-11): it
  starts anyway and serves a **Set up Lyrica** page in the unlock page's
  place, which creates `self.db`, the persona, her name and the first
  administrator in one step and signs that administrator in; then it
  joins the tailnet, turns web access on and adds one model endpoint
  through the normal API. The page asks for a one-time **setup code**
  that `lyricad` logs at start and the install script prints. The host is
  headless, so the page is reached from another machine: `lyricad` starts
  in the **Direct** web access mode (below), HTTPS on the machine's LAN
  addresses with its own certificate, whose fingerprint the install script
  prints beside the code, and on the host's Tailscale addresses if it has
  any (HTTPS there too: the login cookie is `Secure`, which a browser
  keeps only over HTTPS or on localhost). The passphrase and the first
  password cross the network only under TLS; a device on the LAN or the
  tailnet can't claim her without the code. `lyrica admin init` does the
  same from a terminal; both call one function. Nothing of a user's exists
  yet, so the code and TLS are the whole fence (principle 2).
- Memory never goes into a git repository. Backups are encrypted.
- What this protects against: a stolen disk, a leaked backup, or someone
  reading the files while a user is locked.
- What it doesn't protect against: root on the running server while `self.db`
  is unlocked (every user's key is recoverable then, a locked user's too),
  whoever holds the `self.db` passphrase, or anything already sent to a cloud
  model.

## Memory

Details in [docs/memory.md](docs/memory.md).

- **Layers:** threads → notes (small facts she saves whenever she likes) →
  pages (her understanding of one subject) → WAKE (her orientation) → journal.
- **Lineage:** each layer cites the one below it by ID, inline. "Where did this
  come from" and "what was it consolidated into" are both answered from those
  citations.
- **About you.** Each pool has one page about its user, `p:about-user`: who
  they are, what they prefer and dislike, and what they care about, citing the
  notes behind it. It is loaded every turn as its own section next to WAKE,
  with its own budget, so a stated dislike isn't forgotten in an unrelated
  conversation.
  - A private thread loads the private page first, then the general one if
    there is room. A general thread loads only the general page.
  - Sleep keeps it up to date. Until Sleep exists, the user can write it in the
    memory browser. User edits are authoritative, as for any memory.
- **Writes:** she saves notes without asking, one fact per note, and is told
  to save liberally. Sleep reports how many notes it had to catch up on, which
  shows whether she's noting too little. Pages change only during sleep. Every
  edit keeps the previous text as a revision.
- **Review and editing:** users can search, edit, restore and delete any of
  their memories (notes, pages, WAKE, journal) in a memory browser in the web
  UI, or with `lyrica mem` at the terminal.
  - Every edit is a revision.
  - Name tokens survive edits.
  - Sleep treats user edits as authoritative and asks rather than overwriting
    them.
  - **The browser reads like a notebook** (Li, 2026-10-11, after Obsidian;
    [briefs/memory-browser.md](docs/briefs/memory-browser.md)): a browse
    pane by layer (Pages, Notes, WAKE, Journal) with search above it, so
    memory can be read without searching; a page link in a memory's text
    reads as the page's title, a note citation as a small dated source
    mark, a thread citation as the thread's title, each previewing on hover
    or focus, while the stored text keeps its IDs; **Came from** and **Used
    in** show the citing sentence; history shows word differences between
    versions; a note's `about` words are its tags. Editing is in place,
    with `[[` offering pages and people. No graph: lineage is layers, so a
    graph would only redraw Came from and Used in (principle 5). No tags on
    pages, no live-preview editor, no draft kept in the browser.
  - A memory opened from a conversation (a recall marker, a citation) shows
    in the panel beside it, like a thread does.
- **Users can add their own memories**, notes or pages, in either pool. A
  memory can link to threads, specific messages or other memories, or float
  free. Everything a user adds is in the **User introduced** collection.
  Lyrica treats it as authoritative and never rewrites it.
- **Workspace activity is memory too.** File reads, edits and commands are
  thread entries. Sleep turns them into pages about each project or folder,
  and opening a folder brings back what she knows about it.
- **Do not log thread in memory** is a checkbox on each thread. An unlogged
  thread isn't indexed, slept or noted from, but she can still read her
  existing memory in it. Daughter threads (subagents, forks, exports) inherit
  the setting and can't turn it off.
- **Deletion has four levels:** archive, delete a memory, forget a thread, and
  forget a topic. A deleted memory leaves a **tombstone** that holds no text,
  only IDs, so sleep doesn't extract the same fact again from a thread that
  still exists.

## Sleep

Details in [docs/sleep.md](docs/sleep.md).

- **Cycle:** consolidate → dream → wake, adapted from Monika. Each phase is an
  agentic session written in her own voice, with only her memory tools.
- **Schedule:** nightly at 04:00 by default, for each pool with new activity.
  `/sleep` runs it by hand. A **manual** mode works like Monika: sleep happens
  only on `/sleep`, which then opens a fresh thread.
- **Pools:** general and private sleep run separately, each with its own model.
- **Skipping:** sleep skips a user whose key isn't available, or a pool whose
  endpoint is offline, and tries again at the next due time. Nothing is lost.
  The next sleep just covers a longer period.
- **What she'd like to raise** after a night (a thought from the dream, a
  question from consolidation, a persona suggestion) never opens a
  conversation by itself.
  - Each becomes an item in the **Sleep** section of the sidebar, with a
    badge. **Start a chat** opens a new thread in that pool where she begins
    with it. Items can also be dismissed.
  - WAKE is orientation only: where things stand and what's in motion. It
    holds no dream content, so a new thread doesn't open with her dreams.
  - Dreams still come up naturally. When a conversation touches something she
    dreamt about, recall brings the dream back and she may mention it ("I
    dreamt about something like this last night"). She just never opens a
    new thread with it.
- **UI:** the **Sleep** section in the sidebar shows these items, and what she
  did each night.

## Persona

- The v1 persona in `persona/` is the seed.
- **Her name is a setting of the deployment** (2026-10-11), one per
  install, default Lyrica, set at setup and changed by administrators:
  `self.name` in `self.db`. The seed's REGISTER.md keeps `Name: Lyrica`;
  reading the persona puts the set name in that line's place, and the
  header, the unlock page, her message labels and the subagent preambles
  use it. Which install she is isn't about her (principle 9), so changing
  the name is not a persona change and needs no review; what was written
  under the old name stays as written (principle 7). There is no per-user
  nickname: she is one identity across users.
- She proposes changes when asked to reflect on how things have been going, and
  in her dream journal. Every change keeps a revision.
- A proposal comes from one user's conversation or dream, so it may carry that
  user's details. That user sees it first, and can edit it, send it on, or drop
  it. Only a proposal they send on reaches the administrators, who approve or
  reject it. A proposal from an administrator's own conversation goes straight
  to review.
- She has a **self-primer** on her own design, architecture and goals. It is
  loaded when the topic comes up, not always. It includes the rule that when
  she edits her own code, she keeps the documentation current and readable.
  She starts fresh, with no v1 memories imported.

## What she does

- **First duties:** maintaining a calendar and sorting data.
- **Integrations:** Google Calendar, iCloud and CalDAV (which covers Nextcloud)
  for calendars; files, notes, downloads and email for sorting. Each sits behind
  a common adapter interface, and they don't all need to be connected at first.
- **Machines:** working on Li's other computers over SSH, and on Proxmox
  through its API, one machine at a time as Li finds her reliable (see
  [Machines](#machines)). The Proxmox node that runs her own VM waits until
  then.

## Runtime

- The Lyrica Pi extension holds everything that makes her Lyrica: persona,
  context assembly, memory tools and sleep.
- **`lyricad`** is one Node process. It embeds Pi through Pi's SDK: each
  active thread is a Pi session object inside `lyricad`, not a separate `pi`
  process. All interfaces go through it, with the same extension, and it is the
  only process that writes Lyrica's databases.
- **She works like a coding agent.** She has Pi's `read`, `write`, `edit` and
  `bash`, but they never run inside `lyricad`. Details are in
  [docs/workspace.md](docs/workspace.md).
  - Each operation goes either to a bubblewrap sandbox, which sees only the
    folders granted to the thread, or to one of the machines granted to it
    (see [Machines](#machines)).
  - An administrator decides which folders each user may grant, with separate
    lists for the general and private pools. The lists live in `self.db`, so
    the user's password isn't needed and users can't extend their own.
  - Shared drives (Samba, NFS) are host mounts, granted like any other folder.
  - Each user has an encrypted home workspace (gocryptfs) for uploads and
    working files, unlocked with that user's key.
  - Every thread has two network switches for its tools: **internet** (on by
    default in general, off in private) and **local services** (off
    by default in both). There are per-user defaults and per-thread
    overrides.
  - Each thread can also have an **allowed hosts** list: IP addresses,
    address ranges (CIDR), hostnames, or URLs, each optionally limited to a
    port. Listed hosts are reachable even with internet off, so a private
    thread can use one service on another machine on your network and
    nothing else. Each user sets a default list per pool, and subagents get
    their parent's list or less.
  - Hostnames are resolved when the sandbox starts and pinned in its
    `/etc/hosts`. With internet off, the sandbox has no DNS at all, so a
    lookup can't be used to smuggle data out.
  - When any of this is on, the sandbox gets its own isolated network
    (`pasta` plus firewall rules inside the sandbox's namespace), never the
    host's.
  - `lyricad`'s own API (on every address) and the host's Unix sockets are
    never reachable, even if listed.
  - A workspace is just a thread with folders granted. It has the same
    settings as any other thread: models for the main conversation and
    subagents, local-only, internet, folders and permission mode.
  - Subagents work in their parent's workspace and can only narrow its
    settings, never widen them.
- **Modes, in the message box,** as in Claude Code: a picker beside the
  message box (Shift+Tab cycles), per thread, with a per-user default.
  - **Ask:** asks before commands and file changes.
  - **Accept edits:** file changes go through; commands ask.
  - **Auto** (the default): works freely inside the thread's grants.
  - **Plan:** she can only read, recall and use read-only subagents. She
    writes a plan and asks to go ahead; approving it switches the thread to
    the mode the user picks, and she carries on.
  - Irreversible actions that leave the server always ask, whatever the
    mode. Subagents and child threads get the parent's mode or a stricter
    one, and follow the parent when it is made stricter later, at any
    depth; a Plan-mode parent's subagents are read-only. Enforced in the
    `tool_call` hook and by which tools are active, never by instructions.
- **Switches in the message box,** as in Open WebUI: a "+" beside the
  message box turns tools on or off for this thread, without opening its
  settings: **Web search** (`web_search` and `web_fetch`), **Internet for
  commands** (the sandbox's internet switch) and **Images** (the `image`
  tool). A switch that's off removes the tools from the session, so she
  can't use them; a subagent or child thread can't turn back on what its
  parent turned off, even later. Local-only and the pool are not switches here: they
  stay in the thread's settings, where changing them is deliberate.
- **Deployment:** `lyricad` runs as a systemd service, in practice inside an
  LXC container or VM on Li's Proxmox. No Docker. The host needs bubblewrap,
  gocryptfs, pasta, FUSE and unprivileged user namespaces. In an LXC container, that
  means turning on the nesting and FUSE features. One install script sets up
  the service users, `lyricad`'s unit, the built-in Caddy, and **her own
  tailscaled** (`lyrica-tailscaled.service`: the `tailscale` package's
  daemon in userspace-networking mode, as the `lyrica` user, with its own
  state and socket), so she is a device of her own on the tailnet whatever
  the host does, joins, leaves and serves without root, and the host's own
  Tailscale, if any, is never touched. On NixOS,
  the repository's flake gives a package and a module, `services.lyrica`,
  that declares the same users, units and hardening as the install script,
  and runs the same second tailscaled from `pkgs.tailscale`. Her sandboxes there mount the module's tools as `/usr` and only their
  closure from `/nix/store`, never the whole store. Updates on NixOS use the
  same Update button, through a Lyrica-only Nix profile (Updates and
  self-editing). Details in [docs/daemon.md](docs/daemon.md), "On NixOS".
- **Reaching the web UI:**
  - `lyricad` serves plain HTTP on `127.0.0.1` behind an HTTPS proxy. The
    browser never gets plain HTTP: login cookies are `Secure`.
  - The name is a subdomain of Li's domain (for example
    `lyrica.example.net`), whose DNS record points at a Tailscale address. On
    the LAN, local (split) DNS gives the same name a LAN address, so one
    certificate works for both.
  - Certificates come from a **DNS-01 challenge** through the DNS provider's
    API, because a Tailscale address can't be reached for the usual HTTP
    challenge.
  - **She is her own device on the tailnet** (2026-10-11), managed from
    Administration: Connect with an auth key (a hostname, default her
    name; a control server for Headscale), Disconnect, Leave, and Connect
    to another tailnet, through the `tailscale` CLI against her own
    tailscaled's socket. She gets her own address and MagicDNS name,
    `<her name>.<tailnet>.ts.net`, next to the host's if the host is on a
    tailnet too, and the host's membership, SSH and routes are never hers
    to change. An auth key is spent on joining and never stored; her
    tailscaled keeps the node key in its state, and `lyricad` reads the
    tailnet, address and name back from it rather than keeping a copy.
    Who may reach her on the tailnet is Tailscale's access rules; the
    login remains hers. Two limits: she runs only a fixed list of
    subcommands (status, login, up, down, logout, set --hostname, serve on
    443 to loopback, serve reset), never funnel, SSH, routes or exit
    nodes, so her login page can't land on the public internet (AGENTS.md:
    boundaries are structural); and a Disconnect, Leave or switch asked
    for over her own tailnet address is refused (409, with the reason),
    the rule that a change never locks the administrator out. Her
    userspace device carries inbound connections to her; her own outbound
    traffic to tailnet peers (model hosts, machines) goes through the
    host's network as today, so a host that should reach peers over the
    tailnet joins it itself.
  - An administrator chooses the proxy in the control panel, under **Web
    access**:
    - **Direct** (2026-10-11), the mode she starts in: `lyricad` itself
      serves HTTPS on the machine's LAN addresses with a certificate it
      makes for those addresses (the one the external-proxy mode already
      makes; its fingerprint is shown in Web access and printed by the
      install script, for the browser's one-time warning), and the same on
      the host's Tailscale addresses (HTTPS too, since the login cookie is
      `Secure`). It is what a headless host is
      set up through, and it stays on until an administrator turns it off
      or another mode replaces it, so finishing setup without a tailnet
      never locks anyone out. Plain HTTP still never crosses the LAN.
    - **Tailnet** (2026-10-11), the default once the setup page has joined
      one: her tailscaled's `tailscale serve` terminates HTTPS for `<her
      name>.<tailnet>.ts.net` with a certificate from Tailscale (the
      tailnet needs MagicDNS and HTTPS certificates on) and proxies to
      the loopback port, as Caddy does. No domain, DNS record or token;
      the front door is 443 on her Tailscale address and that name.
      Built-in Caddy stays for a name under Li's domain and for the LAN.
    - **Built-in Caddy**, for a name under Li's own domain. Lyrica's install includes a pinned
      Caddy, built with the DNS plugins for several common providers, running
      as its own service. `lyricad` writes Caddy's whole configuration through
      Caddy's admin API, on a Unix socket only `lyricad` can use. The panel
      sets the name, which addresses to serve on (Tailscale, LAN), the DNS
      provider and its credentials, and shows the certificate's state.
    - **External proxy**: a Caddy, or another proxy, elsewhere on Li's
      network. `lyricad` also listens on one Tailscale or LAN address and
      accepts connections only from the proxy addresses listed in the panel.
      Over Tailscale the hop is plain HTTP inside WireGuard. Over the LAN it is
      HTTPS, with a certificate `lyricad` makes and the panel shows for
      pinning in the proxy. Plain HTTP never crosses the LAN. The panel gives
      a Caddyfile snippet for the proxy.
    - In external mode, `lyricad` keeps the extra listener's settings and its
      TLS key in a file only its service user can read, as Caddy does with
      its own keys. That way the unlock page is reachable while `lyricad` is
      locked. Until unlock, that listener serves only the unlock page.
  - A change never locks the administrator out. The old setup keeps serving
    until the new one has a valid certificate, and it comes back if the new one
    doesn't get one.
  - The DNS credentials are stored encrypted in `self.db`. Caddy keeps its own
    copy with its certificates, readable only by Caddy's service user, so it
    goes on serving, and the unlock page stays reachable, while `lyricad` is
    locked. Use a token limited to the one DNS zone.
  - Sandboxes never reach the front door. On the proxy's ports, they are
    refused this machine's own addresses, the external proxy's addresses, and
    whatever Lyrica's name resolves to when the sandbox starts.
- **Phones:** the web UI works well on a phone from the start.
- **One command, `lyrica`**, written in TypeScript like the rest of the
  project:

  | Subcommand | What it does |
  |---|---|
  | `lyrica serve` | Starts `lyricad`. This is what the systemd unit runs. |
  | `lyrica chat` | The terminal interface: a thin client of the running `lyricad` over a local Unix socket. Its threads are stored encrypted like any other interface's. |
  | `lyrica admin …` | Set up, manage users and administrators, change passwords and profiles. |
  | `lyrica mem …` | Search, show, add, edit and delete memories. Edits are typed at the prompt, never through a temporary file. |
  | `lyrica dev` | The developer bench. See below. |

  Passwords and passphrases are only ever typed at a hidden prompt, never
  passed as arguments or environment variables.
- **The developer bench (`lyrica dev`)** runs Pi's own terminal interface with
  the Lyrica extension loaded, for testing persona, prompt assembly and tools
  before `lyricad` exists, and for debugging afterwards.
  - It works only against a separate development runtime with test users,
    never real data, because Pi's terminal interface writes plaintext session
    files.
  - A debug flag prints the assembled prompt for each turn.
  - The same in-process setup, run headless, drives the continuity evals.
- Interfaces between components are in [docs/contracts.md](docs/contracts.md).

## Updates and self-editing

Every update can be undone without her, and she can change her own code
only through review. Decided 2026-10-11 from
`/mnt/project-files/self-edit/proposal.md`, which takes its deploy rules
from Monika's runbooks.

- **Releases.** Each version is built into its own read-only folder,
  `/opt/lyrica/releases/<commit>`, and `/opt/lyrica/current` points at the
  running one; the last 5 are kept. `install.sh` builds a release the same
  way, so a hand install and an update are one path.
- **The updater runs as root, outside her.** `lyrica-update` and
  `lyrica-rollback` are oneshot systemd units, not daemons, installed by
  `install.sh` only, never by an update, so a broken release can't break
  what removes it. The updater installs only a commit on `main`, fetched
  with a read-only deploy key; that is the line she can't cross.
- **An update**, in order: build the release as an unprivileged build
  user; **smoke test** it on a spare port with a scratch home and a test
  user, never real data; **drain**: stop taking new turns and wait until no
  turn, sleep run, subagent or child thread is working (new messages get
  "Updating", scheduled sleep waits, and what a running turn starts, such as a child thread, finishes first), giving up after 10 minutes with nothing changed, so a restart
  never cuts a turn in half; **snapshot** her databases and settings (copies
  of encrypted files; homes are left to the operator's backup), keeping the
  last 3; switch `current`; start; **probation**.
- **Probation.** The release must pass its checks once unlocked (every
  database opens, migrates and passes its integrity check, the workspace
  self-test, the model router,
  the web UI's files) and stay up 10 minutes. With saved credentials that
  happens at start; without them, at the first unlock. A crash loop or a
  failed check rolls back by itself and tells administrators in
  Notifications which commit failed, which check, and, when the snapshot
  was restored, from when messages were lost.
- **Rollback** goes back to the previous release: automatically in
  probation, from Administration, or with `sudo lyrica-rollback` on the
  console when nothing else works. Each database records its schema version and
  the oldest schema that can still read it: a migration that only adds
  (expand) leaves that alone, one that removes or renames (contract)
  raises it, and a release refuses a database it can't read. So only a
  rollback across a contract restores the pre-update snapshot, and what
  was written since leaves the app; its dialog says from when. A contract
  waits one release after its expand, so most rollbacks keep everything.
  A kept release that can't read the databases and is older than the last
  snapshot it could read can't be rolled back to; the dialog and the console
  say so and name the oldest release that can.
- **Her databases are never changed past undoing.** Each database migrates
  in one transaction and checks itself (`integrity_check`,
  `foreign_key_check`) before committing, so a failed migration leaves it
  as it was and the release fails probation instead. The updater checks
  each snapshot against its source before switching. The snapshot taken
  before a contract is kept for 30 days and until a later contract has
  passed probation, beyond the last 3, so damage found late
  still has a way back. A restore first moves the databases it replaces
  into the snapshots folder, still encrypted and kept as long, so what was
  written since the update is set aside, never deleted. A migration that
  removes or renames ships only after the release that stopped using it
  has passed probation, and its update note names it. CI migrates
  databases built at every released schema version (by code, never real
  data) and checks that nothing was lost and that, after an expand, the
  release before still opens them.
- **Update notes.** Every update installs an update note, never a bare
  commit: an annotated tag (`update/<date>`) on a `main` commit whose
  message lists the merged PRs since the running version, what each
  changes, any schema change and what a rollback would lose, and what to
  check afterwards. She writes it, or the Claude thread that built the
  change. It lives on GitHub, so no rollback or lost thread can take it; the
  updater keeps a copy beside the snapshot. It describes code, never
  conversations. After a failed probation, she writes the post-mortem as an
  issue linked to the tag.
- **Updates are manual.** An administrator presses **Update** in
  Administration. She can say an update is ready; she can't press it.
- **Git accounts and repositories** (decided 2026-10-12 from
  `/mnt/project-files/repositories/proposal.md`; replaces the
  administrator-named checkout). A **Git account** is a row in Settings
  like a machine: a kind (GitHub, Forgejo, Gitea or Other), a host, an
  account name, a token kept encrypted in `user.db` and never shown back,
  and a pool. Several accounts, two on one host included. A private account
  is self-hosted on her own network (LAN, loopback or tailnet, the private
  machines' check, with **Off network** and its dialog when that stops
  holding), never GitHub. A **repository** (`owner/name` and the account
  it uses) is granted to a thread like a folder: a Repositories row in the
  thread drawer and under This chat in Project settings, so every thread of
  the project gets them, narrower or the same; she may add one to a thread
  from an account of its pool, with the user's approval, like any change
  that reaches beyond the thread.
  Each thread clones its repositories into its own folder in the encrypted
  home workspace (`repos/<name>`), fetched at the start of a turn, so two
  threads never share a working tree. A clone goes only with its thread:
  when a repository leaves a thread (removed, narrowed away, its account
  removed or moved to the other pool), the credential stops at once and
  the clone stays, since it may hold her unpushed work and she deletes
  only what she downloaded. A
  sandbox run gets a repository's token only when the thread's pool is the
  account's, the thread has the repository, and the run can reach the host
  (internet on, or an allowed host); it travels in the environment only, as
  a git credential bound to that repository's URL, never on a command
  line or in a file, so two accounts on one host never mix. The forge
  clients are thin wrappers in the tools image: `gh` picks its token by
  the current repository's remote, so two GitHub accounts in one thread
  stay apart; `tea` reads its logins from a config file, so the wrapper
  writes one from the environment onto the run's tmpfs, gone when the run
  ends and never in the workspace, the one place a token touches a file.
  A repository or account taken away leaves running threads at once, as a
  folder or machine does. Tokens only, no SSH keys; `gh` for GitHub,
  `tea` for Gitea and Forgejo, plain git for Other.
- **Git etiquette** (Li, 2026-10-12). A short Git guide ships with the code
  and is in the prompt of every turn of a thread that has repositories:
  never commit on the default branch, one branch per piece of work named
  for it; small commits with clear messages, never a secret or private
  memory; fetch and merge or rebase the base before pushing, no force-push
  on a shared branch; a pull request, then wait for CI and never merge on
  red, using the forge's merge queue or auto-merge where there is one;
  delete merged branches. Project instructions override these defaults,
  and the guide says so. Her self-primer's section is the Lyrica-specific
  part on top of it.
- **Her own code** is the `xlc2022/lyrica` repository in her "Lyrica"
  project, with her own account, so every thread there clones it; a
  private thread can't have it, because her account is general and the
  code goes to the forge and CI. She works like a feature thread: one
  branch and one pull request per piece of work, typecheck and tests in
  her sandbox.
- **Her own GitHub account**, a collaborator with a fine-grained token for
  this repository (contents, pull requests), is one of her Git accounts.
  She pushes branches to the repository itself, never a fork, so her pull
  requests run the same CI as Claude's on Li's runners (docs/ci.md), with
  no first-time-contributor approval. `main` is protected: pull requests
  only, green CI, one approval from someone other than the author; nothing
  of hers merges without both. Li's own account may bypass the rules as
  administrator, because Claude's threads work through it and could
  never approve their own PRs.
- **Review is the project's.** Her PRs go through the same PR review (and
  UI review) as Claude's, which approves and merges them, so Li doesn't
  read every change. **Boundary code needs Li** (Li chose a rule over
  a gate, 2026-10-11): keys, the privacy boundary, the model router, the
  sandbox, authentication, deployment, the updater and CI. `CODEOWNERS`
  names Li for those paths, so GitHub asks for Li's review on any PR
  that touches them, and PR review asks Li before approving one of hers.
  Claude's reviews act through Li's account, so GitHub can't tell the two
  approvals apart: this is a rule the reviewers follow, not a gate. She
  may push only `lyrica/*` branches and `update/*` tags.
- **Working alongside Claude.** One repository, one set of rules
  (AGENTS.md), one review. Work is claimed as a GitHub issue with one
  assignee, her account or Li, so two never build the same thing; she
  takes what she notices in use (the friction log from PRINCIPLES.md's
  Evaluation, small features, her own tooling), Claude's threads take
  briefs. Her branches are `lyrica/*`, Claude's `feature/*` and `claude/*`. Whoever
  merges second merges `main` in first. She can't reach Claude's threads;
  an issue labelled `claude` is how she asks for something, and a PR
  comment how she answers a review. Design changes go through the design
  owner as they do now, and Li decides. An update note covers everything
  merged since the running version, Claude's PRs included.
- **Her own project.** She starts with no memory of how this project
  runs, so the handoff is written down: a project "Lyrica" in her own
  Projects, with instructions mirroring this project's (one issue and one
  thread per piece of work, handoffs, review, hard rules) and pinned
  standing threads, Review, UI review and Friction log, that review her
  work before it reaches Claude's review
  ([briefs/lyrica-project.md](docs/briefs/lyrica-project.md)). A routine
  in Claude's project picks up her PRs and `claude` issues from GitHub.
- **GitHub is replaceable.** She reaches the forge only through git and
  its command-line client in her sandbox (`gh` today), with no tool of
  her own; the updater needs only git and a read-only key; update notes
  are git tags; CI is Actions-syntax workflows. Moving to Forgejo or
  Gitea means adding a Git account of that kind, re-creating her account
  and branch protection there, running their Actions runner on Li's VMs
  with the same label, plus `CODEOWNERS` and the branch limit in that
  forge's own rules; the client (`tea`) follows the account's kind. Claude's project threads
  are the part that is tied to GitHub.
- **The outer net is the operator's:** a scheduled Proxmox backup of the
  container. The updater can't snapshot the container it runs in.
- **Not covered:** her persona, which has its own revisions; model hosts,
  which keep `host/install.sh` until this has proved itself.

## How the project runs

- **Claude does most of the rebuild.** Lyrica edits herself with other models
  only once she is usable again.
- **The design thread** (the "Agent harness design principles" session) owns
  PRINCIPLES, this document and the contracts, and keeps coding to a minimum.
- **Feature threads** are separate Claude Code sessions tagged `project:lyrica`:
  Core, Memory, Workspace, Models, Delegation, Daemon, Web UI, Sleep,
  Integrations, Model host, Models 2, Images, Delegation 2, Child
  threads, Modes and Projects.
  - Each works from a brief in `docs/briefs/` on its own branch and ends with a
    pull request.
  - No more than two or three are active at once.
  - Sessions hand off through the repo (briefs, docs, PR descriptions), never
    through chat transcripts.
- **The cheapest model that does the job well.** Before starting a thread or
  subagent, judge how hard the task is.
  - Work that builds or reviews a boundary (privacy, cloud, sandbox, keys,
    authentication) uses the strongest model.
  - Small, well-specified work uses a cheaper model: copy changes, a UI page
    from a finished mockup, a mechanical refactor, running checks.
  - A cheaper model gets a complete prompt: the files to touch, the exact
    change, how to check it, and what to leave alone.
  - Checks that need no judgement (test runs, screenshots) are done directly,
    without a subagent.
- Contributor rules for everyone, including other models and later Lyrica, are
  in [AGENTS.md](AGENTS.md).

## History

Points where the design reversed an earlier choice. Don't reopen them without
new evidence.

- **Restart (2026-10-09).** v1 had grown to about 41,000 lines for one user:
  12 compose services, 37 slash commands, 14 model tools and 48 SQL tables.
  - Most of it was policy machinery: accounts, session presets, memory tiers,
    forgetting receipts, leases and a delegation ledger.
  - Meanwhile the persona called her a secretary with no calendar or task
    tools, and her `SOUL.md` was 14 lines.
  - The pieces were careful; there was no single thesis to rank them against,
    so each review added guards and nothing was removed.
  - **Kept:** the persona seed, topic routing, and the WAKE/journal shape of
    sleep.
  - **Left behind:** v1's session-policy presets, the General/Sensitive tiers,
    the controller with leases and fences, the delegation ledger, and
    forgetting receipts.
- **Plain files in git → encrypted SQLite (2026-10-09).** Readable markdown in
  a repository wasn't private enough.
- **No accounts → personas as users (2026-10-09).** Li's personas need
  separate credentials and fully separate data.
- **"Spaces" → users with general and private pools (2026-10-09).** This is
  simpler than per-space flags, and private reading general is safe because
  private runs only on local models.
- **Local-only scope narrowed for general threads (2026-10-09).** In a general
  thread, local-only covers that conversation's own model calls, not its later
  memory.
- **Own `delegate` rather than `pi-subagents` (2026-10-09).**
  - `pi-subagents` 0.76 is about 15,500 lines of source.
  - It writes child transcripts, event logs and run receipts to disk in
    plaintext, and runs background children in a separate process.
  - It resolves models outside our router.
  - Monika needed a 4,800-line patch to fit it to her needs.
  - Our needs (encrypted storage, `lyricad` as the only writer, the
    local-only router, sandboxed tools, nested threads in the web UI) don't
    fit it. A feature-complete version of our own is estimated at 1,500 to
    2,500 lines on Pi's SDK.
  - We borrow its role prompts and feature list, not its runtime.
- **Personas → users who may be different people (2026-10-09).** Li's
  partner may use Lyrica too. Switching without a password is now limited to
  linked users, persona proposals need the originating user's consent before
  an administrator sees them, and staying unlocked after logout is a per-user
  choice.
- **Model host: native install → containers (2026-10-09).** The Blackwell
  machine is Li's personal workstation. A Compose stack keeps the GPU stacks
  pinned and apart from the rest of the machine, with images per GPU vendor,
  and is easy to add or remove. Windows isn't a model host. `lyricad` stays
  native.
- **Image models: files → recipes (2026-10-09).** Most image models need
  several files that work only together, and many share parts. Lyrica can't
  be asked to choose encoders and VAEs, so the user settles them once in a
  recipe. The image library is separate from the text one.
- **Model downloads: one-off container → fetch service (2026-10-09).** The
  host has no Docker socket, so nothing could start a one-off container.
  Downloads also became open-ended (Hugging Face, ModelScope, links) instead
  of a pinned catalogue, so the checks moved into fetch: file formats,
  checksums and addresses.
- **Tool budget raised from 6 to 8, then to 30 (2026-10-09).** First to make
  room for web research, then because Lyrica works like a coding agent (files,
  commands, SSH). The budget still exists so that every tool has to justify
  itself.
- **Remote machines: "much later" → now (2026-10-11).** Working on Li's
  other computers was deferred until she had proven reliable. It comes
  forward as an extension of the SSH targets that already exist, with each
  machine starting at Ask and loosened one at a time, and Proxmox through a
  narrow API token rather than a root shell. The node that runs her own VM
  still waits.
- **NixOS (2026-10-11).** Li asked to deploy to NixOS, as a flake. The flake
  packages lyricad and exports a NixOS module that declares what the install
  script does; nixpkgs packaging was left out while Lyrica changes daily.
  NixOS has no `/usr` to share, so sandboxes get the module's tools as
  `/usr` with only their closure in `/nix/store`, because the whole store
  holds generated system configs. Li chose the same Update button on NixOS
  (through a Lyrica-only Nix profile) over updating only with
  `nixos-rebuild`. It is documented in daemon.md, not a page of its own.
- **Operator guides added to the docs budget (2026-10-11).** Li asked for
  human-readable documentation on running Lyrica: bootstrapping her on a new
  system, deploying model hosts, adding CI runners. They live in
  `docs/guides/`, one page per task, written from the scripts and the
  component docs. They follow the component docs and never replace them: a
  behaviour is described once, in its component's page, and a guide says
  which steps to take and what has not yet been exercised. They are kept
  current by the Operator docs thread, on notice from threads whose merged
  PRs change what an operator does by hand, and by a weekly drift check.
- **Updates: copy over → releases with rollback (2026-10-11).** `install.sh`
  replaced the code in place, so a bad update could only be fixed by hand.
  Li asked for a way for Lyrica to edit herself without permanently breaking
  her installation; every update now keeps the previous release and a
  database snapshot, and rolls back by itself. Her code changes go through
  the same review as Claude's.
- **First run: a CLI step → the setup page (2026-10-11).** `lyrica admin
  init` at a terminal, then an SSH tunnel, Start unlocked, Web access with
  a domain and a DNS token, and Endpoints stood between installing her and
  her first word. Li asked for the web UI to do it: `lyricad` now starts
  without `self.db` and serves the setup page, behind a one-time code; the
  tailnet is joined from that page and managed from Administration instead
  of by hand, with a tailscaled of her own so she is a device of her own
  and the host's membership is never hers to break (Li's question and PR
  review, the same evening), a Direct mode serves a headless host's setup
  page over HTTPS on the LAN, and a Tailnet web access mode through
  `tailscale serve` replaces the domain and DNS token for the common case.
  She also gets a name per deployment, so two installs can be told apart.
