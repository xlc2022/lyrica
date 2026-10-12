# Brief: MCP servers

**Thread:** Self-development tools (Opus). Design approved by the owner on
2026-10-12 from `/mnt/project-files/self-dev/mcp-design.md`. The design
lines live in DESIGN.md, "MCP servers"; this brief is the build plan.

## Why

MCP (Model Context Protocol) is the common plug for tools: Home
Assistant, a calendar, Gitea, Sentry or a docs site runs an MCP server,
and any MCP client can use its tools. With Lyrica as a client, an
integration becomes "add a server" instead of a tool we write and keep
(principle 3, and principle 8's budget).

## Build

1. **Pi's client, not ours.** Pi ships MCP (`docs/mcp.md` in
   `@earendil-works/pi-coding-agent`; SDK sessions add the MCP and
   tool-search extensions to the resource loader, see Pi's `docs/sdk.md`,
   "Codemode and MCP"). Register each granted server per session with
   `pi.registerMcpServer(name, { url, headers, exposure: "deferred",
   description })`, never through `mcp.json` on disk: the build turns
   off Pi's global and project `mcp.json` loading, so a stray
   `~/.pi` file can't add a server outside the encrypted database or the
   grants. Turn Pi's
   `mcp.log` and temporary result files off or point them at the
   thread's encrypted workspace: no tool text in plaintext on disk.
2. **Remote servers only.** Streamable HTTP. A `command` (stdio) server
   is refused.
3. **Schema:** user database step 3 (`core/src/migrations.ts`, adds only):
   an `mcp_servers` table (name, url, pool, token sealed like a Git
   token, state, checked_at) and `thread_workspaces.mcp_servers` (JSON
   names, default `[]`). If another PR takes step 3 first, use the next.
4. **Pools.** A private server's host must resolve on her own network
   (`resolveHost`, as for a private Git account), or be confirmed with
   the "Use a host outside your network?" dialog and shown Off network.
5. **Settings → MCP servers** (after Git accounts) and the **MCP servers**
   row in the thread drawer and under This chat (docs/ux.md §6), copied
   from Git accounts and Repositories. A server is checked before it's
   saved: an MCP `initialize` and `tools/list`, which must answer.
6. **Grants:** a thread's servers are its own plus its project's, only of
   its pool; a subagent's are its parent's or fewer (Delegation 2 owns
   inheritance); removing one from a project takes it from running threads
   at once, as `narrowRunning` does for repositories.
7. **The gate** (`extension/src/workspace.ts`): a call to an MCP tool whose
   server marks it `readOnlyHint` runs in any mode and is the only kind in
   Plan mode; any other call is treated as leaving the server and always
   asks with the permission card (server name first in its title), with
   **Allow in this thread** for that tool. `tool_search` is model-facing
   and counted; the MCP tools it loads are not (principle 8).
8. **Tests** (what the user would notice): a private thread never gets a general
   server; a granted server's read-only tool runs in Plan mode and a
   writing one asks in Auto; removing a server from a project takes it from
   a running thread; a server in a global `mcp.json` is not registered;
   the step 3 migration from every released schema.

## Out of scope

Stdio servers, OAuth sign-in (Pi supports it, but its redirect lands on
the server's loopback address, which the user's browser can't reach), MCP
resources and prompts, Lyrica as an MCP server, a catalogue of servers.

## Order

After web search (`web_search`, `web_fetch`) merges, since both touch
the tool list and the gate.
