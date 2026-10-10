# Web UI

The browser interface to `lyricad`, in `web/`: React and TypeScript, built
with Vite into `web/dist`, which `lyricad` serves under its Content Security
Policy. It talks to the API in `daemon/src/api.ts` with `fetch` and one
`EventSource` per open thread, and imports only its types (and
`THREAD_TASKS`). It also imports `core/src/mentions.ts`, a pure function, to
render mention tokens.

## Pages

Routes are in the URL hash (`#/u/<user>/t/<pool>/<thread>`, `…/memory`,
`…/panel`, `#/login`), so `lyricad` serves a single file.

- **Unlock** while `lyricad` is locked, then **login**. A browser holds one
  person's users: the user menu switches between linked personas (separate users of the same person), logs in as
  another, logs one out, or **Lock**s one. Logging in as a user who isn't
  linked signs the browser's users out first, and a short notice says so
  without naming them. Logging out says when the user stays unlocked
  because another browser still holds them.
- **Sidebar:** the user, the Show general, Show private and Show hidden
  threads filters (saved per user), New thread (general or private), the
  thread list with child threads (branches, forks, copies) behind `›`, and links to Memory and the Control
  panel. Private threads carry a small lock in the private colour.
- **Hidden pools:** with Show general or Show private off, a thread or
  memory from that pool shows "General is hidden" or "Private is hidden"
  instead, and memory search leaves the pool out.
- **Thread:** a header with the title, the pool badge, the model badge
  (cloud or local, model and endpoint; it opens the model picker), and folder
  badges. Below it the conversation and the composer.
- **Thread settings drawer:** a model per task (each option says cloud or local first), local-only, the internet and
  this machine's services switches (each following the user's default until
  changed), allowed hosts, folders from the allowed paths (read-only or
  read-write), where commands run (sandbox or an SSH target), permission
  mode, "Do not log", rename, hide, and forget. `lyricad` validates every
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
  tokens.
- **Control panel:** profile (name, pronouns, accent colour, monogram, theme,
  saved credentials, stay unlocked after logout, and `lyricad`'s warning when
  two of these contradict), password, your personas (linking a separate persona needs both
  passwords), your suggestions for Lyrica's persona (edit, send on to the
  administrators, or drop), endpoints with probe status, both model profiles, network
  defaults per pool, and SSH targets. Administrators also
  get the server's network self-test result, sleep time, saving the `self.db`
  passphrase, users with the administrator flag and their allowed folders,
  changes to Lyrica's persona that users sent on (who sent them, whether they edited
  them, and a confirmation when the file changed since), and **Web access**:
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
  The user's sit in a tinted block.
- Thinking, recalls, saved notes and tool calls are one-line markers that
  expand when tapped. An expanded tool call stays open when the turn ends
  and the stored copy replaces the live one.
- A `delegate` call is a card for its subagents (the tool part's
  `threads`). Each expands to its work: the stored transcript, read-only,
  where each message says who sent it (Lyrica, the user by name, or the
  subagent's own work), reloaded as the subagent works; its waiting
  approvals; and a message box that writes to it as the user (Lyrica is
  told). What a run delivers later (a result, a question, a note, or what
  someone wrote to a subagent), as a `notice` event and stored as a
  `notice` message, shows as a card headed by what it is, linking to the
  subagent.
- Permission requests appear inline with Allow and Deny and the time left. A
  subagent's request shows in its parent's thread (in its card, when that
  is open) and on its own page, naming the subagent, and stays past the
  parent's turn; the first answer wins and the other view updates.
- Errors from the stream (a refused model, an endpoint that's down) are shown
  as sent, in plain words.
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
  and one request checks whether the login still holds. A `reset`, or a
  reconnect that finds the turn already over, also reloads the stored
  messages.
- **Each message has a menu** (a bordered ⋯ icon button by the sender's
  name; `src/Rewind.tsx`): Branch from here; on her replies Regenerate and
  Regenerate with… (the models the thread may use); on the user's messages
  Edit, which turns the message into a box (Save, Cancel) whose text is sent
  in its place; Delete on the messages of the last turn, and Delete from
  here on earlier ones, both in danger text. Removing turns hides them at
  once and waits five seconds with an Undo toast before the request goes
  (leaving the thread sends it at once): Delete, and Regenerate or Edit
  before the last turn. On the last turn, Regenerate and Edit go at once. A `rewound`
  event drops the removed messages from every open view. A new branch opens,
  under "Branched from" its parent, and its settings can be changed within
  its parent's.
- Files attach with the button, by dragging onto the composer, or by pasting.
  Each shows its progress, and its path in the thread goes into the draft.

## Look

`src/app.css` holds the design tokens as custom properties. The accent is the
user's (`--user-accent`), lightened in dark mode; cloud, local and private
keep fixed colours. The theme follows the device unless the user overrides it.
System fonts only.

Below 760 px the sidebar and drawer become overlays, and the model picker
spans the screen. Touch screens get 44 px tap targets. The app is sized to the visual
viewport (`--vvh`, for iOS) and the page asks for
`interactive-widget=resizes-content` (for Android), so the composer stays
above the keyboard, and the login and unlock card scrolls. `public/manifest.webmanifest` makes it installable. Reduced motion
turns animations off.

## Checks

- `npm run typecheck` covers `web/` (`tsc -p web`), and `npm run build` builds
  it.
- `web/test/live.test.ts` tests the stream reducer.
- `npm run e2e -w @lyrica/web` runs Playwright (after a build). Each viewport
  (390×844 with touch, 1280×800) gets its own real `lyricad` from
  `web/e2e/serve.ts`, on a temporary runtime with a fake model server.
- For development, `npx tsx web/e2e/serve.ts 7340 7350` starts the same
  throwaway `lyricad` (passphrase `correct horse`, login `li` / `pw`), and
  `npm run dev -w @lyrica/web` serves the UI with `/api` passed to it.
