import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Role, SubagentRecord } from "@lyrica/core";
import { Type, type Static } from "typebox";
import { toolGuidance, type ThreadContext } from "../index.ts";
import { syncEntries } from "../record.ts";
import { registerMemoryTools } from "../tools.ts";
import { SUBAGENT_PREAMBLE } from "./roles.ts";
import { DELEGATE_MESSAGE, outcome, Stopped, type Delegation, type Deliver, type Request, type Run } from "./runs.ts";

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

const Tier = Type.Union([Type.Literal("cheap"), Type.Literal("strong")]);
// She picks a tier, never a model. Only a saved workflow, which a user writes, may name one.
const Step = Type.Object({
  task: Type.String({ description: "What to do, with everything the subagent needs: it sees none of this conversation." }),
  role: Type.Optional(Type.String({ description: "A role; worker if not given." })),
  tier: Type.Optional(Tier),
});

const Params = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("stop"), Type.Literal("steer"), Type.Literal("answer")], { description: "run (the default) starts work; the others act on a run ID." })),
  ...Step.properties,
  task: Type.Optional(Step.properties.task),
  tasks: Type.Optional(Type.Array(Step, { minItems: 1, description: "Several tasks at once; the results come back together." })),
  chain: Type.Optional(Type.Array(Step, { minItems: 1, description: "Steps in order. Each gets the previous step's result, at {previous} if its task has it." })),
  loop: Type.Optional(Type.Object({
    task: Type.String(), worker: Type.Optional(Type.String()), reviewer: Type.Optional(Type.String()),
    rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Default 3." })),
  }, { description: "A worker does the task and a reviewer checks it, round after round, until the reviewer approves." })),
  council: Type.Optional(Type.Object({ question: Type.String() }, { description: "The same question to up to three of this thread's models, then one combined answer." })),
  workflow: Type.Optional(Type.String({ description: "A saved workflow's name." })),
  input: Type.Optional(Type.String({ description: "The workflow's input, for {input} in its steps." })),
  background: Type.Optional(Type.Boolean({ description: "Return a run ID at once; the result arrives as a message later." })),
  folders: Type.Optional(Type.Array(Type.String(), { description: "Only these of this thread's folders." })),
  readOnly: Type.Optional(Type.Boolean({ description: "The subagents may read the folders but not change them." })),
  internet: Type.Optional(Type.Literal(false, { description: "false cuts the subagents off from the internet." })),
  id: Type.Optional(Type.String({ description: "The run ID, for status, wait, stop, steer and answer." })),
  message: Type.Optional(Type.String({ description: "For steer, what to tell the running subagent; for answer, the answer to its question." })),
});
type Params = Static<typeof Params>;

const WORK = ["task", "tasks", "chain", "loop", "council", "workflow"] as const;

function request(p: Params): Request {
  const given = WORK.filter((k) => p[k] !== undefined);
  if (given.length !== 1) throw new Error(`give exactly one of ${WORK.join(", ")}`);
  const narrowing = { folders: p.folders, readOnly: p.readOnly, internet: p.internet };
  if (p.task !== undefined) return { ...narrowing, task: p.task, role: p.role, tier: p.tier };
  if (p.workflow !== undefined) return { ...narrowing, workflow: p.workflow, input: p.input };
  const k = given[0] as "tasks" | "chain" | "loop" | "council";
  return { ...narrowing, [k]: p[k] } as Request;
}

/** One line per subagent: its run, role, status, thread and usage. */
function formatStatus(rows: SubagentRecord[], live: (id: string) => Run | undefined): string {
  if (!rows.length) return "No subagent runs in this thread.";
  return rows.map((r) => {
    const tokens = r.inputTokens + r.outputTokens;
    const asking = live(r.run)?.questions.find((q) => q.sub.ctx.threadId === r.thread);
    return `${r.run} ${r.role} ${r.status}${r.background ? " (background)" : ""}, t:${r.thread}, ${r.model}, ${tokens} tokens${asking ? `\n  asks: ${asking.question}` : ""}`;
  }).join("\n");
}

