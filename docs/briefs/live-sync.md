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
the `Listener` type.

**Done (step 1, committed):** Part A's test and docs,
serving principles 8 (streams share one connection) and 2 (same-origin
boundary). `daemon/test/web-access.test.ts` enables Direct on a free
loopback port and uses an HTTP/2 client trusting the panel's PEM. It verifies
`h2` negotiation, `/api/state` 200, same-origin `/api/login` 200 with
`:authority` and no `Host`, and a mismatched origin 403. No model or plan
endpoint is called. Updated docs/daemon.md's Web access and origin check,
and DESIGN.md's Direct paragraph for HTTP/2 with HTTP/1.1 fallback.
`npm run typecheck` passed; all 10 tests in `daemon/test/web-access.test.ts`
passed with `flock /tmp/lyrica-tests.lock npx vitest run --pool=forks
--maxWorkers=2 daemon/test/web-access.test.ts`. No preset, UI or schema
changes were needed. Parts B and C are completed below.

**Done (step 2, committed):** Part B, serving
principles 2 and 8. Added `UserEvent` and the text-free per-user SSE route,
with hello, session/key checks, keep-alive and listener cleanup.
`UserEvents` coalesces per user over 250 ms; successful user-path mutations,
the listed thread events and Sleep events feed it. Updated docs/daemon.md
and docs/contracts.md. The new daemon/test/user-events.test.ts covers
coalescing, cross-session API changes, turn start/end independently of HTTP
mutations, Sleep, user isolation, text-free payloads and logout/Lock closure.
No preset, UI, schema, paid API or plan changes. Validation: `npm run
typecheck` and the new test file under the shared lock passed (2 tests).
Part C is completed below.

**Done (step 3, left in the tree for the operator):** Part C, serving
principles 2 and 8. `web/src/Shell.tsx` opens one user EventSource and
reloads Me/display settings, threads, groups, Notifications and Sleep on
`hello` and `changed`, including after reconnect. EventSource handles normal
reconnects; terminal HTTP errors retry with the same 1–30 second backoff as
the thread stream, and a Me reload checks for logout or Lock. Cleanup closes
the stream and cancels its retry when the user changes or the shell unmounts.
The 30-second timer now reloads only Models (and its existing Clean up
refresh); focus reloads all shell state and Models. Updated docs/web.md's
stream, sidebar and Sleep descriptions. No new controls (existing homes in
docs/ux.md §6), preset/profile, schema, daemon, paid API or plan changes.
Validation: `npm run typecheck` passed. No test files were touched, so no
test commands or full suite were run.

**Next:** All three implementation steps are complete. The operator commits
and pushes this step, runs the full suite, and routes the PR/head to the
required reviewers. No commit or push was attempted in step 3.
