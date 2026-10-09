# Web UI

The browser interface to `lyricad`, in `web/`: React and TypeScript, built
with Vite into `web/dist`, which `lyricad` serves under its Content Security
Policy. It talks to the API in `daemon/src/api.ts` with `fetch` and one
`EventSource` per open thread, and imports only its types (and
`THREAD_TASKS`).

## Pages

Routes are in the URL hash (`#/u/<user>/t/<pool>/<thread>`, `…/memory`,
`…/panel`, `#/login`), so `lyricad` serves a single file.

- **Unlock** while `lyricad` is locked, then **login**. A browser can hold
  several users; the persona menu switches between them, adds one, logs one
  out, or **Lock**s one.
- **Sidebar:** the persona, the Show general, Show private and Show hidden
  threads filters (saved per user), New thread (general or private), the
  thread list with subagents behind `›`, and links to Memory and the Control
  panel.
- **Thread:** a header with the title, the pool badge, the model badge
  (cloud or local, model and endpoint; it opens the model picker), and folder
  badges. Below it the conversation and the composer.
- **Thread settings drawer:** a model per task, local-only, the internet and
  this machine's services switches (each following the user's default until
  changed), allowed hosts, folders from the allowed paths (read-only or
  read-write), where commands run (sandbox or an SSH target), permission
  mode, "Do not log", rename, hide, and forget. A subagent's thread shows
  them read-only. `lyricad` validates every change and its reason is shown.
- **Memory:** search filtered by pool, layer and User introduced; a memory
  with its lineage as links, edit (each edit a revision), history with
  restore, archive and delete; forgetting selected results as a topic; and
  adding a note or page, linked or free. Mention tokens show as current names;
  the editor shows them as `[[Name]]` or `[[Name:obj]]` and saves them back as
  tokens.
- **Control panel:** profile (name, pronouns, accent colour, monogram, theme,
  saved credentials), password, endpoints with probe status, both model
  profiles, network defaults per pool, and SSH targets. Administrators also
  get the server's network self-test result, sleep time, saving the `self.db`
  passphrase, users with the administrator flag and their allowed folders, and
  persona proposals.

## Chat

- Her messages are prose, rendered with `react-markdown` (raw HTML skipped).
  The user's sit in a tinted block.
- Thinking, recalls, saved notes and tool calls are one-line markers that
  expand when tapped. A `delegate` call is a card that opens the subagent's
  thread when its ID appears in the result.
- Permission requests appear inline with Allow and Deny and the time left.
- Errors from the stream (a refused model, an endpoint that's down) are shown
  as sent, in plain words.
- A message sent during a turn waits as a follow-up and shows as waiting;
  Stop aborts the turn.
- `src/live.ts` turns stream events into the in-progress turn. When a turn
  ends, the stored messages are reloaded and the live copy is dropped.
  `EventSource` reconnects with `Last-Event-ID`; if it gives up, a new one
  passes the last ID as `?lastEventId=`. A `reset`, or a reconnect that finds
  the turn already over, reloads the stored messages.
- Files attach with the button, by dragging onto the composer, or by pasting.
  Each shows its progress, and its path in the thread goes into the draft.

## Look

`src/app.css` holds the design tokens as custom properties. The accent is the
persona's (`--persona`), lightened in dark mode; cloud, local and private
keep fixed colours. The theme follows the device unless the user overrides it.
System fonts only.

Below 760 px the sidebar and drawer become overlays, and the model picker
spans the screen. Touch screens get 44 px tap targets. The page uses
`interactive-widget=resizes-content`, so the composer stays above the
keyboard. `public/manifest.webmanifest` makes it installable. Reduced motion
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
