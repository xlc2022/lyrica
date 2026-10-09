import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionContext, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { WORKDIR, type ExecutionTarget, type Network, type ThreadWorkspace, type ToolOps } from "@lyrica/core";

/** What the workspace tools need for one thread. `Workspace` from core provides it. */
export interface ThreadTools {
  /** Called on every tool call, so a change of target or grants applies at once. */
  target(): ExecutionTarget;
  settings(): ThreadWorkspace;
  network(): Network;
}

type Create = (cwd: string, options: { operations: never }) => ToolDefinition;
const TOOLS: Record<keyof ToolOps, Create> = {
  read: createReadToolDefinition as unknown as Create,
  write: createWriteToolDefinition as unknown as Create,
  edit: createEditToolDefinition as unknown as Create,
  bash: createBashToolDefinition as unknown as Create,
};

/** Which tools each permission mode asks about. */
const ASKS: Record<ThreadWorkspace["mode"], string[]> = {
  auto: [],
  "ask-commands": ["bash"],
  "ask-changes": ["bash", "write", "edit"],
};

/**
 * Lyrica's read, write, edit and bash: Pi's own tools, with every operation
 * sent to the thread's execution target. Nothing runs in this process.
 */
export function createWorkspaceExtension(tools: ThreadTools): ExtensionFactory {
  return (pi) => {
    for (const [name, create] of Object.entries(TOOLS) as [keyof ToolOps, Create][]) {
      const template = create(WORKDIR, { operations: undefined as never });
      pi.registerTool({
        ...template,
        async execute(id, params, signal, onUpdate, ctx) {
          const target = tools.target();
          const cwd = await target.cwd();
          const tool = create(cwd, { operations: target.ops()[name] as never });
          // Pi resolves paths against the session's cwd, which is on the host; use the target's.
          const here = new Proxy(ctx, { get: (t, k) => (k === "cwd" ? cwd : Reflect.get(t, k)) });
          return tool.execute(id, params, signal, onUpdate, here);
        },
      });
    }

    pi.on("tool_call", async (event, ctx) => {
      const { mode } = tools.settings();
      if (!ASKS[mode].includes(event.toolName)) return undefined;
      return (await approve(ctx, event.toolName, event.input)) ? undefined : { block: true, reason: "Not approved. Ask what to do instead." };
    });

    // Commands typed with "!" in the terminal run where her tools do.
    pi.on("user_bash", () => ({ operations: tools.target().ops().bash }));

    pi.on("before_agent_start", (event) => {
      const options = event.systemPromptOptions;
      options.sections = { ...options.sections, workspace: describe(tools) };
    });
  };
}

async function approve(ctx: ExtensionContext, tool: string, input: Record<string, unknown>): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const what = tool === "bash" ? String(input.command) : `${tool} ${String(input.path)}`;
  return ctx.ui.confirm("Allow this?", what);
}

/** A short, stable description of where she works, so the prompt stays cacheable. */
export function describe(tools: ThreadTools): string {
  const s = tools.settings();
  if (s.target !== "sandbox") return `Your file and command tools run on ${s.target.slice(4)} over SSH.`;
  const grants = s.grants.map((g) => `${g.path} (${g.writable ? "read-write" : "read-only"})`);
  return [
    `Your file and command tools run in a sandbox. ${WORKDIR} is this conversation's folder; uploads arrive in ${WORKDIR}/uploads.`,
    grants.length ? `Folders you were given: ${grants.join(", ")}.` : "No other folders were given to you in this conversation.",
    network(tools.network()),
  ].join("\n");
}

function network(n: Network): string {
  const parts = [`Internet for commands: ${n.internet ? "on" : "off"}.`, `This machine's services: ${n.services ? "on" : "off"}.`];
  if (n.hosts.length) parts.push(`Hosts you may reach: ${n.hosts.join(", ")}.`);
  return parts.join(" ");
}
