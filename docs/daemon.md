# lyricad

`lyricad` is the one long-running process. It unlocks, logs users in, hosts
their threads as in-process Pi sessions, and serves the HTTP and SSE API the
web UI is built on. Code: `daemon/src/`. Every request, response and event
type is in `daemon/src/api.ts`, with its route beside it.

## Starting and unlocking

`lyrica serve [--runtime <dir>] [--port <port>]` starts it. It listens on
`127.0.0.1` only (default port 7340) and on a Unix socket,
`<runtime>/lyricad.sock`, mode `0600`. The socket serves the same API to local
clients; they still log in.

- It starts **locked**. Until `self.db` is unlocked, only `GET /api/state`
  (locked and the users; lyricad's `version` from `package.json` and
  `build` from `LYRICA_BUILD` or the git commit join it once unlocked, so
  the unlock page gives away no commit) and `POST /api/unlock` answer (and the web UI's static files, so the unlock
  page loads); everything else is `503`.
- Run by hand in a terminal, it asks for the passphrase at a hidden prompt.
- With a saved passphrase (below), it starts unlocked.
- When unlocked it builds `Workspace` with its own port as `excludePorts`, and
  runs `selfTest()`. If network is refused, the reason is logged and shown to
  administrators (`GET …/admin/status`).
- On SIGTERM it stops every subagent run, sleep and turn, disposes sessions,
  unmounts home workspaces, drops keys, closes `self.db` and exits.

## Saving credentials

"Save credentials" uses systemd credentials. `lyricad` seals a secret with
`systemd-creds encrypt` (to the TPM where there is one, else the host key),
reading it on stdin, into `<runtime>/credentials/<name>`. The unit loads that
directory with `LoadCredentialEncrypted=lyrica:…`, and systemd unseals each file
at start into `$CREDENTIALS_DIRECTORY/lyrica_<name>`, readable only by the
service.

- `self`: the `self.db` passphrase. An administrator saves it with
  `PUT …/admin/passphrase` (typing the passphrase, which is checked first).
- `user-<id>`: a user's data key, saved by that user with
  `PUT …/me/credentials` (`Keyring.saveUserKey`). At start `lyricad` takes
  every saved key and mounts those users' home workspaces, so sleep can run.
- Turning either off deletes the sealed file. The unsealed copy lasts until
  the service stops.
- As a non-root service user it seals with `--user`, which needs systemd 256
  or later. No root step is needed.

## Logging in

- `POST /api/login` checks the password, unlocks the user's key and mounts
  their home workspace. It sets `__Host-lyrica`, a random 256-bit session ID,
  `Secure; HttpOnly; SameSite=Strict`, for 30 days. Sessions live in memory
  only; a restart logs everyone out.
- **A session ID is never reused for someone new.** Every login gets a fresh
  session and cookie, and the old session ends; a session left with no users
  (after logout, Lock or an unlink) ends at once. A copied cookie can never
  come to hold a user who logs in later.
- **One browser, one person.** A session holds a set of users that are all
  linked: users of the same person, linked with both passwords
  (`…/links`; an unknown login costs the same Argon2 as a known one).
  Everything a user owns is under `/api/u/:userId/…`, and the session must
  hold that user. Logging in as a linked user brings the session's users
  along into the new session, and switching is just using the other path;
  logging in as anyone else leaves them behind (`replaced: true`, without
  naming them). Unlinking takes the other user out of every session that
  holds both.
- `POST /api/logout` ends the session, or with `userId` removes one user from
  it. The key stays in memory, so sleep can run, unless the user turned
  "stay unlocked" off (`…/me/stay-unlocked`, in their `user.db`): then it is
  dropped as with Lock, once no other live browser session holds them. The
  same happens when a session expires, or when an unlink takes the user out.
  The response lists who stays unlocked because another session holds them.
  `Me.warning` points out saved credentials with stay-unlocked off: the key
  then comes back at every start.
- **Lock** (`POST /api/u/:userId/lock`) at once removes the user from every
  session, stops their subagent runs and sleep (which record how they ended), drops
  their key, then stops their threads and unmounts their home. Event
  streams check the session with every event and every few seconds, so
  logout and Lock end them.
- Login, unlock, password changes and linking are rate-limited per login
  name and per address: three failures are free, then each attempt waits twice as long as
  the last, up to 15 minutes (`429` with `Retry-After`). Behind Caddy, the
  address is the last `X-Forwarded-For` entry.
- One attempt per login name and per address runs at a time; others get
  `429` at once, so parallel guesses get no free tries. An unknown login
  still runs Argon2 (against a dummy key), so the time taken doesn't reveal
  which names exist.
- Every POST, PUT, PATCH and DELETE needs an `Origin` whose host matches the
  `Host` header; user routes also need the cookie. There are no CORS headers.
- Every response carries `Content-Security-Policy: default-src 'self'`,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `nosniff`.

## Threads

Each active thread is one Pi session from `openThreadSession`, with
`createLyricaExtension` and the workspace tools, through the thread's own
`openThreadView` and `CallContext`.

- A session opens on the first message and is disposed after 15 idle
  minutes. Entries are stored as turns end, so reopening loses nothing. With
  no stream open, the thread's whole record (with its event buffer) goes too.
- One turn runs at a time. A message sent during a turn waits; queued messages
  go together as the next turn. **Stop** aborts the turn, denies waiting
  permission requests and drops the queue.
