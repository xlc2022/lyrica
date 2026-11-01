# Brief: local (stdio) MCP servers, and eBay's

**Status:** built, in review. **Thread:** "Add eBay's MCP server to Lyrica".
Builds on [mcp.md](mcp.md); the lines are in DESIGN.md, "MCP servers".

## Why

The owner asked for eBay browsing through an MCP server (2026-10-31) and,
of the servers surveyed, picked eBay's own
([eBay/npm-public-api-mcp](https://github.com/eBay/npm-public-api-mcp),
Apache 2.0, read-only, maintained by eBay). It speaks stdio only. The
owner lifted the rule against stdio servers on 2026-11-01 (DESIGN.md,
"MCP servers": allowed in principle, not built), so this brief builds
that, generally, and documents eBay's server as its first use. Principle
3 (Pi's client; Lyrica writes no protocol code) and principle 8 (the
process budget) still hold.

The owner was told, before building, what starting the program per
session and keeping no log of its output means for eBay's server: nothing.
It keeps no state (a token it fetches at its first call, API specs it
looks up per call), logs nothing unless `LOG_FILE_PATH` is set, and
starts in well under a second with Node installed.

## Build

1. **A server is a URL or a command.** `mcp_servers` gets `command` (JSON
   argv, `[]` for a remote server) and `env` (JSON, `{}`); user database
   step 20, adds only. A local server has an empty `url`. Exactly one of
   the two is set. The command is one program and its arguments, split
   like a shell does (quotes, no expansion); the environment is `KEY=value`
   lines, kept like a token: in `user.db` and memory, never shown back.
2. **It runs in the thread's sandbox** (`Sandbox.start` with the server's
   environment under the sandbox's own, so `PATH` and `HOME` are the
   sandbox's): the thread's folders, grants and network, as her `bash`
   has them, in its folder. Nothing runs inside `lyricad`. The transport
   (`mcpStdioTransport`, `core/src/workspace/mcp.ts`) speaks
   newline-delimited JSON-RPC on the process's pipes and keeps the same
   filters as the HTTP one (log notifications dropped, results cut to
   16 KB, no redirects to worry about). Its stderr is held in memory, the
   last 4 KB, only to say why a start failed; nothing of it reaches disk.
   Closing ends stdin, then SIGTERM, then SIGKILL.
3. **The process budget.** A running local server holds one of the
   thread's four background-command slots (`Jobs.hold`): `jobs` lists it
   as the MCP server by name, `stop` ends it (the next turn starts it
   again), and a server that dies on its own is reported like a job that
   failed, without its output. A fifth doesn't start, and the server
   shows Unreachable in Settings until a slot is free.
4. **Checked before it is saved**, as a remote one: the probe starts it in
   a sandbox of its own, an empty folder and no network (a server that
   needs the network to start fails the check, and its own last line on
   stderr says why), and asks `initialize` and `tools/list`. No host
   check and never Off network: the facts line says "this machine".
5. **Settings → MCP servers**: the drawer's URL field gains a **Command**
   field beside it (one of the two), and for a command server the Token
   field is an **Environment** field (`KEY=value` lines, write-only,
   **Replace environment** behind ⋯). docs/ux.md §6 has the home.
6. **eBay's server** is installed as a sandbox tool: on NixOS
   `services.lyrica.ebayMcp = true` adds `nix/ebay-mcp.nix` (the npm
   package, built from its lock file) to her sandboxes' `/usr`; on Debian
   `npm install -g @ebay/npm-public-api-mcp`. The command is
   `ebay-mcp-server`, the environment `EBAY_CLIENT_ID` and
   `EBAY_CLIENT_SECRET` from a free eBay developer keyset. Guide:
   docs/guides/ebay-mcp.md. The server's tools lack `readOnlyHint`, so
   each asks once per thread (**Allow in this thread**) and none run in
   Plan mode, as docs/workspace.md says.
7. **Tests** (what the user would notice): the stdio transport and probe
   against a small stdio server in Node; a local server saved with its
   command and environment, never a URL and a command together; a local
   server starts in a sandbox with its environment and without lyricad's
   (sandbox tests, where bwrap runs); step 20 from every released schema.

## Out of scope

Pi's `${VAR}` and `!command` expansion in `env` (never done), `cwd` other
than the thread's folder, OAuth sign-in, a catalogue of servers, a
readOnlyHint for eBay's tools (an upstream PR, later).

## Handoff

Done (2026-11-01): everything under Build, in one PR from this thread.
Core: `mcpCommand`, `mcpEnv`, `mcpStdioTransport`, `probeMcpCommand`,
`Workspace.startMcpServer`, `Jobs.hold`, `Sandbox.start(argv, cwd, env)`,
user step 20. Daemon: `command` and `env` in `McpServerInput`,
`POST …/mcp-servers/:name/env`. Web: Command and Environment in the
drawer. Nix: `services.lyrica.ebayMcp` and `nix/ebay-mcp.nix`. Docs:
DESIGN, workspace, contracts, ux, web, daemon, getting-started, the eBay
guide, README. Tests: `core/test/mcp.test.ts`, settings and migration
tests, a sandbox test (bwrap only).

Next: the operator's part. `nix/ebay-mcp.nix` was written without a Nix
build (its source hash was computed by hand from the commit's tree), so
the first `nixos-rebuild` with `ebayMcp = true` is the test of it; the
owner's eBay keyset then goes into the Environment field. An upstream
pull request adding `readOnlyHint` to eBay's tools would drop the
per-thread question.

Open: whether a local server should run with the thread's network or
none (it has the thread's now, so eBay's can reach eBay); whether Pi's
`cwd` and `env` expansions are ever wanted (not done, on purpose).
