# Brief: Web UI

**Status:** Merged as #16 (ffd1923). The start instructions below are history.

**Thread:** Web UI. **Branch:** `feature/web`. **Depends on:** Daemon.
- Start once the Daemon thread has pushed `daemon/src/api.ts`. Branch from
  `feature/daemon`, and merge `main` into your branch once Daemon is merged.
- Your pull request goes into `main` after Daemon's.

**Read first:** AGENTS.md; PRINCIPLES.md (including "How we work"); and
DESIGN.md:
- "Who Lyrica is for";
- "Memory pools";
- "Interfaces and threads", including how the web UI looks;
- "Models and endpoints";
- "Memory";
- "Runtime": reaching the web UI, and phones.

Then read docs/contracts.md ("UI rules that cross components"),
`daemon/src/api.ts` with docs/daemon.md, and the mockup in
the app mockup (see DESIGN.md; the old
`docs/briefs/web-mockup/` folder was deleted).

## Goal

A user can use Lyrica from a browser, on a desktop or a phone:
- unlock `lyricad` and log in;
- talk in threads with streamed replies;
- always see, and easily change, which model is running;
- set folders and network per thread;
- approve tool calls and upload files;
- browse and edit memory.

It all uses the look agreed in DESIGN.md. This serves principle 1: the web
chat is where the user will spend most of their time with Lyrica.

## Stack

- React and TypeScript, built with Vite, in `web/` as an npm workspace.
  `npm run typecheck` covers it, and `npm run build` produces `web/dist`, which
  `lyricad` serves.
- Plain CSS with design tokens as custom properties, starting from the
  mockup's `app.css`.
- `react-markdown` for her messages, with raw HTML off. Data comes through
  `fetch` and `EventSource`, using the types from `daemon/src/api.ts`.
- No state library, CSS framework or component kit. Add a dependency only
  when it removes more code than it adds.
- It must run under `lyricad`'s Content Security Policy (`default-src
  'self'`): no inline scripts, and no fonts or scripts from other sites. Bundle
  any font you use, or use system fonts.

## In scope

1. **Unlock and login.**
   - An unlock page while `lyricad` is locked.
   - Login.
   - A persona switcher for users already logged in in this browser, and
     **Lock**.
2. **Layout**, as in the mockup:
   - **Sidebar:**
     - the persona;
     - Show general, Show private and Show hidden threads;
     - New thread;
     - the thread list, with subagents nested behind `>`;
     - links to Memory and the Control panel.
   - **Thread header:**
     - title;
     - pool badge;
     - model badge, with cloud or local and the endpoint;
     - folders.
   - **Settings drawer**, and a **composer** with attach.
3. **Chat.**
   - Streamed replies, Stop, and messages queued during a turn.
   - Markdown and code blocks.
   - Recalls, remembered notes and tool calls appear as one-line markers that
     expand when tapped. Subagents appear as cards that open their thread.
   - Permission prompts appear inline, with Allow and Deny.
   - Errors are shown in plain words. Examples: a cloud model refused in a
     local-only thread, or an endpoint that's offline.
   - The stream reconnects without losing anything.
4. **Choosing models.**
   - The model badge opens a picker. The drawer sets the model for each task
     (main conversation, cheap and strong subagents).
   - In a private or local-only thread, only local models are offered.
     `lyricad` enforces this. The UI just doesn't tempt.
5. **Thread settings drawer.**
   - Local-only, internet, this machine's services, and allowed hosts (with
     `lyricad`'s validation messages).
   - Folders from the allowed paths, read-only or read-write, and the SSH
     target.
   - Permission mode and "Do not log".
   - Rename and hide.
   - A subagent's thread shows its inherited settings read-only.
6. **Uploads.** Attach with the button, by dragging, or by pasting, with
   progress. The path she sees goes into the message.
7. **Memory browser.**
   - Search, filtered by pool, layer and User introduced.
   - View a memory with its lineage as links.
   - Edit (each edit saves a revision), with history and restore.
   - The deletion levels, each with a clear confirmation.
   - Add a memory, with links.
   - Mention tokens show as the person's current name and survive edits.
8. **Control panel.**
   - **Each user:**
     - profile: display name, pronouns, theme, accent colour and monogram;
     - password;
     - endpoints and model profiles, with probe status;
     - network defaults per pool;
     - SSH targets.
   - **Administrators:**
     - users and the administrator flag;
     - allowed paths;
     - shared endpoints;
     - sleep time;
     - persona proposals;
     - the network self-test result, if network is refused.
     - **Web access**: built-in Caddy or an external proxy, the name, the
       addresses, the DNS provider and credentials, certificate status, and
       the snippet for an external proxy. Built (`web/src/Panel.tsx`); the API is in
       `docs/briefs/web-access.md`.
9. **Look.** As DESIGN.md describes.
   - Her messages run full width as prose; the user's sit in a tinted block.
   - Theme follows the device unless overridden.
   - The persona's accent colour and monogram replace the mockup's fixed
     accent.
   - The cloud, local and private colours stay fixed, so they always mean the
     same thing.
10. **Phones.**
    - Works from 360 px wide:
      - the sidebar and drawer become overlays;
      - 16 px side gutters, and no horizontal scrolling;
      - tap targets of at least 44 px;
      - the composer stays above the keyboard.
    - A web app manifest, so it can be added to the home screen.
11. **Basics.** Keyboard use, labelled controls, visible focus, and respect
    for reduced motion.

## Out of scope

- The Sleep section (Sleep thread adds it).
- Delegation's live view, beyond nested threads and subagent cards. Add it
  only if Delegation's events are already in the stream.
- Offline use, service workers and push notifications.
- The terminal client.
- Translations.

## Done when

- `npm run typecheck`, `npm test` and `npm run build` pass in CI.
- Playwright tests run against a real `lyricad` with a fake model server, at
  390×844 and 1280×800, and show that:
  - unlock, login, a new thread, a sent message, a streamed reply, and a
    reload that still shows the reply all work;
  - the model badge always shows the current model, and changing it takes
    effect;
  - a private thread, and a general thread switched to local-only, offer
    only local models;
  - an "ask" mode prompt can be approved, and denying it stops the tool;
  - an uploaded file's path appears in the message;
  - a memory can be edited and then restored;
  - there is no horizontal scrolling at phone width.
- CI installs Chromium for Playwright.
- `docs/web.md` describes what exists, briefly.
- The pull request deletes `docs/briefs/web-mockup/` and lists any contract
  change in its description.

## Handoff notes

(The Web UI thread fills this in if it stops before it's done.)
