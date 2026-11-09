# Brief: a call budget for an MCP server

**Status:** built, in review. **Thread:** "Add eBay's MCP server to Lyrica".
Follows [mcp-local.md](mcp-local.md); the line is in DESIGN.md, "MCP servers".

## Why

The owner (2026-11-09), with eBay's server running: eBay's free keyset
gives 5,000 API calls a day, and a runaway loop could get the developer
account banned, so a server needs a rate limit. And the owner's own
servers, over local data, must be able to run without one. Principle 8:
a budget she is held to, instead of a rule she is told.

## Build

1. **Two numbers per server**, `dailyLimit` and `minuteLimit`, null by
   default (no limit): `mcp_servers.daily_limit`/`.minute_limit`, user
   step 22, adds only. `mcpLimit` takes a whole number 1 to 1,000,000 or
   nothing. They are set in the drawer (Calls per day, Calls per minute)
   and by `McpServerInput`/`McpServerChange`.
2. **A call log**, `mcp_calls (server, at)`: one row per `tools/call`
   sent, the server's name and the time, nothing of the call. Pruned to
   two days as rows are written. Counted across the user's threads.
3. **The transport holds the line** (`McpBudget { refused(), record() }`
   on `mcpTransport` and `mcpStdioTransport`): before each `tools/call`
   it asks `settings.mcpCallRefused(name)`, the day's calls since
   midnight UTC against `dailyLimit` and the last 60 seconds against
   `minuteLimit`. A refused call is never sent: the transport answers it
   as the tool's `isError` result, saying which budget is used up and
   when it resets, and not to retry. A sent call is recorded. A locked
   database counts nothing and refuses nothing.
4. **Seen**: `McpServerInfo.callsToday`; the facts line shows "312 of
   4,000 today" when a daily limit is set, the drawer "312 calls today".
5. **Docs**: DESIGN, workspace, contracts, ux, web, the eBay guide
   (4,000 a day, 20 a minute).

## Out of scope

Per-thread or per-project budgets; counting only the tools that reach
the service (a server's local lookups count too, the safe side); a
budget on remote model calls, which the model lists already have.

## Handoff

Done (2026-11-09): everything under Build, one PR from this thread.
Tests: `core/test/mcp.test.ts` (a refused call answered as the tool's
error, nothing sent), `core/test/workspace.test.ts` (the bookkeeping),
`core/test/migrations.test.ts` (step 22 from every released schema).
Next: nothing. Open: whether the minute's budget should also slow her
down (wait and retry) instead of refusing; refusing was chosen so a loop
stops at once.
