import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionContext, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  decide, type CommandRule, holdsSecret, librariesLine, JOB_LIMITS, jobLine, type JobInfo, mcpNamespace, sandboxTools, PROXMOX_READS, PROXMOX_SUSPECT, stricterMode, suspectCommand, suspectKey, SHARED, WORKDIR, writtenFiles, type ExecutionTarget, type ProxmoxAction, type Network, type NewChange, type PermissionMode, type ThreadGitRepository, type ThreadMachine, type ThreadRepository, type ThreadWorkspace, type ToolOps,
} from "@lyrica/core";
import { Type } from "typebox";
import { setToolsOff } from "./gate.ts";
import { proxmoxTool } from "./proxmox.ts";
import { bundleOut, pageTool } from "./page.ts";

/** What the workspace tools need for one thread. `Workspace` from core provides it. */
export interface ThreadTools {
  prepareWorktrees?(): Promise<void>;
  /** The owning project's rules, read fresh on every command. Without it, none. */
  commandRules?(): CommandRule[];
  /** Called on every tool call, so a change of grants applies at once: the sandbox, or one of the thread's machines. */
  target(machine?: string): ExecutionTarget;
  /** What applies to the thread now, its ancestors' limits included. */
  settings(): ThreadWorkspace & { coordinates?: boolean };
  network(): Network;
  /** Whether her sandbox runs have Claude Code on the person's Claude plan now. Without it, never. */
  claudeCode?(): boolean;
  /** The machines the thread may use now, with their mode limits. Without it, none. */
  machines?(): ThreadMachine[];
  /** Whether the user allowed this exact suspect command on this machine in this thread. */
  allowedInThread?(machine: string, command: string): boolean;
  /** The thread's repositories, where each is cloned, and whether its token reaches the sandbox now. Without it, none. */
  repositories?(): ThreadGitRepository[];
  /** Clones or fetches them at the start of a turn, saying what failed. A subagent works in its parent's, so it has none. */
  cloneRepositories?(): Promise<string[]>;
  /** Adds a repository to the thread once the person approved it. Without it, there is no add_repository tool. */
  addRepository?(r: ThreadRepository): ThreadRepository[];
  /** The Git accounts of the thread's pool, by name. */
  gitAccounts?(): { name: string; kind: string; host: string }[];
  /** The MCP servers the thread may use now, by name. Without it, none: a call to an MCP tool is refused. */
  mcpServers?(): { name: string }[];
  /** Whether the user allowed this MCP tool on this server in this thread. */
  toolAllowedInThread?(server: string, tool: string): boolean;
  /** One action on one of the thread's Proxmox machines. Without it, there is no proxmox tool. */
  proxmox?(machine: string, action: ProxmoxAction, vm?: string): Promise<string>;
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
  /** Records what a write or edit call did to a file, so removing its turn can undo it. */
  recordChange?(change: NewChange): void;
  /**
   * Called before her write or edit in the sandbox (the path as she sees it): a text when another thread changed the
   * file lately and hasn't heard from this one, so the call is held once while the two agree who changes what.
   * `inserts`: an edit that only adds text beside text it keeps, which goes through with a notice instead.
   */
  sameFile?(path: string, inserts?: boolean): string | undefined;
  /** Where page preview runs a page: the thread's folders read-only, no network, no credentials. Without it, there is no preview. */
  previewTarget?(): ExecutionTarget;
  /** Records that this thread wrote these files in the sandbox (paths as she sees them), for the file viewer's thread beside a file. */
  madeFiles?(paths: string[]): void;
  /** The same for a command: the files in her folder and /shared newer than `since`, its start, found in the background. */
  madeSince?(since: Date): void;
  /** What the person's Files panel added or removed since her last turn, names only; taking them clears them. */
  fileNotes?(): { added: string[]; removed: string[] };
  /** Starts an approved command in the background (docs/workspace.md, "Background commands"). Without it, bash has no background and there is no jobs tool. */
  startJob?(command: string, machine?: string, timeoutS?: number): Promise<JobInfo>;
  jobs?(): JobInfo[];
  jobOutput?(id: string): { job: JobInfo; output: string };
  stopJob?(id: string): boolean;
}

