import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { cleanPath, within, type Grant, type Models, type ThreadWorkspace, type Workspace } from "@lyrica/core";
import { Type } from "typebox";
import { toolGuidance, type ThreadContext } from "./index.ts";
import { openThreadSession } from "./session.ts";
import { registerMemoryTools } from "./tools.ts";
import { createWorkspaceExtension } from "./workspace.ts";

// Delegation: Lyrica hands a task to a subagent, which runs in a thread of its
// own under hers, on the model for the tier she picked, and returns its result.

export interface DelegateHost {
  models: Models;
  /** Where the subagent's tools run. Without it, a subagent has memory tools only. */
  workspace?: Pick<Workspace, "inheritSettings" | "forThread" | "settings">;
  /** Pi's working directory for subagent sessions. */
  cwd: string;
  /** Subagents running at once, per thread. */
  maxConcurrent?: number;
}

export interface DelegateParams {
  task: string;
  tier: "cheap" | "strong";
  folders?: string[];
  readOnly?: boolean;
  internet?: boolean;
}

const WORKER_PROMPT = `You are a worker that Lyrica handed one task to. Do it with the tools you have, then reply with the result: what you found or did, briefly, with file paths and memory IDs where they help. Your reply goes back to her as it is.
You can search and read her memory, but not add to it. You can't hand work on to anyone else.`;

/** A subagent's extension: a short worker prompt and read-only memory. No persona, no remember, no delegate. */
export function createWorkerExtension(thread: ThreadContext, folders?: () => string[]): ExtensionFactory {
  return (pi) => {
    registerMemoryTools(pi, thread.view, () => ({ threadId: thread.threadId, user: { id: thread.user.id, profile: thread.user.profile } }), { readOnly: true });
    pi.on("before_agent_start", (event) => {
      const o = event.systemPromptOptions;
      const tools = toolGuidance(o);
      const where = folders?.() ?? [];
      o.customPrompt = WORKER_PROMPT;
      o.sections = { ...(tools ? { tools } : {}), ...o.sections, ...(where.length ? { folders: `Your folders: ${where.join(", ")}` } : {}) };
    });
  };
}

/** The `delegate` tool for one thread. A subagent's thread never gets it: depth is 1. */
export function createDelegateExtension(parent: ThreadContext, host: DelegateHost): ExtensionFactory {
  if (parent.view.own.getThread(parent.threadId)?.subagent) throw new Error("a subagent can't delegate");
  const limit = host.maxConcurrent ?? 2;
  let running = 0;
  return (pi) => {
    pi.registerTool({
      name: "delegate",
      label: "Delegate",
      description: "Hand a self-contained task to a subagent. It works in its own thread, with this thread's folders or fewer, and returns its result.",
      promptSnippet: "hand a self-contained task to a cheap or strong subagent",
      promptGuidelines: [
        "Pick the delegate tier by the work, never by model: cheap for searching, reading, summarizing and checking; strong for writing, judgment, and changing code or files.",
        "A subagent sees none of this conversation, so put everything it needs into the task.",
      ],
      parameters: Type.Object({
        task: Type.String({ description: "What to do, with everything the subagent needs to know." }),
        tier: Type.Union([Type.Literal("cheap"), Type.Literal("strong")]),
        folders: Type.Optional(Type.Array(Type.String(), { description: "Only these of this thread's folders." })),
        readOnly: Type.Optional(Type.Boolean({ description: "The subagent may read the folders but not change them." })),
        internet: Type.Optional(Type.Boolean({ description: "Set false to cut the subagent off from the internet." })),
      }),
      async execute(_id, params, signal) {
        if (running >= limit) throw new Error(`${limit} subagents are already running in this thread; wait for one to finish`);
        running++;
        try {
          const { result, threadId } = await runSubagent(parent, host, params, signal);
          return { content: [{ type: "text" as const, text: result }], details: { threadId } };
        } finally {
          running--;
        }
      },
    });
  };
}

/**
 * Runs one subagent to completion: a child thread recorded as a subagent of
 * the parent (an unlogged parent makes it unlogged), the parent's workspace
 * narrowed, and the tier's model resolved through the parent's CallContext,
 * so a private or local-only parent can only hand work to a local model.
 */
export async function runSubagent(parent: ThreadContext, host: DelegateHost, p: DelegateParams, signal?: AbortSignal): Promise<{ result: string; threadId: string }> {
  const { models } = host;
  const { userId, pool } = parent.call;
  const ref = models.resolveModel(`subagent.${p.tier}`, parent.call);

  const child = parent.view.own.createThread({ interface: parent.interface, parent: parent.threadId, subagent: true, title: p.task.slice(0, 80) });
  models.inheritModels(userId, pool, parent.threadId, child.id);
  models.setThreadModel(userId, pool, child.id, "chat", ref);
  const ctx: ThreadContext = { ...parent, threadId: child.id, call: models.callContext(userId, pool, child.id) };

  const extensions: ExtensionFactory[] = [];
  let folders: (() => string[]) | undefined;
  if (host.workspace) {
    const from = host.workspace.settings(userId).thread(parent.threadId);
    host.workspace.inheritSettings({ userId, pool, threadId: parent.threadId }, child.id, narrow(from, p));
    const tools = host.workspace.forThread({ userId, pool, threadId: child.id });
    extensions.push(createWorkspaceExtension(tools));
    folders = tools.folders;
  }
  extensions.unshift(createWorkerExtension(ctx, folders));

  const opened = await openThreadSession({ thread: ctx, models, cwd: host.cwd, extensions });
  const abort = () => void opened.session.abort();
  signal?.addEventListener("abort", abort);
  try {
    await opened.session.prompt(p.task);
    const last = opened.session.messages.findLast((m) => m.role === "assistant") as { content?: { type: string; text?: string }[]; errorMessage?: string } | undefined;
    const text = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (!text && last?.errorMessage) throw new Error(`the subagent failed: ${last.errorMessage}`);
    return { result: text || "(The subagent finished without a reply.)", threadId: child.id };
  } finally {
    signal?.removeEventListener("abort", abort);
    opened.dispose();
  }
}

/** The subagent's workspace: the requested folders and switches, never wider than the parent's. */
function narrow(from: ThreadWorkspace, p: DelegateParams): Partial<Pick<ThreadWorkspace, "grants" | "network">> {
  const narrower: Partial<Pick<ThreadWorkspace, "grants" | "network">> = {};
  if (p.folders || p.readOnly) {
    const grants: Grant[] = p.folders
      ? p.folders.map((path) => {
        const clean = cleanPath(path);
        const outer = from.grants.find((g) => within(clean, g.path));
        if (!outer) throw new Error(`${path} isn't one of this thread's folders`);
        return { path: clean, writable: outer.writable };
      })
      : from.grants;
    narrower.grants = grants.map((g) => ({ path: g.path, writable: g.writable && !p.readOnly }));
  }
  if (p.internet !== undefined) narrower.network = p.internet;
  return narrower;
}
