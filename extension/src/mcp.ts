import { devNull } from "node:os";
import { createMcpExtension, createToolSearchExtension, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mcpNamespace, mcpStdioTransport, mcpTransport, type McpBudget, type McpProcess, type McpStateKind, type ThreadMcpServer } from "@lyrica/core";
import { bringBack } from "./gate.ts";

// MCP servers (DESIGN.md, "MCP servers"): Pi's own client and tool_search,
// with nothing about servers read from or written to disk. Each granted
// server is registered for the session, deferred, so its tools reach the
// model only when tool_search loads them. The workspace gate decides which
// calls run, ask, or are off. What tool_search loaded stays loaded for the
// thread: a new session on it (after idle, a restart, a settings change)
// loads those tools again, whatever was compacted.

export interface McpServersHost {
  /** The thread's servers now: granted, of its pool, and a private one only once its host passed the check. Read at every call. */
  mcpServers(): ThreadMcpServer[];
  /** At the start of a turn: checks the private servers' hosts, saying what is held back. */
  checkMcpServers?(): Promise<string[]>;
  /** How a connection went, for the server's state in Settings. */
  mcpServerState?(name: string, kind: McpStateKind): void;
  /** Starts one of the thread's local servers in its sandbox, with its own environment under the sandbox's (Workspace.startMcpServer). */
  startMcpServer?(name: string): Promise<McpProcess>;
  /** The server's call budget, asked before each tool call: calls a day and a minute, when the user set them. */
  mcpBudget?(name: string): McpBudget;
}

/** The section that tells her about a server held back this turn. */
const SECTION = "mcp_problems";

/** How long a turn waits for a server to list the tools she loaded earlier: Pi's own wait for servers with direct tools. */
export const LOADED_WAIT_MS = 10_000;

interface Entry { type?: string; message?: { role?: string; toolName?: string; details?: { loaded?: unknown } } }

/** Every tool tool_search loaded on the thread's branch, compacted or not. */
export function loadedTools(branch: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const e of branch as Entry[]) {
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role !== "toolResult" || m.toolName !== "tool_search" || !Array.isArray(m.details?.loaded)) continue;
    for (const name of m.details.loaded) if (typeof name === "string") names.add(name);
  }
  return [...names];
}

/**
 * Pi's MCP and tool_search extensions, and the thread's servers registered
 * for the session. Pi's own mcp.json files (global and project) are not
 * read, its OAuth credentials file is never used (each connection uses
 * Lyrica's transport, with the token as a bearer header and no OAuth), its
 * mcp.log gets nothing (the transport drops the servers' log messages, and
 * the log points at the null device), and results reach Pi already cut
 * below its 20 KB limit, so it saves no full text to a temporary file. A
 * local server is registered with its command, but Pi never starts it:
 * Lyrica's transport does, in the thread's sandbox (DESIGN.md, "MCP servers").
 */
export function createMcpServersExtension(host: McpServersHost): ExtensionFactory {
  return async (pi) => {
    /** What is registered now, by name, with the config it was registered with. */
    const registered = new Map<string, string>();
    const sync = () => {
      const want = new Map(host.mcpServers().map((s) => [s.name, s]));
      for (const name of registered.keys()) {
        if (!want.has(name)) { pi.unregisterMcpServer(name); registered.delete(name); }
      }
      for (const [name, s] of want) {
        const key = JSON.stringify([s.url, s.token, s.command, s.description]);
        if (registered.get(name) === key) continue;
        const where = s.command?.length ? { command: s.command[0]!, args: s.command.slice(1) } : { url: s.url };
        pi.registerMcpServer(name, { ...where, exposure: "deferred", ...(s.description ? { description: s.description } : {}) });
        registered.set(name, key);
      }
    };
    // Registered before Pi's handlers, in the same extension: Pi awaits each
    // handler in order (ExtensionRunner.emit), so its session_start connects
    // only what sync registered, after the private hosts are checked.
    pi.on("session_start", async () => {
      await host.checkMcpServers?.().catch(() => []);
      sync();
    });
    /** Servers whose last connection failed, which aren't waited for. */
    const failed = new Set<string>();
    /** The tools she loaded earlier that belong to the thread's servers now. */
    const loaded = (ctx: ExtensionContext) => {
      const spaces = host.mcpServers().map((s) => `${mcpNamespace(s.name)}__`);
      return loadedTools(ctx.sessionManager.getBranch()).filter((n) => spaces.some((p) => n.startsWith(p)));
    };
    /** Brings back what she loaded, once each server holding one has listed its tools, failed, or the wait is over. */
    const restore = async (ctx: ExtensionContext) => {
      const want = loaded(ctx);
      if (!want.length) return;
      const until = Date.now() + LOADED_WAIT_MS;
      const listing = () => {
        const names = pi.getAllTools().map((t) => t.name);
        return host.mcpServers().some((s) => {
          const space = `${mcpNamespace(s.name)}__`;
          return !failed.has(s.name) && want.some((n) => n.startsWith(space)) && !names.some((n) => n.startsWith(space));
        });
      };
      while (listing() && Date.now() < until && !ctx.signal?.aborted) await new Promise((r) => setTimeout(r, 50));
      bringBack(pi, ctx, want);
    };
    pi.on("before_agent_start", async (event, ctx) => {
      const problems = host.checkMcpServers ? await host.checkMcpServers().catch((err: Error) => [err.message]) : [];
      sync();
      bringBack(pi, ctx, loaded(ctx));
      const sections = event.systemPromptOptions.sections ??= {};
      if (problems.length) sections[SECTION] = `MCP servers held back this turn:\n${problems.map((p) => `- ${p}`).join("\n")}`;
      else delete sections[SECTION];
    });
    // A server taken from the thread mid-turn (a project's grant removed, say) goes at once; the gate refuses its calls.
    pi.on("tool_call", () => {
      const now = new Set(host.mcpServers().map((s) => s.name));
      for (const name of registered.keys()) if (!now.has(name)) { pi.unregisterMcpServer(name); registered.delete(name); }
      return undefined;
    });
    // A server that lists its tools late, after the wait: they come back before her next step.
    pi.on("turn_end", (_event, ctx) => bringBack(pi, ctx, loaded(ctx)));
    const tokenOf = (name: string) => host.mcpServers().find((s) => s.name === name);
    await createMcpExtension({
      loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
      createTransport: (entry) => {
        const s = tokenOf(entry.name);
        if (!s) throw new Error(`MCP server ${entry.name} isn't one of this thread's`);
        const state = (kind: McpStateKind) => {
          if (kind === "online") failed.delete(entry.name);
          else failed.add(entry.name);
          host.mcpServerState?.(entry.name, kind);
        };
        const budget = host.mcpBudget?.(entry.name);
        if (s.command?.length) {
          if (!host.startMcpServer) throw new Error(`the local MCP server ${entry.name} can't be started here`);
          return mcpStdioTransport({ start: () => host.startMcpServer!(entry.name), state, budget });
        }
        if (!("url" in entry.config)) throw new Error(`MCP server ${entry.name} isn't one of this thread's`);
        return mcpTransport({ url: s.url, token: s.token || undefined, state, budget });
      },
      logPath: devNull,
      updateConfig: () => {},
      openUrl: () => {},
    })(pi);
    // After Pi's session_start has started the connections, and before any turn, so the gates see the tools when it starts.
    pi.on("session_start", (_event, ctx) => restore(ctx));
    await createToolSearchExtension()(pi);
  };
}
