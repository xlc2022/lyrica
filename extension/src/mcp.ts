import { devNull } from "node:os";
import { createMcpExtension, createToolSearchExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mcpTransport, type McpStateKind, type ThreadMcpServer } from "@lyrica/core";

// MCP servers (DESIGN.md, "MCP servers"): Pi's own client and tool_search,
// with nothing about servers read from or written to disk. Each granted
// server is registered for the session, deferred, so its tools reach the
// model only when tool_search loads them. The workspace gate decides which
// calls run, ask, or are off.

export interface McpServersHost {
  /** The thread's servers now: granted, of its pool, and a private one only once its host passed the check. Read at every call. */
  mcpServers(): ThreadMcpServer[];
  /** At the start of a turn: checks the private servers' hosts, saying what is held back. */
  checkMcpServers?(): Promise<string[]>;
  /** How a connection went, for the server's state in Settings. */
  mcpServerState?(name: string, kind: McpStateKind): void;
}

/** The section that tells her about a server held back this turn. */
const SECTION = "mcp_problems";

/**
 * Pi's MCP and tool_search extensions, and the thread's servers registered
 * for the session. Pi's own mcp.json files (global and project) are not
 * read, its OAuth credentials file is never used (each connection uses
 * Lyrica's transport, with the token as a bearer header and no OAuth), its
 * mcp.log gets nothing (the transport drops the servers' log messages, and
 * the log points at the null device), and results reach Pi already cut
 * below its 20 KB limit, so it saves no full text to a temporary file.
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
        const key = JSON.stringify([s.url, s.token, s.description]);
        if (registered.get(name) === key) continue;
        pi.registerMcpServer(name, { url: s.url, exposure: "deferred", ...(s.description ? { description: s.description } : {}) });
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
    pi.on("before_agent_start", async (event) => {
      const problems = host.checkMcpServers ? await host.checkMcpServers().catch((err: Error) => [err.message]) : [];
      sync();
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
    const tokenOf = (name: string) => host.mcpServers().find((s) => s.name === name);
    await createMcpExtension({
      loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
      createTransport: (entry) => {
        const s = tokenOf(entry.name);
        if (!s || !("url" in entry.config)) throw new Error(`MCP server ${entry.name} isn't one of this thread's`);
        return mcpTransport({ url: s.url, token: s.token || undefined, state: (kind) => host.mcpServerState?.(entry.name, kind) });
      },
      logPath: devNull,
      updateConfig: () => {},
      openUrl: () => {},
    })(pi);
    await createToolSearchExtension()(pi);
  };
}
