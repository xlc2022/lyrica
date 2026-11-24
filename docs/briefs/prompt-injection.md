# Prompt injection defences

The owner's decision (2026-11-24), after comparing Lyrica with Claude Code
and Codex: build three fixes. Lyrica's defence is containment (the sandbox,
the network switches, credentials kept out of the sandbox, cards for what
leaves the server); these close the gaps the comparison found. The agent
loop and the sandbox's network are risky areas, so each PR goes to PR
review, and a PR with a control to UI review too.

1. **Mark all outside content** (principle 6: she can judge only what she
   can recognise). Command output, `jobs output` pages and MCP answers go
   between per-call markers, as web results already did. Done in the
   first PR; docs/workspace.md, "Outside content".
2. **Uploads switch** (principle 2: the boundary is structural). Under
   Internet, in the thread drawer and in Settings → Network per pool,
   default on. Off: the sandbox's internet goes only through lyricad's
   relay, which ends TLS with the run's authority and passes GET, HEAD and
   OPTIONS (and a git fetch's upload-pack), so a command, fetch or the
   browser can read but not send a file or a form. A URL can still carry
   a little text out; the switch doesn't claim otherwise. The thread's own
   repositories keep their token relay, writing only to themselves.
3. **Page reader switch** (principle 2). After Uploads, default off. On:
   `web_fetch` takes a question, the thread's Cheap subagents model reads
   the page and answers, and she gets only the answer. `browse` still
   shows the page, since she acts on its elements.

Out of bounds: asking for approval after she reads a page (the owner said
no, 2026-10-29); marking `read` (a granted folder or a repository the user
added is theirs, and its AGENTS.md is meant to guide her).

## Handoff

- Done: part 1, `extension/src/outside.ts`, `outside(…, kind)` and
  `unmarked` in `core/src/web.ts`.
- Done: part 2, docs/workspace.md, "Uploads" (`readOnlyInternet` in
  relay.ts, `readOnlyEnv` in sandbox.ts). The owner approved both controls
  as described.
- Done: part 3, docs/workspace.md, "Page reader" (`extension/src/reader.ts`).
  The reader is one tool-less call through `core/models` with only the
  page and the question; its answer is held to 2,000 characters and still
  marked as outside content.