- Before each turn the chat model is chosen again (`prepare`,
  [models.md](models.md)): a machine that is away is passed over for the next
  model in the list, the thinking level is set, and the call is recorded. A
  connection error, or a reply cut off mid-stream, marks that endpoint down,
  and Pi's retry goes to the next model in the list. The next turn waits for
  that choice to finish.
- **No model reachable.** When every model in the chat list is away, the
  stream gets `offline` (the task and what was tried) instead of an error.
  If the turn hadn't started, nothing is stored: the message waits in the
  queue, and every 30 seconds (`offlineRetryMs`) lyricad asks the machines
  again and sends it as soon as one answers, or at once when the thread's
  settings change. A new message goes with it; Stop drops it. If the machine went away mid-turn, Pi's retry is called
  off and the turn ends. A title whose models are all away is tried again
  after a later turn.
- `lyrica serve` logs an unhandled rejection (its class and first line) and
  keeps running, so one thread's failure never takes the others down.
- **Context and pace.** Each hosted thread has a `ContextMeter`
  (`extension/src/context.ts`), fed by the Lyrica extension from Pi's events:
  - Per request: time to first token, generation time and usage.
  - At the turn's end: the measured total from `getContextUsage()` and an
    estimate of each part, using Pi's `estimateTokens` and the prompt sections
    `assemble` made. The parts are persona (with topics, who she's talking
    with and the time), about, memory (WAKE, the page index, folder pages),
    pinned (0 until pins exist), recall, tools (definitions and guidance) and
    the conversation. They're scaled to add up to the measured total, then
    Pi's reserve and the free space fill the window.
  - After each turn `lyricad` records the pace on the call (`recordPace`) and
    sends a `context` event. `GET …/settings` returns `context`, from the open
    session or, with no breakdown, from the last call record: its last prompt
    plus its output. The record keeps the output for the whole turn, so after
    a turn with tool calls this reads a little high.
- **Her status line.** Each turn's context message carries one line of
  numbers in `<context>`, such as
  `Context 64% of 32k · 9.1k free · 38 tok/s · 2.1k tok/s prompt`. Free is
  what's left before Pi's own compaction. A second line tells her to finish
  the step, save what matters and compact with a summary, then to compact
  now. They follow Pi's edge (100% − reserve): "compact now" 2 points before
  it, the first line 15 before that, at most 90% and 75%. From 32k up that is
  75% and 90%; on 8k, 70.5% and 85.5%. The `threads` tool's guidelines say once what the line means.
- **Compacting herself.** `threads({ action: "compact", summary })` takes her
  summary. Every hosted thread but a subagent's has the tool, a child thread
  too.
  - A summary too long for Pi's reserve is refused with the limit. A short one
    (under 400 characters) becomes the notes for Pi's own summary.
  - The compaction runs when the turn ends, since Pi's `compact()` would stop
    the turn that asked for it. If the turn was stopped, it doesn't run: Stop
    means stop. `session_before_compact` hands Pi her summary
    as the result, and Pi cuts the old entries and keeps the recent ones.
  - The compaction is stored, and the stream gets a `compacted` event with the
    tokens before and (estimated) after and the summary. The message list
    shows it as a `notice` with a `compacted` part.
  - Pi's automatic compaction at the window's edge stays on as the safety net,
    with Pi's own summary, which keeps the goal, progress and next steps. It
    shows the same marker.
- Changing a thread's settings reopens its session after the current turn,
  and its open views get `settings`. Workspace settings (mode and switches
  included) are read on every tool call, so they apply at once.
