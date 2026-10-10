import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionContext, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { WORKDIR, type ExecutionTarget, type Network, type PermissionMode, type ThreadWorkspace, type ToolOps } from "@lyrica/core";
import { Type } from "typebox";
import { setToolsOff } from "./gate.ts";

/** What the workspace tools need for one thread. `Workspace` from core provides it. */
export interface ThreadTools {
  /** Called on every tool call, so a change of target or grants applies at once. */
  target(): ExecutionTarget;
  /** What applies to the thread now, its ancestors' limits included. */
  settings(): ThreadWorkspace;
  network(): Network;
  /**
   * Asks whoever is watching the thread whether a tool call may run. lyricad
   * supplies it; without it, Pi's own UI asks, and with no UI the call is blocked.
   */
  approve?(request: ApprovalRequest): Promise<boolean>;
  /** Switches the thread's mode when a plan is approved. Without it (a subagent), there is no propose_plan. */
  setMode?(mode: PermissionMode): void;
  /**
   * Shows a plan and asks which mode to go ahead in; undefined keeps
   * planning. lyricad supplies it, through the same path as approve; without
   * it, Pi's own UI asks, and with no UI she keeps planning.
   */
  proposePlan?(request: PlanRequest): Promise<GoAhead | undefined>;
}

export interface ApprovalRequest {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface PlanRequest {
  toolCallId: string;
  plan: string;
}

/** The modes an approved plan can go ahead in. */
export const GO_AHEAD = ["ask", "acceptEdits", "auto"] as const satisfies readonly PermissionMode[];
export type GoAhead = (typeof GO_AHEAD)[number];
const LABELS: Record<PermissionMode, string> = { ask: "Ask", acceptEdits: "Accept edits", auto: "Auto", plan: "Plan" };

type Create = (cwd: string, options: { operations: never }) => ToolDefinition;
const TOOLS: Record<keyof ToolOps, Create> = {
  read: createReadToolDefinition as unknown as Create,
  write: createWriteToolDefinition as unknown as Create,
  edit: createEditToolDefinition as unknown as Create,
  bash: createBashToolDefinition as unknown as Create,
};

/** Which tools each permission mode asks about. Plan mode has none of them. */
const ASKS: Record<PermissionMode, string[]> = {
  auto: [],
  acceptEdits: ["bash"],
  ask: ["bash", "write", "edit"],
  plan: [],
};

/** The only tools Plan mode leaves on: the ones that read, read-only delegation, compacting her own context, and propose_plan. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set(["read", "recall", "read_memory", "web_search", "web_fetch", "delegate", "ask_parent", "compact", "propose_plan"]);

/** The tools each switch turns off. */
export const SWITCHED_TOOLS = { webSearch: ["web_search", "web_fetch"], images: ["image"] } as const;

/** The tools the thread's mode and switches have off, of those registered. */
export function toolsOff(s: Pick<ThreadWorkspace, "mode" | "webSearch" | "images">, registered: string[]): string[] {
  const off = new Set<string>();
  if (s.mode === "plan") {
    for (const t of registered) if (!PLAN_TOOLS.has(t)) off.add(t);
  } else {
    off.add("propose_plan");
  }
  if (!s.webSearch) for (const t of SWITCHED_TOOLS.webSearch) off.add(t);
  if (!s.images) for (const t of SWITCHED_TOOLS.images) off.add(t);
  return registered.filter((t) => off.has(t));
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/**
 * Lyrica's read, write, edit and bash: Pi's own tools, with every operation
 * sent to the thread's execution target. Nothing runs in this process. It
 * also enforces the thread's mode and switches: what they turn off isn't
 * offered, and a call to it is refused.
 */
export function createWorkspaceExtension(tools: ThreadTools): ExtensionFactory {
  return (pi) => {
    const off = () => toolsOff(tools.settings(), pi.getAllTools().map((t) => t.name));
    const gate = (ctx: ExtensionContext) => setToolsOff(pi, ctx, "workspace", off());

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

    if (tools.setMode) {
      const setMode = tools.setMode;
      pi.registerTool({
        name: "propose_plan",
        label: "Propose plan",
        description: "Show your plan and ask to go ahead. If it's approved, the thread leaves Plan mode and you carry on with the plan.",
        promptSnippet: "in Plan mode, show your plan and ask to go ahead",
        promptGuidelines: ["In Plan mode, look into what's needed with the tools that read, then call propose_plan with the plan; don't describe changes as done."],
        parameters: Type.Object({ plan: Type.String({ description: "The plan, in Markdown: what you'll change and how, step by step." }) }),
        async execute(id, p, _signal, _update, ctx) {
          const mode = tools.proposePlan ? await tools.proposePlan({ toolCallId: id, plan: p.plan }) : await choose(ctx, p.plan);
          if (!mode) return text("Not approved yet: keep planning. Ask what to change, or improve the plan.");
          try {
            setMode(mode);
          } catch (err) {
            // A branch can't be less strict than the thread it came from.
            return text(`Approved, but this thread can't leave Plan mode: ${(err as Error).message}.`);
          }
          // Pi reads the active tools again before her next step, so she can carry on in this turn.
          gate(ctx);
          return text(`Approved. The thread is in ${LABELS[mode]} mode now: go ahead with the plan.`);
        },
      });
    }

    pi.on("session_start", (_event, ctx) => gate(ctx));

    pi.on("tool_call", async (event, ctx) => {
      // What the mode or a switch has off is never run, even if it was offered before a change.
      if (off().includes(event.toolName)) {
        return { block: true, reason: `${event.toolName} is off in this thread${tools.settings().mode === "plan" ? " (Plan mode)" : ""}.` };
      }
      const { mode } = tools.settings();
      // Anything that reaches outside and changes things there can't be undone from here: it always asks.
      const a = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
      const irreversible = !!a?.openWorldHint && !a.readOnlyHint;
      if (!irreversible && !ASKS[mode].includes(event.toolName)) return undefined;
      const input = event.input as Record<string, unknown>;
      const allowed = tools.approve
        ? await tools.approve({ toolCallId: event.toolCallId, tool: event.toolName, input })
        : await approve(ctx, event.toolName, input);
      return allowed ? undefined : { block: true, reason: "Not approved. Ask what to do instead." };
    });

    // Commands typed with "!" in the terminal run where her tools do.
    pi.on("user_bash", () => ({ operations: tools.target().ops().bash }));

    pi.on("before_agent_start", (event, ctx) => {
      gate(ctx);
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

/** Pi's own UI: which mode to go ahead in, or keep planning. */
async function choose(ctx: ExtensionContext, plan: string): Promise<GoAhead | undefined> {
  if (!ctx.hasUI) return undefined;
  const keep = "Keep planning";
  const picked = await ctx.ui.select(`Go ahead with this plan?\n\n${plan}`, [...GO_AHEAD.map((m) => `Go ahead in ${LABELS[m]}`), keep]);
  return GO_AHEAD.find((m) => picked === `Go ahead in ${LABELS[m]}`);
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