export interface ApprovalRequest {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  /** The machine the call runs on, and the folder a command runs in there. The approval covers exactly this. */
  machine?: string;
  cwd?: string;
  /** A suspect command's warning (which may be allowed in this thread), or a portrait-photo consent question. */
  warning?: string;
  /** An MCP call: the server's name and the tool's own name on it. The answer may allow that tool in this thread. */
  server?: string;
  serverTool?: string;
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

/** A command's time limit when she sets none, in seconds: a test that hangs (a browser that never closes) can't hold the thread forever. */
export const BASH_TIMEOUT_S = 600;
const BASH_TIMEOUT = Type.Optional(Type.Number({ description: `Timeout in seconds, ${BASH_TIMEOUT_S} if left out (${JOB_LIMITS.timeoutS} in the background). Give a longer one for a long build or test run.` }));
const BACKGROUND = Type.Optional(Type.Boolean({ description: "Run it in the background: you get a job id at once, and are told when it ends. For a download, build or install that takes minutes or more." }));
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

/**
 * The only tools Plan mode leaves on: the ones that read, read-only
 * delegation, her child threads (where compacting her own context is too),
 * propose_plan, and tool_search; of MCP tools, those their server marks read-only.
 */
export const PLAN_TOOLS: ReadonlySet<string> = new Set(["read", "recall", "read_memory", "web_search", "web_fetch", "delegate", "ask_parent", "threads", "react", "propose_plan", "proxmox", "tool_search"]);

/** Tools whose input leaves Lyrica for someone else: SearXNG's engines, a web page's server. */
const LEAVES: ReadonlySet<string> = new Set(["web_search", "web_fetch", "image"]);

/** Tools that change things outside but ask on their own card, with the change in words, so the generic approval doesn't ask too. */
const OWN_CARD: ReadonlySet<string> = new Set(["models"]);

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
const MACHINE = Type.Optional(Type.String({ description: "One of your machines, by name, to run this there. Leave it out for the sandbox." }));

/** What an approval covered: anything run that differs is denied. */
const shown = (tool: string, input: Record<string, unknown>, machine: string | undefined, cwd: string | undefined) =>
  JSON.stringify([tool, machine ?? null, cwd ?? null, tool === "bash" || tool === "proxmox" ? suspectKey(tool, input) : tool === "page" ? [input.action, input.path, input.out] : input.path]);

/**
 * Lyrica's read, write, edit and bash: Pi's own tools, with every operation
 * sent to the thread's execution target. Nothing runs in this process. It
 * also enforces the thread's mode and switches: what they turn off isn't
 * offered, and a call to it is refused.
 */
export function createWorkspaceExtension(tools: ThreadTools): ExtensionFactory {
  return (pi) => {
    /** An MCP tool's server (one of the thread's, or none) and its own name there, and whether the server marks it read-only. */
    const mcpCall = (name: string) => {
      if (!name.startsWith("mcp__")) return undefined;
      const info = pi.getAllTools().find((t) => t.name === name);
      const ns = info?.namespace?.name ?? "";
      const server = tools.mcpServers?.().find((s) => mcpNamespace(s.name) === ns)?.name;
      return { server, tool: name.startsWith(`${ns}__`) ? name.slice(ns.length + 2) : name, readOnly: info?.annotations?.readOnlyHint === true };
    };
    // proxmox is offered only while the thread has a Proxmox machine. An MCP tool its server marks read-only stays on in Plan mode.
    const off = () => [...toolsOff(tools.settings(), pi.getAllTools().filter((t) => !(t.name.startsWith("mcp__") && t.annotations?.readOnlyHint === true)).map((t) => t.name)),
      ...(tools.proxmox && !tools.machines?.().some((m) => m.kind === "proxmox") ? ["proxmox"] : []),
      ...(tools.addRepository && !tools.gitAccounts?.().length ? ["add_repository"] : [])];
    const gate = (ctx: ExtensionContext) => setToolsOff(pi, ctx, "workspace", off());
    /** What each approved call was approved for, by tool call. */
    const approved = new Map<string, string>();
    /** Throws if a call isn't what was approved for it. */
    const bound = (id: string, tool: string, input: Record<string, unknown>, machine?: string, cwd?: string) => {
      const asked = approved.get(id);
      approved.delete(id);
      if (asked !== undefined && asked !== shown(tool, input, machine, cwd)) throw new Error("This isn't what was approved, so it didn't run.");
    };
    /** Where her tools ran this turn: "sandbox" or a machine. */
    let places = new Set<string>();

    for (const [name, create] of Object.entries(TOOLS) as [keyof ToolOps, Create][]) {
      const template = create(WORKDIR, { operations: undefined as never });
      pi.registerTool({
        ...template,
        parameters: Type.Object({
          ...(template.parameters as ReturnType<typeof Type.Object>).properties,
          ...(name === "bash" ? { timeout: BASH_TIMEOUT, ...(tools.startJob ? { background: BACKGROUND } : {}) } : {}),
          machine: MACHINE,
        }) as typeof template.parameters,
        async execute(id, params, signal, onUpdate, ctx) {
          const { machine: named, background, ...rest } = params as Record<string, unknown>;
          if (name === "bash" && background === true && tools.startJob) {
            const machine = (named as string | undefined) || undefined;
            const target = tools.target(machine);
            bound(id, name, rest, machine, machine ? await target.cwd() : undefined);
            const job = await tools.startJob(String(rest.command), machine, typeof rest.timeout === "number" ? rest.timeout : undefined);
            return text(`Started ${jobLine(job)}\nYou'll be told when it ends. jobs shows its output so far (the first part while it runs; the end once it ends) or stops it. To follow a long job's progress, have it write to a file and read that.`);
          }
          if (name === "bash") rest.timeout ??= BASH_TIMEOUT_S;
          // An empty machine is the sandbox, as in tool_call.
          const machine = (named as string | undefined) || undefined;
          const target = tools.target(machine);
          const cwd = await target.cwd();
          bound(id, name, rest, machine, machine ? cwd : undefined);
          const ops = name === "write" || name === "edit" ? recording(target, target.ops()[name], id, tools.recordChange) : target.ops()[name];
          const tool = create(cwd, { operations: ops as never });
          // Pi resolves paths against the session's cwd, which is on the host; use the target's.
          const here = new Proxy(ctx, { get: (t, k) => (k === "cwd" ? cwd : Reflect.get(t, k)) });
          if (machine || (name !== "write" && name !== "edit" && name !== "bash")) return tool.execute(id, rest, signal, onUpdate, here);
          const since = new Date();
          try {
            return await tool.execute(id, rest, signal, onUpdate, here);
          } finally {
            // Which thread wrote what, for the file viewer; a failed sweep only leaves it unrecorded.
            if (name === "bash") tools.madeSince?.(since);
            else if (typeof rest.path === "string") tools.madeFiles?.([posix.resolve(cwd, rest.path)]);
          }
        },
      });
    }

    pi.registerTool(pageTool(tools, (id, input) => bound(id, "page", input)));
    if (tools.proxmox) pi.registerTool(proxmoxTool(tools.proxmox, (id, { machine, ...rest }) => bound(id, "proxmox", rest, machine as string)));

    if (tools.startJob && tools.jobs && tools.jobOutput && tools.stopJob) {
      const { jobs, jobOutput, stopJob } = tools as Required<Pick<ThreadTools, "jobs" | "jobOutput" | "stopJob">>;
      pi.registerTool({
        name: "jobs",
        label: "Background commands",
        description: "This conversation's background commands (bash with background: true): list them, see one's output so far, or stop one.",
        promptSnippet: "list, read or stop your background commands",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("list"), Type.Literal("output"), Type.Literal("stop")]),
          id: Type.Optional(Type.String({ description: "The job, such as j1, for output and stop." })),
        }),
        async execute(_id, p: { action: "list" | "output" | "stop"; id?: string }) {
          if (p.action === "list") {
            const all = jobs();
            return text(all.length ? all.map((j) => jobLine(j)).join("\n") : "No background commands in this conversation.");
          }
          if (!p.id) throw new Error(`${p.action} needs the job's id`);
          if (p.action === "stop") return text(stopJob(p.id) ? `Stopped ${p.id}.` : `${p.id} had already ended.`);
          const { job, output } = jobOutput(p.id);
          return text(`${jobLine(job)}\n${output.trim() ? output : "No output yet."}`);
        },
      } as ToolDefinition);
    }

    if (tools.addRepository) {
      const add = tools.addRepository;
      pi.registerTool({
        name: "add_repository",
        label: "Add repository",
        description: "Add a repository to this conversation, from one of your Git accounts. The person is asked first. Once added, it is cloned into "
          + `${WORKDIR}/repos at the start of your next turn, and the account's token reaches your sandbox for it.`,
        promptSnippet: "ask to add a repository from your Git accounts to this conversation",
        // Reaches beyond the thread, so it always asks, in every mode.
        annotations: { openWorldHint: true, readOnlyHint: false },
        parameters: Type.Object({
          repository: Type.String({ description: "owner/name, as on the forge." }),
          account: Type.String({ description: "Which of your Git accounts reaches it, by name." }),
        }),
        async execute(_id, p: { repository: string; account: string }) {
          const list = add({ name: p.repository, account: p.account });
          return text(`Added. This conversation's repositories: ${list.map((r) => r.name).join(", ")}. It is cloned at the start of your next turn.`);
        },
      } as ToolDefinition);
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
          // A machine's limit still applies, so she doesn't promise to run unattended where calls ask.
          const held = (tools.machines?.() ?? []).filter((m) => stricterMode(mode, m.limit) !== mode)
            .map((m) => ` Calls on ${m.name} still run in ${LABELS[m.limit]} mode, its limit.`).join("");
          return text(`Approved. The thread is in ${LABELS[mode]} mode now: go ahead with the plan.${held}`);
        },
      });
    }

    pi.on("session_start", (_event, ctx) => gate(ctx));

    const sandboxSecrets = (): string[] => { try { return tools.target().secrets?.() ?? []; } catch { return []; } };
    pi.on("tool_call", async (event, ctx) => {
      // What the mode or a switch has off is never run, even if it was offered before a change.
      if (off().includes(event.toolName)) {
        return { block: true, reason: `${event.toolName} is off in this thread${tools.settings().mode === "plan" ? " (Plan mode)" : ""}.` };
      }
      const input = event.input as Record<string, unknown>;
      const rule = event.toolName === "bash" ? decide(String(input.command), tools.commandRules?.() ?? []) : undefined;
      if (rule?.decision === "forbid") return { block: true, reason: `This project's rules forbid \`${rule.prefix}\`. Ask the user to run it, or do it another way.` };
      const mcp = mcpCall(event.toolName);
      // A call that reaches someone else (a search, a page, an MCP server) never carries one of the sandbox's credentials.
      if ((mcp || LEAVES.has(event.toolName)) && holdsSecret(JSON.stringify(input), sandboxSecrets())) {
        return { block: true, reason: "That would send one of this thread's credentials out of Lyrica. Leave it out." };
      }
      // An MCP tool: one its server marks read-only runs; any other leaves the server, so it always asks, in every mode.
      if (mcp) {
        if (!mcp.server) return { block: true, reason: `${event.toolName} isn't a tool of this thread's MCP servers.` };
        if (mcp.readOnly || tools.toolAllowedInThread?.(mcp.server, mcp.tool)) return undefined;
        const request: ApprovalRequest = { toolCallId: event.toolCallId, tool: event.toolName, input, server: mcp.server, serverTool: mcp.tool };
        const allowed = tools.approve ? await tools.approve(request) : await approve(ctx, request);
        return allowed ? undefined : { block: true, reason: "Not approved. Ask what to do instead." };
      }
      const pve = event.toolName === "proxmox";
      const page = event.toolName === "page";
      const place = event.toolName in TOOLS ? (input.machine as string | undefined) || "sandbox" : pve ? String(input.machine) : page ? "sandbox" : undefined;
      // A file another thread just changed is held before anyone is asked, so a held change is never one the person approved.
      // A command is held the same way for the files it plainly writes (its redirections and tee); the sweep after it finds the rest.
      if (place === "sandbox" && tools.sameFile) {
        const paths = event.toolName === "write" || event.toolName === "edit" ? (typeof input.path === "string" ? [input.path] : [])
          : event.toolName === "bash" ? writtenFiles(String(input.command))
          : page && input.action === "bundle" && typeof input.path === "string" ? [bundleOut(input.path, input.out as string | undefined)] : [];
        const cwd = paths.length ? await tools.target().cwd() : "";
        const inserts = event.toolName === "edit" && insertsOnly(input);
        for (const path of paths) {
          const held = tools.sameFile(posix.resolve(cwd, path), inserts);
          if (held) return { block: true, reason: held };
        }
      }
      const machine = place && place !== "sandbox" ? tools.machines?.().find((m) => m.name === place && (m.kind === "proxmox") === pve) : undefined;
      if (place && place !== "sandbox" && !machine) return { block: true, reason: `${place} isn't one of this thread's ${pve ? "Proxmox " : ""}machines.` };
      // On a machine, the stricter of the thread's mode and the machine's limit.
      const mode = machine ? stricterMode(tools.settings().mode, machine.limit) : tools.settings().mode;
      // A Proxmox action that reads asks like read, and one that powers like bash; Plan mode only reads.
      const reads = pve && PROXMOX_READS.has(input.action as ProxmoxAction);
      if (pve && mode === "plan" && !reads) return { block: true, reason: "Plan mode only reads: proxmox status, list and snapshots." };
      const as = pve ? (reads ? "read" : "bash") : page ? (input.action === "bundle" ? "write" : "read") : event.toolName;
      // Anything that reaches outside and changes things there can't be undone from here: it always asks.
      const a = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
      const irreversible = !!a?.openWorldHint && !a.readOnlyHint && !OWN_CARD.has(event.toolName);
      const warning = !machine ? undefined : pve ? PROXMOX_SUSPECT[input.action as ProxmoxAction] : event.toolName === "bash" ? suspectCommand(String(input.command)) : undefined;
      const suspect = !!warning && !tools.allowedInThread?.(machine!.name, suspectKey(event.toolName, input));
      // The first call on a machine in a turn asks if anything earlier ran somewhere else, so output from one place can't steer her onto another.
      const moved = !!machine && !places.has(machine.name) && places.size > 0;
      if (!irreversible && !suspect && !moved && rule?.decision !== "ask" && ((rule?.decision === "allow" && !machine) || !ASKS[mode].includes(as))) {
        if (place) places.add(place);
        return undefined;
      }
      const request: ApprovalRequest = { toolCallId: event.toolCallId, tool: event.toolName, input };
      if (machine) Object.assign(request, { machine: machine.name }, pve ? {} : { cwd: await tools.target(machine.name).cwd() }, suspect ? { warning } : {});
      const allowed = tools.approve ? await tools.approve(request) : await approve(ctx, request);
      if (!allowed) return { block: true, reason: "Not approved. Ask what to do instead." };
      if (place) {
        places.add(place);
        const { machine: _, ...rest } = input;
        approved.set(event.toolCallId, shown(event.toolName, rest, request.machine, request.cwd));
      }
      return undefined;
    });

    // Commands typed with "!" in the terminal run where her tools do.
    pi.on("user_bash", () => ({ operations: tools.target().ops().bash }));

    pi.on("before_agent_start", async (event, ctx) => {
      await tools.prepareWorktrees?.();
      places = new Set();
      gate(ctx);
      // Each turn starts from the forge as it is now; what failed is said, and the turn goes on.
      const problems = tools.repositories?.().length && tools.cloneRepositories ? await tools.cloneRepositories().catch((err: Error) => [err.message]) : [];
      const options = event.systemPromptOptions;
      const git = gitSection(tools, problems);
      options.sections = { ...options.sections, workspace: describe(tools), ...(git ? { git } : {}) };
    });
  };
}