- A new thread starts in the user's default mode (`GET`/`PUT
  /api/u/:userId/mode`).
- After the first exchange, an untitled thread gets a title from the `title`
  task model, through the thread's own model runtime.
- Settings are checked when saved, and refused whole with the reason: a cloud
  model in a private or local-only thread, a private thread made not
  local-only, a subagent wider than its parent, a folder outside the allowed
  paths, a host that matches everything.
- **Branch from here** (`POST …/messages/:n/branch`) makes a child thread
  with the conversation up to message `n` (`branchThread`), and gives it
  the thread's models, local-only switch and workspace settings, which it
  can then only narrow.
- **Pins** (`PUT` and `DELETE …/messages/:n/pin`) pin or unpin one of the
  user's messages or her replies (`400` for any other entry, `409` in a
  subagent's thread). `GET …/pins` lists the thread's pins, oldest first,
  and whether they're over the pinned budget (`shortened`). Messages carry
  `pinned`.
- **Rewinding** (`POST …/messages/:n/rewind`, `RewindRequest`): `delete`
  removes message `n` and everything after it; `regenerate` removes her
  reply's turn from its user message and sends that message again;
  `edit` removes from the user's message `n` and sends the new text.
  `Regenerate with…` first sets the thread's chat model, which the router
  checks, so a cloud model in a local-only thread is refused before anything
  is removed. It holds the thread's turn (`409` while one runs): the session
  closes, subagents started in the removed turns are stopped and forgotten
  (`Delegation.forgetSubagents`), the entries go (`truncateThread`), and
  every view gets `rewound` (the first removed number, and whether a message
  is sent in their place). Messages sent meanwhile wait and go after it. Not
  in a subagent's thread.
- **What removed turns did** (`daemon/src/removal.ts`). With `preview` the
  rewind changes nothing and answers a `RemovalPlan`: how many messages,
  pins and subagent threads go; the files her write and edit calls made or
  changed in those turns and their subagents' (delete, restore, or keep
  because something changed them since or the thread works elsewhere now);
  uploads only the removed messages mention (sandbox only); git branches
  made by their commands or their subagents' worktrees, ticked unless they
  hold commits no other branch has; and their first 20 commands, listed, not
  tracked. The rewind itself undoes every ticked item not in `skip`, in its
  held turn before the entries go, and drops the change records.
  `RewindResponse` counts the pins, files and branches. Branches are found
  by a pattern on her commands (`git checkout -b`, `switch -c`, `branch`),
  best effort. A missing message is `404`; a subagent's thread
  can't be branched (`409`).
- Forgetting a thread forgets its subagents' threads with it, deepest first,
  stopping their runs and dropping their records (`Delegation.forget`). With
  `{ children: true }` (`ForgetThread`) its child threads go too; otherwise
  they are kept as threads of their own and detached from its workspace.
- **Child threads** (`ChildThreads`, [delegation.md](delegation.md#child-threads)):
  every hosted thread gets the `threads` tool. A child is hosted like any
  thread; `ThreadHost.status` says working, waiting or idle, and
  `onTurn` keeps its record. Its summary has `child`, `status` and `unseen`
  (updates not yet seen; reading its messages sees them). Lock stops working
  children before the key goes.
- **Projects** ([delegation.md](delegation.md#child-threads), DESIGN.md
  "Projects"). `POST threads` with `project` and an optional `goal` makes a
  project, and `PATCH` with `project: true` makes one of a top-level thread
  (no way back); either pins it. `PATCH` also sets `goal`, `instructions`
  (kept on the project page apart from sleep's text), `paused`,
  `threadsModel`, `threadsThinking` and `threadsFallback` (the model,
  thinking and Fallback its new threads start with; each null follows the
  project chat), and `watchThreads` (on unless turned off; see
  [delegation.md](delegation.md#child-threads)). `projectSettings.pageId` is the
  project page's memory ID, for the memory browser. Pausing or hiding stops its working threads; a
  message to a paused project's thread is `409`. **Start a thread** (`POST
  …/messages/:n/thread`, optional `title`) starts a thread of the project
  from message n, with its text as the task. `POST …/resolve` and
  `…/reopen` act on a project's thread; `POST
  …/suggestions/:callId/start` starts one (`index`) or all of a Suggested
  threads card's threads, each once. `GET …/overview` lists its threads, how
  many wait on the user, its total tokens and which suggestions were
  started; `models/calls?project=&pool=` its calls. A project's thread's
  summary has `state`, `anchor` and `needsYou`; the project chat's stream
  gets a `child` event when one of them changes. Deleting a project with its
  threads forgets its page and the notes that came only from it first.
- **Pins:** `PUT` and `DELETE …/pin` pin a thread for the user (`user.db`
  `pinned_threads`), and `ThreadSummary.pinned` says so.
- Thread lists are per interface (`web` by default), filtered by the user's
  display settings (which pools, hidden threads, the sidebar's `sort`, and
  `projects`: all, only projects, or none), pinned threads first, then
  most recently active, with child threads (Lyrica's, branches, forks,
  copies) nested under their parent. Each summary carries the user's own
  `group` and `unread` (`thread_groups` and `thread_prefs` in `user.db`,
  `core/src/prefs.ts`; never in the pool): `PATCH threads/:id` sets them,
  reading a thread's messages clears `unread`, and `…/thread-groups` lists,
  adds, renames and removes groups. Subagents aren't listed: they live in
  their parent's `delegate` cards. Memory search honours the same pool filters; `?all=1` ignores
  them in both.

## The event stream

`GET …/threads/:pool/:threadId/events` is one SSE stream per thread. It
carries text and thinking deltas, tool calls (start with arguments; end with
the first lines of the result), recall and remember markers, permission
requests and their outcome, usage, errors in plain words (a model the router
refused, an endpoint that didn't answer), `offline` when no model could be
reached, the queue, the title, `settings`
when the thread's settings changed (an approved plan switching its mode),
and turn end, then the thread's `context` after each turn and a `compacted`
marker when it compacts.
A subagent run's events (started, output, tool calls, questions, notes,
usage, finished, stopped, interrupted) go out as `delegation` to the parent
thread's stream and to the subagent's own thread's stream. What a run
delivers into the thread (a background result or question, a note, a user's
message to a subagent) goes out as `notice`, with its status and threads,
and is stored: the message list shows it as a `notice` message.

## Subagents

`lyricad` builds one `Delegation` (Delegation's default limits). Every hosted
thread under the depth limit gets the `delegate` tool
(`createDelegateExtension`), which attaches the live session, so a
background run's result reaches her at once: appended if she is idle, as a
follow-up if she is busy. With no live session it goes into the stored
thread. `GET …/threads/:pool/:threadId/subagents` lists a thread's runs and
their total tokens.

**Writing to a subagent.** `POST …/messages` on a subagent's thread (what
its card's message box does)
goes to `Delegation.message` as the user's message, never to a session of its
own: it joins the subagent's work, answers its question, or continues it,
and the parent thread gets a note. Only the owner of the parent thread gets
there (the subagent's thread is in their pool), and a parent that's gone, or
a subagent that can't take the message now, is `409` with the reason. Its
stored messages carry `from`: Lyrica, or the user by their current name.
Stop in a subagent's thread denies its waiting requests and stops its work. `…/roles` and `…/workflows` read and change the user's
custom roles and saved workflows (`DelegationStore`, in `user.db`).

Event IDs are `<epoch>-<n>`; the epoch changes with every start. A reconnect
with `Last-Event-ID` replays from a buffer of the last 500 events. If that's
impossible, the stream starts with `reset` and the client reloads messages
from `…/messages`, which pages through stored entries.

## Permission prompts

Where the thread's mode asks (and for irreversible tools in any mode), the
workspace tools' `tool_call` hook (`extension/src/workspace.ts`) calls the
thread's `approve`. `lyricad` sends a `permission` event to every open view
and waits for `POST …/permissions/:requestId` with `allow`. Nobody answering
in 5 minutes, or Stop, denies. A view that opens later sees waiting requests
in `hello`.

A plan from Plan mode is a request with `tool: "propose_plan"` and `args: {
plan }`. Approving it takes `mode` too (`ask`, `acceptEdits` or `auto`;
without it the answer is refused); `lyricad` switches the thread to it and
sends `settings`. Denying it, a timeout or Stop keeps planning.

A call on a machine adds `machine` and `cwd` (a `proxmox` call has no
`cwd`); the answer covers exactly that command, path or Proxmox action
there. A suspect command, or a Proxmox `stop` or `reboot`, adds `suspect:
true` and `warning`, and its answer may carry `allowInThread: true`, which
stores that exact command (or action on that VM) for the thread it runs in (a subagent's own thread for a subagent's
request); `allowInThread` on any other request is refused.

A subagent's request (`ThreadHost.approveSubagent`, given to `Delegation` as
`approve`) is one request shown in its own thread and its parent's, with
`subagent` naming the run, thread and role. Either thread's views may answer;
the first answer wins, and both get `permission_end` (a later answer is
`404`). A timeout, Stop in either thread, or the subagent being stopped
denies it.

## Uploads

`POST …/threads/:pool/:threadId/uploads?name=<file>` with the file's bytes
(up to 50 MB) saves it with `Workspace.saveUpload` into the thread's
`uploads/`, and answers with the path she sees (`/workspace/uploads/<file>`).
The name is cleaned (no path, no control characters), and a name already
taken gets a suffix (`image-2.jpg`) rather than overwriting.

## Files

The Files panel (DESIGN, "Files and images") reaches a thread's folder and its
grants only through `Workspace.files(t)`, so every listing, read and change
runs in the thread's sandbox: no host path is ever handled by `lyricad`, and
a symlink she left can't point the panel outside. Types and routes are
documented in `daemon/src/api.ts`, "The Files panel".

- `GET …/threads/:pool/:threadId/files?dir=<path>` lists one folder (the
  thread's `/workspace` without `dir`), folders first, with the roots: the
  thread's folder, then each granted folder with whether it is writable. A
  project thread's project folder is one of its grants, so it shows as a
  root. Listings stop at 2,000 entries (`more: true`); the panel's own
  `.lyrica` folder is hidden.
- `GET …/files/search?root=<path>&q=<text>` finds names containing the text
  under a root (at most 200). `GET …/files/images` lists every image in the
  thread's folder, `uploaded` when it is in `uploads/`, otherwise `made` by her.
- `GET …/files/content?path=<path>[&download=1]` streams the file with its
  type: images by their bytes, text by extension, and HTML, SVG and scripts
  as `text/plain`. Every answer carries `Content-Security-Policy: default-src
  'none'; sandbox` and `nosniff`, so a served file never runs as a page.
  `download` makes it an attachment.
- `GET …/files/thumb?path=<path>` serves a copy of an image in the thread's
  folder at most 320 px on a side (PNG, or JPEG for a JPEG), made by
  ImageMagick (`magick`, or `convert` on ImageMagick 6) inside the sandbox
  and kept under `.lyrica/thumbs` mirroring the image's path, remade when
  the image is newer; a delete or rename takes the copies under its path
  along. Only a file named `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`, decoded
  as that format and nothing else (so a renamed MVG or SVG fails instead of
  running), under ImageMagick's memory, area and size limits and a 20 s
  timeout. For a grant's file, or on a
  host without ImageMagick (it is in the Debian install and the NixOS sandbox
  tools), 404: the panel shows the image itself.
- `POST …/files/upload?dir&name` (the bytes), `POST …/files/folder { path }`,
  `POST …/files/rename { from, to }`, `POST …/files/delete { paths }` change
  the thread's folder and read-write grants. A read-only grant, a root itself,
  `.lyrica`, or a path outside the thread's folders is refused with 403; a
  taken `to` or a missing file is 400 with the reason. Deleting is permanent.
- `POST …/files/zip { paths }` answers `application/zip`, built in Node as it
  streams from `cat` in the sandbox: nothing is written to disk, and no zip
  tool is needed in the sandbox.
- What the panel adds or removes is noted in `user.db` (`panel_files`), and
  her next turn's prompt gets one line naming it ("Since your last turn, in the
  Files panel, the person added … and removed …"), then the notes are cleared.

## Speech

Dictation and Read aloud (see [models.md](models.md) Speech). Types are in
`daemon/src/api.ts`; the work is in `daemon/src/speech.ts`.

- `POST …/threads/:pool/:threadId/transcribe?language=` with an `audio/wav`
  body (16 kHz mono, at most 10 minutes, 413 beyond, 415 for another type)
  answers `Transcription { text, seconds, model }`. `POST
  /api/u/:userId/transcribe?pool=` does the same on the welcome page, with
  the user's defaults for a new thread. The clip is held in memory only.
- `GET …/threads/:pool/:threadId/messages/:n/speech` reads one of her
  messages aloud. lyricad reads it from the store (the client sends a
  number, never text), reads each thread she mentions as its current title
  (`titlesIn`), drops code blocks, tables, images, links' URLs and
  markdown, splits it into sentences (pieces of at most 400 characters), and
  asks for one sentence at a time while the one before plays, each in the
  voice for its language (Han characters mean Mandarin). It streams raw PCM
  (`audio/pcm;rate=24000;encoding=s16le;channels=1`). `messages/live/speech`
  follows the message she is writing now (`HostedThread.following()`) to
  its end; when she is writing nothing (she finished as it was pressed), it
  reads her last message. Closing the connection, Logout or Lock stops it and cancels the
  model's work. One call record per reading, with the seconds of audio.
- Refusals come before any audio, as JSON: `NoModel` and
  `CloudModelForbidden` are 400, `Offline` (every model set is down) is
  502; a message that isn't hers is 400, a missing one 404.
- `ThreadSettings.speech` (and `GET /api/u/:userId/speech?pool=` before a
  thread exists) says whether each task can be used now, or why not, for
  the mic's and Read aloud's state. Dictation and Read aloud are thread
  tasks (`THREAD_TASKS`), chosen with `ThreadSettingsChange.models` like the
  others; a thread's own Dictation pick may be a cloud model, and without
  one Dictation uses the local profile's. A thread Lyrica starts from
  another doesn't inherit its Dictation pick.
  `Profiles.readAloudLive` (changed with `ProfilesChange.readAloudLive`, off
  by default) is Read aloud while agent writes; `Speech.readAloudLive`
  carries it so the web knows whether to offer `messages/live/speech`.
- **Fallback.** `ThreadSettings.fallback` is the thread's switch (null
  follows `Profiles.fallback`, on by default) and `fallbackOn` what applies;
  `ThreadSettingsChange.fallback` changes it. Off, only the first model in
  each of the thread's lists answers ([models.md](models.md#choosing-a-model)):
  a message to a thread whose model is away waits, as under **No model
  reachable**. A branch or subagent starts with its parent's.
  `Profiles.sleepFallback` (`PATCH profiles`, `sleep.fallback` in `user.db`)
  does the same for sleep's phases.
- `ThreadSettings.answered` skips speech calls, so the context meter reads
  the chat call.

## Memory browser and settings

The memory browser goes through `openOwnerView`, opened and closed per
request. Memories are sent in stored form, with mention tokens, plus a map of
users, so the UI renders current names and edits keep the tokens. It covers
search, lineage, edit, restore, the four deletion levels and user-introduced
notes and pages. The settings API covers profiles (with accent and monogram),
display settings (in `user.db`), passwords, endpoints, model hosts (pair,
pair again, addresses, status, pause, resume, restart, management,
downloads, the image library), the text library, hub tokens (last four
characters only), the Models page overview (`GET …/models/page`, endpoints
with live status, at most 3 seconds each, and none asked again while it was
seen down in the last 30 seconds), offerings, model
groups, Clean up and the models notice, the three profiles with the default
profile and thinking level, recent calls, network
defaults, machines, and for administrators users, allowed paths, shared
endpoints, the sleep time (`sleep.time` in `self.db`'s `settings`) and persona
proposals.

**Persona proposals** come from one user's conversation or dream, so they
may carry that user's details. They start as drafts in that user's `user.db`
(`PersonaProposals.propose`, which takes the thread's own view, so whose a
proposal is comes from the store, never from the caller), which only they
can read: `…/proposals` lists, edits, drops and sends them on. Sending puts
one in `self.db` for the administrators (`…/admin/proposals`), marked with
who sent it and whether they edited it. A proposal from an administrator's
own conversation goes there at once. Each keeps the file's revision it was
drafted against: if the file has changed since, approving it needs
`overwrite`, so newer changes aren't undone unseen.

## Sleep

`lyricad` builds one `Sleep` ([sleep.md](sleep.md)) and runs it three ways:

- **At night.** At `sleep.time` (local time, default 04:00) it sleeps every
  user's general pool, then private pool, one at a time
  (`Lyricad.sleepNight`). A user in manual mode is left out; a user without
  a key, or a pool with nothing new, is skipped with the reason.
  Before that, it prunes gone models nothing names (`Models.prune`,
  [models.md](models.md)), and sweeps each mounted user's home workspace
  ([workspace.md](workspace.md), "The nightly sweep").
- **`/sleep`.** `POST …/sleep/:pool`, or the text `/sleep` sent to a thread
  (which sleeps the thread's pool and starts no turn). In manual mode it
  answers `confirm` unless confirmed, and once the run ends a fresh thread
  opens in that pool (a `thread` event). Whatever would stop the run at once
  (no key, every sleep model's machine down, nothing new) is a `409` in
  plain words, and the skip is recorded. Each phase's machine is asked
  first, so a sleep list falls back past one that is off.
- **The Sleep section.** `GET …/sleep` gives the mode (`sleep.mode` in
  `user.db`, set with `PUT …/sleep/mode`), the time, open items and recent
  runs of both pools. `GET …/sleep/:pool/runs/:runId` gives one run: notes she
  caught up on, pages with their text before and after, questions, the dream,
  WAKE and items. `POST …/sleep/:pool/items/:itemId/chat` starts a web thread
  from an item and has her speak first; `DELETE` dismisses one.
  `GET …/sleep/events` streams `started`, `phase`, `finished` and `thread`.

Lock and shutdown stop a running sleep before the key goes; the run is
recorded as partial and resumes next time.

## Logs

One line per request: method, route pattern (never the path, which holds
IDs), status and time. Failures log the error's class and first line. Sleep
logs the pool, the status or skip reason and the time taken. Message, memory
and file text never reach the log.

## Web access

How Lyrica is reached from other machines, set by an administrator
(`…/admin/web-access`, with `/status` and `/snippet`). Code:
`daemon/src/web/`. The mode, name and built-in settings live in `self.db`
under `web.access`, so the DNS credentials are encrypted with the rest of it.
Secret credentials are never sent back by the API (only whether they're set)
and never logged; a Caddy error that quotes one has it replaced with
`[hidden]`. Changes run one at a time.

- **Off** (the start): only `127.0.0.1` and the Unix socket.
- **Built-in Caddy.** The administrator picks the name, the Tailscale and/or
  LAN addresses to serve on (detected from the host's interfaces), the DNS
  provider and its credentials, an optional ACME email, and Let's Encrypt
  staging for testing. `lyricad` writes Caddy's whole JSON config through its
  admin socket (`POST /load`): HTTPS for the name on those addresses (no
  port 80), a DNS-01 certificate through the provider, and `reverse_proxy` to
  `127.0.0.1:<port>`. Caddy saves it (`--resume`), so it keeps serving while
  `lyricad` is locked; after unlock, `lyricad` loads it again only if Caddy's
  differs.
- **A new name never locks the administrator out.** While the name changes,
  Caddy serves the old and the new name together. `lyricad` waits up to 90
  seconds for a certificate for the new name that verifies (with staging, any
  certificate for the name), then drops the old one. If none comes (no DNS
  record yet, a token for the wrong zone), the old config goes back, nothing
  is saved, and the reason comes back with Caddy's TLS error.
- Caddy's TLS errors never reach the journal (a DNS plugin can quote its
  token in one): they go to `/run/lyrica-caddy/tls.log`, readable only by the
  `lyrica-caddy` group. The status shows the newest one since the last change,
  with credentials hidden; whether Caddy answers, has a site at all (it has
  none if its saved config had to be set aside at start), and runs the
  expected config; and the certificate's issuer and expiry, read by
  connecting to the name on the first address.
- **Providers** are one table, `daemon/src/web/providers.ts`: Cloudflare,
  Porkbun, Namecheap, Route 53, DigitalOcean, Hetzner, deSEC and Duck DNS,
  each with its pinned plugin, credential fields and how to make a token
  limited to one zone. Adding one is a row there and running `install.sh`
  again.
- **External proxy.** `lyricad` opens an extra listener on one of this
  machine's Tailscale or LAN addresses and a port. Only the listed proxy
  addresses may connect, and only their `X-Forwarded-For` is believed. On an
  address on Tailscale's own interface it is plain HTTP, since Tailscale
  encrypts (an address in `100.64.0.0/10` on another interface doesn't
  count); elsewhere it is HTTPS with a certificate `lyricad` makes for the
  address only (P-256, ten years), whose fingerprint and PEM the panel shows
  for the proxy to pin. It is made again only when the address changes, so a
  new name keeps the pin. `/snippet` is the proxy's Caddyfile site, with a
  reminder to get its certificate by DNS-01.
- The extra listener's settings (address, port, proxies, the proxy's own
  port) and its TLS key are kept in `<runtime>/web-external.json`, mode
  `0600`, not in `self.db`: `lyricad` opens the listener at start, before
  unlock, and there it answers only state, unlock and the web UI's files,
  like every other listener. A new listener opens before the old one closes;
  if it can't, the old one stays.
- **Sandboxes never reach the front door.** `Workspace` reads it at every
  sandbox start (`frontDoor`): the front port (443, or the external proxy's
  own port) on this machine's addresses, on every address the name has
  resolved to, and on the external proxy's addresses; and the extra
  listener's port on every address. If the name has never resolved, the
  sandbox gets no network for that run
  ([workspace.md](workspace.md#network-access-from-tools)).

## Deployment

`daemon/deploy/install.sh`, run as root on Debian or Ubuntu from a clean git
checkout outside `/opt/lyrica`, installs or upgrades everything. Running it
again installs that checkout's commit as a release, the way an update does
("Updates" below). On NixOS, the flake's module does the same ("On NixOS" below).

- It installs the packages (bubblewrap, gocryptfs, FUSE, passt, nftables,
  openssl, ImageMagick, and for the updater build-essential, python3, git,
  openssh-client and jq), checks for Node.js 22.6 or later (the SSH helper runs with type
  stripping), and creates three system users: `lyrica` runs `lyricad`,
  `lyrica-caddy` runs Caddy, `lyrica-build` builds releases and runs their
  smoke tests with no access to her data. The `lyrica-caddy`
  group shares Caddy's admin socket (mode `0660`) and TLS log; lyricad's unit
  joins it (`SupplementaryGroups`), and nobody else can use them. An allowed
  path that overlaps `/run/lyrica-caddy` is refused, since sandboxes run with
  lyricad's groups.
- It builds the checkout's commit into `/opt/lyrica/releases/<commit>` as
  `lyrica-build` (`npm ci`, the web build, `npm prune --omit=dev`), writes
  its `RELEASE.json` (commit, version, schema, min_reader), makes it
  read-only and owned by root, and points `/opt/lyrica/current` at it, with
  a drain, a stop and a snapshot first when lyricad was running another
  release. A flat install from before releases moves to
  `/opt/lyrica/before-releases`, kept for the operator to delete.
- It installs the updater (`/usr/local/sbin/lyrica-update`,
  `lyrica-snapshot`, `lyrica-restore`, `lyrica-rollback`, and
  `/usr/local/lib/lyrica-update/common.sh`), its units, a deploy key
  (`/etc/lyrica/deploy-key`; it prints the `.pub` to add to the repository
  as a read-only deploy key), GitHub's pinned host key
  (`/etc/lyrica/known_hosts`) and the bare repository `/opt/lyrica/repo.git`.
- It puts `lyrica` in `/usr/local/bin`: the CLI, run as the `lyrica` user
  (through `runuser` from root, `sudo` from anyone else) with
  `LYRICA_HOME=/var/lib/lyrica`, so `lyrica admin …` works from any shell.
  It runs `/opt/lyrica/current`.
- It builds Caddy (`/usr/local/bin/lyrica-caddy`) with `xcaddy`, from pinned
  versions, in a clean environment (`env -i`, `GOENV=off`, `GOPROXY` and
  `GOSUMDB` set): Go from `proxy.golang.org`, checked against the sha256 in
  the script; xcaddy, Caddy and every plugin in the provider table at their
  pinned versions, checked by Go against `sum.golang.org`. It rebuilds only
  when a pin changes.
- It sets `net.ipv4.ip_nonlocal_bind=1` (in `/etc/sysctl.d`), so Caddy binds
  its addresses even before they're up: Tailscale at boot, a DHCP change.
- It installs `lyricad.service` and `lyrica-caddy.service` and starts them,
  or says how to run `lyrica admin init` first.
- **lyricad's unit** runs `/opt/lyrica/current/bin/lyrica serve` as
  `lyrica`; a crash loop (3 starts in 2 minutes) starts
  `lyrica-rollback.service` (`OnFailure`), which acts only on probation. It has `StateDirectory`
  for the runtime and the credentials directory, and `LoadCredentialEncrypted`
  for saved credentials. Hardening: `NoNewPrivileges` breaks the setuid
  `fusermount3`, so homes never mount, and so does every option that makes
  systemd set it for a non-root service, because they install seccomp filters
  (listed in the unit; `ProtectHostname` is one of them). `RestrictNamespaces`
  and `PrivateUsers` also break bubblewrap and pasta. The unit keeps only
  `PrivateTmp` and `ProtectControlGroups`.
- **Deploy check:** `grep NoNewPrivs /proc/$(systemctl show -p MainPID --value lyricad)/status`
  must show `0`.
- **Caddy's unit** runs `caddy run --resume`, starting from
  `/etc/lyrica/caddy.json`, which only puts the admin API on its Unix socket.
  It is never on `localhost:2019`: a thread with "Local services (localhost)" on
  reaches loopback ports, and the admin API could replace the site with a
  fake login page. Caddy needs none of what lyricad's sandboxes need, so its
  unit is fully hardened. Before it starts, a saved config that no longer
  loads (`caddy validate`) is moved aside, so Caddy still comes up with its
  admin socket and `lyricad` can apply the setup again. Its saved config,
  which holds the DNS token, stays in its own state directory (`0700`).

### Updates

Releases, the updater and rollback ([DESIGN.md](../DESIGN.md#updates-and-self-editing)).
The updater is bash run as root, outside lyricad, and logs commits, tags,
check names and counts, never text.

- **Kept state.** `/var/lib/lyrica-update` (root's, readable): `state.json`
  (the updater's state, busy work while draining, the newest update note,
  `lastRollback`), `releases.json` (kept releases, `current`, `previous`,
  the snapshots, and the highest `min_reader` any release has written),
  `notes/<commit>.txt`. Snapshots are in `/var/lib/lyrica-snapshots`
  (root's, `0700`). Neither is ever granted to a thread.
- **lyricad's side.** `<home>/update.sock` (`0600`): `GET /health`
  (`{ commit, locked, checks }`: databases, workspace self-test, models,
  web), `POST /drain` (refuses new turns and answers what still works) and
  `POST /undrain`. While draining, new sends, sleep starts, sleep-item
  chats and suggestion starts are `409` with `{ updating: true }`;
  scheduled sleep and watcher looks wait; work a running turn starts (a
  child thread, a subagent) finishes, since the drain waits for it.
  Administration's requests go to `<home>/updates/request.json`, which
  `lyrica-update.path` picks up.
- **`lyrica version --json`** prints the commit, version, schema and
  min_reader; **`lyrica smoke-test <empty dir>`** starts a scratch lyricad
  there (random passphrase, a test admin, no saved credentials), unlocks,
  logs in, reads the health checks over its socket and fetches the web UI,
  printing `ok` or `FAIL` per check.
- **`lyrica-update`** (`--tag update/<name>`, `--check`, or `--request`
  from the path unit), one at a time: fetch `main` and `update/*` tags with
  the deploy key; the tag must be annotated and on `main`; build as
  `lyrica-build`; smoke test; drain (10 minutes, then undrain and give up);
  stop; `lyrica-snapshot` (pinned when the release raises `min_reader`);
  switch `current` and `previous`; start; probation.
- **Probation** lasts until 10 minutes after lyricad is unlocked with every
  check ok, starting over when it locks or restarts. A failed check, or the
  socket gone for 5 minutes, runs `lyrica-rollback --auto` and records
  `lastRollback` (state `failed`); a crash loop does the same through
  `OnFailure`. Passing prunes releases (the last 5, plus current and
  previous) and snapshots.
- **`lyrica-snapshot`** (lyricad stopped) copies `self.db`, the users'
  databases, the pools and the top-level settings files, each database
  with its `-wal` (root holds no key to checkpoint it, so the log travels
  with it), checks room first, and verifies every copy's size and sha256
  into `meta.json`. It keeps the last 3; one taken before a contract, and
  every set-aside folder, stays until a later contract passes probation and
  it is 30 days old.
- **`lyrica-restore <snapshot>`** checks every file against `meta.json`,
  moves what it replaces (with `-wal` and `-shm`) into
  `<time>-set-aside/`, copies the snapshot in, removes stale logs, and
  sets the recorded `min_reader` back to the snapshot's.
- **`sudo lyrica-rollback [commit] [--yes]`** goes back to the previous
  release, or a kept one. When that release can't read the databases it
  restores the newest snapshot it can read (asking first at a terminal),
  or refuses and names the oldest release it could go back to. Outside
  probation it drains first.
- **Units:** `lyrica-update.service` (oneshot, `Nice=10`, idle I/O),
  `lyrica-update.path`, `lyrica-rollback.service` (`--auto`).
- **The operator's part:** add the deploy key to the repository; keep a
  scheduled Proxmox backup of the container, which the updater can't
  snapshot; delete `/opt/lyrica/before-releases` once the first release
  runs.

### On NixOS

`flake.nix` gives `packages.x86_64-linux.lyrica` (`nix/package.nix`: lyricad,
the CLI and the built web UI, `buildNpmPackage` on nixpkgs' `nodejs_22`,
refusing Node older than 22.6) and `nixosModules.default`
(`nix/module.nix`, `services.lyrica`). nixpkgs is the `nixos-26.05` channel,
locked in `flake.lock`. `nix flake check` builds the package and a NixOS
system with the module on. Only x86_64-linux.

- **The module** declares what install.sh does: the two users and groups,
  `/var/lib/lyrica` (`0700`), both units written in Nix and kept in step with
  `daemon/deploy/*.service` (same hardening, `LoadCredentialEncrypted`, the
  same deploy check), `ip_nonlocal_bind`, and `/etc/lyrica/caddy.json`.
  lyricad waits for `self.db` (`ConditionPathExists`), as install.sh does.
  `lyrica` on the system path is the same wrapper as install.sh's, so
  `lyrica admin init` works as root; it runs the profile below.
  The updater, its units, the `lyrica-build` user and GitHub's host key come
  from the module too; `lyrica-nixos-start` makes the deploy key.
  It refuses to build with `security.allowUserNamespaces` off.
- **PATH.** lyricad's starts with `/run/wrappers/bin`, so `fusermount3` is
  the setuid wrapper (`programs.fuse`), then gocryptfs, OpenSSL, systemd
  (`systemd-creds`) and the sandbox tools.
- **Caddy** is nixpkgs' Caddy with the DNS plugins read from
  `daemon/src/web/providers.ts` (`caddy.withPlugins`). Its `hash` in
  `nix/module.nix` changes when that list or nixpkgs' Caddy does; `nix flake
  check` prints the new one. npm packages come by their `package-lock.json`
  integrity hashes (`importNpmLock`), so a lockfile change needs nothing here.
- **Rebuilds.** The package reads only the code it ships (no docs, evals,
  tests or `nix/`), and the commit reaches lyricad as `LYRICA_BUILD` from
  `/var/lib/lyrica-update/build.env`, so a commit that changes none of that
  code reuses the built package.
- **Sandboxes.** NixOS has no `/usr` to share. The module sets
  `LYRICA_SANDBOX_TOOLS` to one directory of `sandboxPackages`
  (`nix/sandbox-tools.nix`: a shell, the usual command-line tools, git,
  OpenSSH, curl, jq, ripgrep, Python, bubblewrap, passt, nftables) and
  `LYRICA_SANDBOX_CLOSURE` to the store paths of their closure, Node's and
  the CA bundle's (`closureInfo`). See docs/workspace.md.
- **Options:** `enable`, `package`, `port` (7340), `caddyPackage`,
  `sandboxPackages`.
- **Releases** are generations of the profile `/nix/var/nix/profiles/lyrica`,
  which lyricad runs. An Update builds `git+file:///opt/lyrica/repo.git?rev=<commit>#lyrica`
  with the host's nixpkgs in place of the repository's (`--override-input`,
  so Node is the one in the sandbox closure, as with `nixos-rebuild`; the
  updater turns on flakes for that call), keeps its `RELEASE.json` in
  `/var/lib/lyrica-update/releases/<commit>/` and switches the profile;
  rollback switches it back. Before each start, `lyrica-nixos-start` (as
  root) checks the module's package: when `nixos-rebuild switch` changed
  it, it snapshots the databases and points the profile at it, restoring
  the newest readable snapshot if the package can't read them. An
  unchanged package leaves an Update's choice in place. The unit names
  `cfg.package`, so it stays in the system closure until that first start.
- **Host check:** `nix/check-host.sh`, as root after `lyrica admin init`:
  both services run, `NoNewPrivs` is `0`, `fusermount3` is setuid, Caddy's
  admin socket exists, a sandbox and `pasta` start as `lyrica`, the
  self-test hasn't refused network, lyricad answers on port 7340.
