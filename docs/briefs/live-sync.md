# Brief: Live sync across tabs and devices

**Status:** Building on `claude/project-thread-kunoz9`. **Built by:** Codex on
the test machine; the PR and reviews go through the Claude thread that wrote
this brief.
**Read first:** AGENTS.md, PRINCIPLES.md (2, 8), docs/daemon.md (The event
stream, Web access), docs/web.md (the sidebar), docs/contracts.md (HTTP/SSE
API).

## Goal

The same account open in several tabs or on several devices stays in step,
the way Claude and ChatGPT do. An open thread already does: every view of it
holds the thread's event stream. Everything around it (the thread list, a
thread's busy dot and title, Notifications' count, Sleep, the user's display
settings) is read again only every 30 seconds or on focus, so another tab
lags behind.

- Principle 8: one more stream route and one small emitter in lyricad, no new
  process or dependency.
- Principle 2: the user stream carries no text, only that something changed.
  The tab reads what changed through the routes it already uses.

## In scope

**A. HTTP/2 on lyricad's own HTTPS listener.** Browsers allow about six
HTTP/1.1 connections per site, shared by all tabs, and every open thread
holds one for its stream. A seventh tab, or an ordinary request, waits.
Caddy and `tailscale serve` already speak HTTP/2 to browsers; Direct and the
external-proxy HTTPS listener, where lyricad itself serves HTTPS, do not.
Serve them with `node:http2` (`allowHTTP1`), so one connection carries
every tab's streams. Plain-HTTP listeners on loopback stay HTTP/1.1.

**B. A per-user event stream.** `GET /api/u/:userId/events` (SSE): `hello`
on connect, then `changed` whenever the user's lists may have moved:

- any successful state-changing request under `/api/u/:userId/` (from any
  tab or device);
- a thread event that changes how the thread looks in a list: `turn_start`,
  `turn_end`, `title`, `settings`, `permission`, `permission_end`, `child`;
- a Sleep event.

Events for one user are coalesced (one per 250 ms at most). Logout and Lock
end the stream, as they end a thread's.

**C. The shell listens.** The shell opens the user stream once and, on
`hello` or `changed`, reloads Me, the thread list, groups, Notifications and
Sleep. The 30-second timer stays only for the models page, whose status
comes from probing endpoints rather than from anything lyricad does. Focus
still reloads everything.

## Out of scope

- Pages beyond the shell (an open Settings section, Project settings) still
  load when opened, and on their own polls where they have them.
- Drafts typed in one tab don't appear in another.
- Changes to one user made by another (an administrator's) reach that
  user's tabs on focus, as now.

## Tests

- HTTP/2: a request over Direct's listener with an HTTP/2 client answers,
  and a POST passes the same-origin check (`:authority`, not `Host`).
- The user stream: a change made in one session reaches another session's
  stream as `changed`, and a turn's start and end do too.

## Handoff

**Done** (first commit on the branch): part A's code. `secureServer` in
`daemon/src/http.ts` serves HTTP/2 with HTTP/1.1 fallback and tracks its
sockets and sessions so `closeAllConnections` and `closeIdleConnections`
work as node:http's do; `checkOrigin` reads `:authority` when there is no
`Host`; `listenExternal` in `daemon/src/lyricad.ts` and `web/access.ts` use
the `Listener` type. Typecheck passes; no test yet.

**Next**, one Codex run each, in order, committing after each:

1. Part A's test in `daemon/test/web-access.test.ts`: with Direct on, an
   `node:http2` client (`ca` the panel's PEM) gets `/api/state` 200 and a
   same-origin `POST /api/login` gets past the origin check (not 403).
   Then update docs/daemon.md (Web access: Direct and the external proxy's
   HTTPS speak HTTP/2 with HTTP/1.1 fallback) and DESIGN.md's Direct
   paragraph in one line.
2. Part B: a small `UserEvents` emitter (`daemon/src/user-events.ts`,
   coalescing per user, 250 ms), fed from `Lyricad.handle` after a
   successful non-GET under `/api/u/:userId/`, from `onEvent` in
   `lyricad.ts` for the listed thread events, and from `sleep.events`. The
   route `GET ${u}/events` in `daemon/src/routes.ts` copies the
   `…/sleep/events` route's shape (session check, keep-alive, `close`).
   Add `UserEvent` to `daemon/src/api.ts`. Test in a new
   `daemon/test/user-events.test.ts`: a thread created through the API
   reaches an open stream as `changed`, and a turn's start and end do too.
   Update docs/daemon.md (a section after The event stream) and
   docs/contracts.md (HTTP/SSE API).
3. Part C: in `web/src/Shell.tsx`, open the user stream once
   (`EventSource`, reconnecting as `web/src/stream.ts` does) and on `hello`
   or `changed` reload `me`, `threads`, `groups`, `notes` and `sleep`;
   keep the 30 s timer for `models` only, and keep focus. Update
   docs/web.md's sidebar paragraph ("every 30 seconds and on focus").

Run `npm run typecheck` and only the test files touched, one at a time.
Message text never goes into the user stream, a log or a fixture.