/**
 * Write and edit, keeping what the file held before each write. A path the
 * target refuses fails before anything is recorded, so nothing outside the
 * thread's folders is ever kept.
 */
export function recording<T extends ToolOps["write"] | ToolOps["edit"]>(target: ExecutionTarget, ops: T, toolCall: string, record?: (c: NewChange) => void): T {
  if (!record) return ops;
  // edit's read, which gets the file as it is (read masks keys on a machine).
  const read = target.ops().edit;
  return {
    ...ops,
    async writeFile(path: string, content: string | Buffer) {
      const before = await read.readFile(path).catch(() => undefined);
      // A file that exists but couldn't be read can't be put back, so it isn't recorded (and never deleted).
      const undoable = before !== undefined || !(await exists(target, path));
      await ops.writeFile(path, content);
      // The write happened; failing to record it (a locked home) mustn't fail the call.
      if (undoable) try { record({ toolCall, target: target.name, path, before, after: content }); } catch { /* not undoable */ }
    },
  };
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

async function exists(target: ExecutionTarget, path: string): Promise<boolean> {
  const { exitCode } = await target.ops().bash.exec(`test -e ${quote(path)} || test -L ${quote(path)}`, await target.cwd(), { onData: () => {} }).catch(() => ({ exitCode: 0 }));
  return exitCode === 0;
}

async function approve(ctx: ExtensionContext, r: ApprovalRequest): Promise<boolean> {
  if (!ctx.hasUI) return false;
  if (r.server) return ctx.ui.confirm(`Allow ${r.server}'s ${r.serverTool}?`, JSON.stringify(r.input, null, 2));
  const what = r.tool === "bash" ? String(r.input.command) : r.tool === "proxmox" ? `proxmox ${suspectKey(r.tool, r.input)}` : `${r.tool} ${String(r.input.path)}`;
  return ctx.ui.confirm(r.machine ? `Allow this on ${r.machine}?` : "Allow this?", [r.warning, what].filter(Boolean).join("\n"));
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
  const grants = s.grants.map((g) => `${g.path} (${g.writable ? "read-write" : "read-only"})`);
  const all = tools.machines?.() ?? [];
  const limit = (m: ThreadMachine) => (m.limit === "auto" ? "works freely" : `asks like ${LABELS[m.limit]} at most`);
  const machines = all.filter((m) => m.kind !== "proxmox").map((m) => `${m.name} (${limit(m)}${m.root ? `, in ${m.root}` : ""}${m.asUser ? ", logged in as the person's own account" : ""})`);
  const pves = all.filter((m) => m.kind === "proxmox").map((m) => `${m.name} (${limit(m)})`);
  return [
    `Your file and command tools run in a sandbox. ${WORKDIR} is this conversation's folder; uploads arrive in ${WORKDIR}/uploads.`,
    ...(s.coordinates ? [READ_ONLY_CHAT] : []),
    LINK_LINE,
    grants.length ? `Folders you were given: ${grants.join(", ")}.` : "No other folders were given to you in this conversation.",
    SHARED_LINE,
    ...(s.grants.some((g) => g.writable) ? [BUILD_THERE] : []),
    ...(s.threadWork ? [
      ...(s.threadWork.base ? ["You hold the project's base checkout: scaffold or merge here, then resolve this thread to release it."] : []),
      ...(s.threadWork.reason ? [`No worktree for some folders: ${s.threadWork.reason}. Those folders keep their listed grants.`] : []),
      ...(s.threadWork.worktrees.length ? [`Work and commit only in these worktrees for their repositories, never in the original checkout:\n${s.threadWork.worktrees.map((w) => `${w.repo}: worktree ${w.path}, branch ${w.branch}`).join("\n")}`] : []),
    ] : []),
    network(tools.network()),
    ...[toolsLine(), librariesLine()].filter(Boolean),
    ...(machines.length ? [`Machines you can work on over SSH, with the machine argument: ${machines.join(", ")}. The sandbox's network settings don't apply there.`] : []),
    ...(pves.length ? [`Proxmox machines you can manage with the proxmox tool: ${pves.join(", ")}.`] : []),
    ...(tools.claudeCode?.() ? [CLAUDE_CODE_LINE] : []),
    ...fileNotes(tools.fileNotes?.()),
  ].join("\n");
}

/** A project chat builds nothing itself: a model building alone in its own folder, three runs running, is why. */
export const READ_ONLY_CHAT = `Every folder here is read-only to you, ${WORKDIR} and ${SHARED} included (/tmp lasts one command): a code thread makes or changes every file, and puts what you need to see in ${SHARED}. Uploads here land in ${WORKDIR}/shared/uploads and images you make in ${WORKDIR}/shared/images, which your threads see as ${SHARED}/uploads and ${SHARED}/images.`;

/** How she shows a file: a model once linked its deliverables relatively (./site/index.html), which opened nothing. */
export const LINK_LINE = `A ${WORKDIR} or ${SHARED} path you write is a link the person can open, and an image you write as markdown (![what it shows](${WORKDIR}/plot.png)) shows in your message. Link a file by its absolute path ([the page](${SHARED}/site/index.html)), never a relative one.`;

/** Threads hand files to each other through one folder: a model once planned to send a whole page as base64 chunks in messages. */
export const SHARED_LINE = `${SHARED} is shared with your parent and child threads (in a project, with its chat and every thread): hand files over there; messages carry words, not files.`;

/** With a read-write folder given, work for it goes there: a model once built a whole project in the sandbox's own folder instead. */
export const BUILD_THERE = `Build, edit and save the work in a read-write folder you were given (or a repository in ${WORKDIR}/repos), never as loose files in ${WORKDIR}, which is for scratch and things to show the person.`;

/** The one prompt line for a thread with Claude Code (docs/workspace.md, "Claude Code"). */
export const CLAUDE_CODE_LINE = "Claude Code, Anthropic's coding agent, is on here: delegate a coding or repository job to role claude. It works in this sandbox, in the background, and its report arrives as a message; delegate message continues it. With no delegate tool, `claude -p \"<task>\"` with bash does the same. It spends the person's own Claude plan, so use it for jobs big or hard enough to need it, never for conversation. If it says the plan's usage limit is reached, don't do the job another way: set a wake-up (threads, later) for when it resets and carry on then.";

/** The sandbox's programs on this host (sandboxTools in core), and how to use its Chromium when it has one. */
export function toolsLine(t: { programs: string[]; browser?: string } = sandboxTools()): string {
  const parts = t.programs.length ? [`The sandbox has bash, ${t.programs.join(", ")}${t.browser ? " and headless Chromium" : ""}.`] : [];
  if (t.browser) parts.push("To check a page, use page preview. To script a browser (clicks, several pages), Playwright and Puppeteer use the same Chromium, never their own download: `executablePath: process.env.CHROME_PATH` and `args: [\"--no-sandbox\"]`. A static page is checked once it parses and one preview looks right.");
  return parts.join(" ");
}

/** With internet off, what can't be fetched stays unchecked rather than worked around. */
export const OFFLINE_LINE = "Public CDNs and package registries are out of reach, so don't mirror or proxy them: say what you couldn't check, or ask the person to turn Internet on or allow the host.";

/** The Git guide (git.md): the defaults the project's instructions can override. */
export const GIT_GUIDE = readFileSync(new URL("./git.md", import.meta.url), "utf8").trim();

/** The Git guide and the thread's repositories, for every turn of a thread that has any. */
export function gitSection(tools: ThreadTools, problems: string[] = []): string | undefined {
  const repos = tools.repositories?.() ?? [];
  if (!repos.length) return undefined;
  const line = (r: ThreadGitRepository) => `- ${r.name} on ${r.host}, through your account ${r.account}, cloned at ${r.path}${r.reachable ? "" : " (its host isn't reachable from this conversation's sandbox, so you can't push or fetch)"}`;
  return [GIT_GUIDE, `Your repositories here:\n${repos.map(line).join("\n")}`, ...(problems.length ? [`At the start of this turn:\n${problems.map((p) => `- ${p}`).join("\n")}`] : [])].join("\n\n");
}

/** One line naming what the person added or removed in the Files panel since her last turn. */
function fileNotes(n?: { added: string[]; removed: string[] }): string[] {
  if (!n || (!n.added.length && !n.removed.length)) return [];
  const list = (paths: string[]) => (paths.length > 20 ? `${paths.slice(0, 20).join(", ")} and ${paths.length - 20} more` : paths.join(", "));
  const parts = [n.added.length ? `added ${list(n.added)}` : "", n.removed.length ? `removed ${list(n.removed)}` : ""].filter(Boolean);
  return [`Since your last turn, in the Files panel, the person ${parts.join(" and ")}.`];
}

function network(n: Network): string {
  const parts = [`Internet for commands: ${n.internet ? "on" : "off"}.`, `Local services (programs on this server): ${n.services ? "on" : "off"}.`];
  if (n.hosts.length) parts.push(`Hosts you may reach: ${n.hosts.join(", ")}.`);
  if (!n.internet) parts.push(OFFLINE_LINE);
  return parts.join(" ");
}

/**
 * Whether an edit call only adds text: each replacement keeps its old text whole at the start or the end of the new,
 * so nothing another thread wrote there changes (docs/workspace.md, "Same file").
 */
export function insertsOnly(input: Record<string, unknown>): boolean {
  const raw = Array.isArray(input.edits) ? input.edits : typeof input.oldText === "string" ? [{ oldText: input.oldText, newText: input.newText }] : [];
  const edits = raw as { oldText?: unknown; newText?: unknown }[];
  return edits.length > 0 && edits.every((e) => typeof e?.oldText === "string" && typeof e.newText === "string" && e.oldText.length > 0
    && e.newText.length > e.oldText.length && (e.newText.startsWith(e.oldText) || e.newText.endsWith(e.oldText)));
}