/** Delivers into a live parent: appended now if she's idle, as a follow-up if she's busy. False once the session has gone. */
function deliverVia(pi: ExtensionAPI, ctx: ExtensionContext, thread: ThreadContext): Deliver {
  return ({ content, details }) => {
    try {
      const message = { customType: DELEGATE_MESSAGE, content, display: true, details };
      if (ctx.isIdle()) {
        pi.sendMessage(message);
        syncEntries(ctx.sessionManager, thread.view.own, thread.threadId);
      } else {
        pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
      }
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The `delegate` tool for one thread. Refuses a thread already at the depth
 * limit. A subagent's tool shares its run's `budget`, so nesting can't start
 * more subagents than one request may.
 */
export function createDelegateExtension(thread: ThreadContext, delegation: Delegation, budget?: { left: number }): ExtensionFactory {
  delegation.recover(thread.user.id);
  if (delegation.depth(thread) >= delegation.limits.depth) throw new Error("this thread is at the depth limit and can't delegate");
  const userId = thread.user.id;
  return (pi) => {
    let requestBudget = budget ?? delegation.newBudget();
    let detach: (() => void) | undefined;
    pi.on("session_start", (_e, ctx) => { detach = delegation.attach(thread, deliverVia(pi, ctx, thread)); });
    pi.on("session_shutdown", () => detach?.());
    pi.on("before_agent_start", (event) => {
      if (!budget) requestBudget = delegation.newBudget();
      const roles = delegation.roles(userId).map((r) => `- ${r.name} (${r.tier}${r.readOnly ? ", read-only" : ""}): ${r.description}`);
      const flows = delegation.workflows(userId).map((w) => `- ${w.name}: ${w.description}`);
      const o = event.systemPromptOptions;
      o.sections = { ...o.sections, delegation: [`Subagent roles:\n${roles.join("\n")}`, flows.length ? `Saved workflows:\n${flows.join("\n")}` : ""].filter(Boolean).join("\n\n") };
    });

    const report = (run: Run) => {
      if (run.done) run.delivered = true;
      return text(outcome(run), { runId: run.id, status: run.status, threads: run.subagents.map((s) => s.ctx.threadId) });
    };

    pi.registerTool({
      name: "delegate",
      label: "Delegate",
      description: "Hand work to subagents: one task, several at once, a chain, a review loop, a council, or a saved workflow. "
        + "Each works in its own thread under this one, with this thread's folders or fewer. Also: status, wait, stop, steer and answer on a run ID.",
      promptSnippet: "hand work to subagents, in the foreground or background",
      promptGuidelines: [
        "Pick a delegate tier by the work, never a model: cheap for searching, reading, summarizing and checking; strong for writing, judgment, and changing code or files. A role brings its own tier.",
        "A subagent sees none of this conversation, so put everything it needs into its task.",
        "Use background: true for long work, and carry on; its result arrives as a message on a later turn.",
        "When a subagent asks a question, answer it with delegate action answer, or ask the person you're talking with first if it's theirs to decide.",
      ],
      parameters: Params,
      async execute(_id, p, signal) {
        const action = p.action ?? "run";
        if (action === "status") {
          const rows = delegation.status(thread).filter((r) => !p.id || r.run === p.id);
          const u = delegation.usage(thread);
          return text(`${formatStatus(rows.slice(0, 20), (id) => { try { return delegation.get(thread, id); } catch { return undefined; } })}\nAll subagents of this thread: ${u.inputTokens + u.outputTokens} tokens.`);
        }
        if (action === "run") {
          const run = delegation.start(thread, request(p), { background: !!p.background, budget: requestBudget });
          if (p.background) return text(`Started run ${run.id} in the background. Its result will arrive as a message.`, { runId: run.id, status: run.status });
          const stop = () => run.stop();
          signal?.addEventListener("abort", stop, { once: true });
          try {
            await run.checkpoint();
          } finally {
            signal?.removeEventListener("abort", stop);
          }
          return report(run);
        }
        const run = delegation.get(thread, p.id);
        if (action === "stop") {
          run.stop();
          await run.checkpoint().catch(() => {});
          return text(`Stopped run ${run.id}.`);
        }
        if (action === "steer") {
          const sub = run.subagents.find((s) => s.status === "running");
          if (!sub || !p.message) throw new Error(sub ? "steer needs a message" : `run ${run.id} has no subagent working right now`);
          sub.steer(p.message);
          return text(`Sent to ${sub.role.name} in run ${run.id}.`);
        }
        if (action === "answer") {
          if (!p.message) throw new Error("answer needs a message");
          run.answer(p.message);
          if (run.background) return text(`Answered. Run ${run.id} carries on in the background.`);
        }
        try {
          // wait, or an answer to a foreground run: until the next question or the end.
          await run.checkpoint(signal);
        } catch (err) {
          if (err instanceof Stopped) return text(`Stopped waiting; run ${run.id} carries on.`);
          throw err;
        }
        return report(run);
      },
    });
  };
}

/**
 * A subagent's own extension: the preamble and its role's prompt, read-only
 * memory, ask_parent, and only the tools its role allows.
 */
export function createSubagentExtension(thread: ThreadContext, role: Role, hooks: { question(q: string): void }, allowed: Set<string>): ExtensionFactory {
  const who = () => ({ threadId: thread.threadId, user: { id: thread.user.id, profile: thread.user.profile } });
  return (pi) => {
    registerMemoryTools(pi, thread.view, who, { readOnly: true });
    pi.registerTool({
      name: "ask_parent",
      label: "Ask Lyrica",
      description: "Stop and ask Lyrica one question you can't go on without. Her answer arrives as your next message.",
      promptSnippet: "ask Lyrica a question you can't go on without, then stop",
      parameters: Type.Object({ question: Type.String() }),
      async execute(_id, p) {
        hooks.question(p.question);
        return { ...text("Your question was sent. Stop here; the answer will come as the next message."), terminate: true };
      },
    });
    pi.on("session_start", () => {
      pi.setActiveTools(pi.getAllTools().map((t) => t.name).filter((n) => allowed.has(n)));
    });
    pi.on("before_agent_start", (event) => {
      const o = event.systemPromptOptions;
      const tools = toolGuidance(o);
      o.customPrompt = `${SUBAGENT_PREAMBLE}\n\n${role.prompt}`;
      o.sections = { ...(tools ? { tools } : {}), ...o.sections };
    });
  };
}
