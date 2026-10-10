import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { askCompaction, COMPACT_GUIDELINES, type ContextMeter } from "./context.ts";
import type { ThreadContext } from "./index.ts";

// Child threads: streams of work Lyrica starts under the thread she's in. Each
// is a thread like any other, hosted by lyricad, which supplies `ThreadsHost`.
// The same tool compacts the thread she's in, with her own summary.

/** What a parent's message to its child starts with, so the child's thread can show it as hers. Only lyricad writes it. */
export const fromParent = (parentThreadId: string) => `[From t:${parentThreadId}]\n\n`;
export const FROM_PARENT = /^\[From t:([^\]\s]+)\]\n\n/;

export type ChildStatus = "working" | "waiting" | "idle";

export interface ChildInfo { id: string; title?: string; status: ChildStatus; updatedAt: string }

export interface StartRequest { title: string; task: string; folders?: string[]; readOnly?: boolean; internet?: false }

export interface ThreadsLimits {
  /** Child threads one message to the parent may start. */
  perRequest: number;
  /** Child threads working at once, per user. */
  concurrency: number;
}

export const DEFAULT_THREADS_LIMITS: ThreadsLimits = { perRequest: 3, concurrency: 2 };

export interface ThreadsHost {
  readonly limits: ThreadsLimits;
  /** Creates a child of `parent`, with its settings or narrower ones, and starts it on the task in the background. */
  start(parent: ThreadContext, req: StartRequest): Promise<{ id: string; link: string }>;
  /** A message to one of this thread's children, or from a child to its parent (`to: "parent"`). */
  message(from: ThreadContext, to: string, text: string): Promise<void>;
  list(parent: ThreadContext): ChildInfo[];
}

const Params = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("message"), Type.Literal("list"), Type.Literal("compact")]),
  title: Type.Optional(Type.String({ description: "For start: the child thread's title." })),
  task: Type.Optional(Type.String({ description: "For start: what to work on, with everything it needs. It starts with your persona and memory, but none of this conversation." })),
  folders: Type.Optional(Type.Array(Type.String(), { description: "For start: only these of this thread's folders." })),
  readOnly: Type.Optional(Type.Boolean({ description: "For start: it may read the folders but not change them." })),
  internet: Type.Optional(Type.Literal(false, { description: "For start: false cuts it off from the internet." })),
  id: Type.Optional(Type.String({ description: "For message: the child thread's ID." })),
  to: Type.Optional(Type.Literal("parent", { description: "For message from a child thread: to its parent." })),
  text: Type.Optional(Type.String({ description: "For message: what to say." })),
  summary: Type.Optional(Type.String({ description: "For compact: what the next stretch needs: what you're doing, decisions, open questions, paths and names." })),
});
type Params = Static<typeof Params>;

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

/**
 * The `threads` tool. In a thread Lyrica can start children from, it
 * starts, messages and lists them; in a child thread, it only messages the
 * parent: children are one level deep. With `meter` (a hosted thread), it
 * also compacts this thread; without `host`, that is all it does.
 */
export function createThreadsExtension(thread: ThreadContext, host: ThreadsHost | undefined, meter?: ContextMeter): ExtensionFactory {
  const self = thread.view.own.getThread(thread.threadId);
  if (!self) throw new Error("no such thread");
  if (self.subagent) throw new Error("a subagent's thread can't start or message child threads");
  // A child whose parent was forgotten, and kept, is a thread of its own.
  const child = self.child && !!self.parent;
  return (pi) => {
    let started = 0;
    pi.on("before_agent_start", (event) => {
      started = 0;
      if (!child) return;
      const parent = thread.view.own.getThread(self.parent ?? "");
      const o = event.systemPromptOptions;
      o.sections = {
        ...o.sections,
        thread: `This is a child thread of t:${self.parent}${parent?.title ? ` ("${parent.title}")` : ""}: a stream of work of its own. `
          + "Post a short update to the parent with threads message to: \"parent\" at milestones and when you finish, not after every step. "
          + "The person you're talking with may also write here; that conversation is yours and theirs, and the parent isn't told.",
      };
    });

    pi.registerTool({
      name: "threads",
      label: "Threads",
      description: [
        !host ? "" : child
          ? "Send your parent thread a short update: threads({ action: \"message\", to: \"parent\", text })."
          : "Child threads: start one on a stream of work of its own, which works in the background and which the person can open and steer; message one; list them.",
        meter ? "When your context is filling up, compact this thread: threads({ action: \"compact\", summary }) replaces the older part of the conversation with your summary when this turn ends; recent messages stay." : "",
      ].filter(Boolean).join(" "),
      promptSnippet: [!host ? "" : child ? "post an update to the parent thread" : "start, message and list child threads", meter ? "compact this thread with your own summary" : ""].filter(Boolean).join("; "),
      promptGuidelines: [...(child || !host ? [] : [
        "Use a subagent (delegate) when you need an answer to carry on and the task is bounded: searching, reading, reviewing, checking.",
        "Start a child thread (threads start) when the work is a stream of its own that outlasts this conversation, that the person may want to follow or steer, or that needs a long context of its own, such as \"I'll keep going on the homelab migration in its own thread.\" Say so, with its link.",
        "A child thread posts updates here as it goes. Message it with threads message; the person can also talk to it directly.",
      ]), ...(meter ? COMPACT_GUIDELINES : [])],
      parameters: Params,
      async execute(_id, p: Params, _signal, _update, ctx) {
        if (p.action === "compact") {
          if (!meter) throw new Error("this thread can't compact");
          const r = askCompaction(meter, String(p.summary ?? ""), ctx.model?.contextWindow ?? 0);
          return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
        }
        if (!host) throw new Error("child threads aren't available here");
        if (p.action === "message") {
          if (!p.text?.trim()) throw new Error("message needs text");
          if (child) {
            if (p.to !== "parent") throw new Error("a child thread messages only its parent: to: \"parent\"");
            await host.message(thread, "parent", p.text);
            return text("Sent to the parent thread.");
          }
          if (!p.id) throw new Error("message needs the child thread's id");
          await host.message(thread, p.id, p.text);
          return text(`Sent to t:${p.id}.`, { threads: [p.id] });
        }
        if (child) throw new Error("a child thread can't start or list child threads; it can delegate, and message its parent");
        if (p.action === "list") {
          const rows = host.list(thread);
          return text(rows.length ? rows.map((r) => `t:${r.id} ${r.title ?? "(untitled)"}: ${r.status}, last ${r.updatedAt}`).join("\n") : "This thread has no child threads.",
            { threads: rows.map((r) => r.id) });
        }
        if (!p.title?.trim() || !p.task?.trim()) throw new Error("start needs a title and a task");
        // Counted before starting, so calls made at once can't all slip under the limit.
        if (started >= host.limits.perRequest) throw new Error(`one message can start at most ${host.limits.perRequest} child threads`);
        started++;
        let made: { id: string; link: string };
        try {
          made = await host.start(thread, { title: p.title.trim(), task: p.task, folders: p.folders, readOnly: p.readOnly, internet: p.internet });
        } catch (err) {
          started--;
          throw err;
        }
        return text(`Started child thread t:${made.id}, working in the background: ${made.link}`, { threads: [made.id] });
      },
    });
  };
}
