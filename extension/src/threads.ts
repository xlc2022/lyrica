import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  CHILD_THREAD_GUIDELINES, MENTION_GUIDELINE, pickThread, PROJECT_CHAT_GUIDELINES, PROJECT_THREAD_GUIDELINES, threadLine,
  type ChildInfo, type StartRequest, type ThreadsLimits,
} from "@lyrica/core";
import { askCompaction, COMPACT_GUIDELINES, type ContextMeter } from "./context.ts";
import type { ThreadContext } from "./index.ts";
import { formatEntry } from "./memory.ts";

// Child threads: streams of work Lyrica starts under the thread she's in. Each
// is a thread like any other, hosted by lyricad, which supplies `ThreadsHost`.
// The same tool compacts the thread she's in, with her own summary.

export interface ThreadsHost {
  readonly limits: ThreadsLimits;
  /**
   * Creates a child of `parent`, with its settings or narrower ones, and
   * starts it on the task in the background. In a project, past the at-once
   * limit it is queued and starts when a slot frees.
   */
  start(parent: ThreadContext, req: StartRequest): Promise<{ id: string; link: string; queued?: boolean }>;
  /**
   * A message to one of this thread's children, from a child to its parent
   * (`to: "parent"`, with `needsYou` when the person must decide), or in a
   * project from one of its threads to another.
   */
  message(from: ThreadContext, to: string, text: string, opts?: { needsYou?: boolean }): Promise<void>;
  /** This thread's children; in a project's thread, the project's other threads. */
  list(parent: ThreadContext): ChildInfo[];
  /** Resolves a project's thread (`id`, or the calling thread itself), or reopens one. */
  resolve?(from: ThreadContext, id: string | undefined, resolved: boolean): void;
  /** Stops a child's running turn, as Pause does. False if it wasn't working. */
  stop?(from: ThreadContext, id: string): Promise<boolean>;
}

/** Messages `threads read` returns by default, and at most. */
export const READ_DEFAULT = 10;
export const READ_MAX = 30;

const Params = Type.Object({
  action: Type.Union(["start", "message", "list", "read", "stop", "suggest", "resolve", "reopen", "compact"].map((a) => Type.Literal(a))),
  title: Type.Optional(Type.String({ description: "For start: the child thread's title." })),
  task: Type.Optional(Type.String({ description: "For start: what to work on, with everything it needs. It starts with your persona and memory, but none of this conversation." })),
  folders: Type.Optional(Type.Array(Type.String(), { description: "For start: only these of this thread's folders." })),
  readOnly: Type.Optional(Type.Boolean({ description: "For start: it may read the folders but not change them." })),
  internet: Type.Optional(Type.Literal(false, { description: "For start: false cuts it off from the internet." })),
  id: Type.Optional(Type.String({ description: "For message, read, stop, resolve and reopen: the thread, by its ID ([t:…]) or its current title." })),
  last: Type.Optional(Type.Number({ description: `For read: how many of its latest messages, ${READ_DEFAULT} by default, at most ${READ_MAX}.` })),
  to: Type.Optional(Type.Literal("parent", { description: "For message from a child thread: to its parent." })),
  text: Type.Optional(Type.String({ description: "For message: what to say." })),
  needsYou: Type.Optional(Type.Boolean({ description: "For message to the parent from a project's thread: the person must decide something before you can go on." })),
  threads: Type.Optional(Type.Array(Type.Object({ title: Type.String(), task: Type.String() }), { description: "For suggest: the threads you propose, each with a title and its task." })),
  summary: Type.Optional(Type.String({ description: "For compact: what the next stretch needs: what you're doing, decisions, open questions, paths and names." })),
});
type Params = Static<typeof Params>;

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

/**
 * The `threads` tool. In a thread Lyrica can start children from, it
 * starts, messages and lists them; in a child thread, it messages the
 * parent: children are one level deep. In a project chat it also queues
 * starts past the limit, suggests threads and resolves or reopens them; in a
 * project's thread it can also message the project's other threads and
 * resolve itself. With `meter` (a hosted thread), it also compacts this
 * thread; without `host`, that is all it does.
 */
export function createThreadsExtension(thread: ThreadContext, host: ThreadsHost | undefined, meter?: ContextMeter): ExtensionFactory {
  const store = thread.view.own;
  const self = store.getThread(thread.threadId);
  if (!self) throw new Error("no such thread");
  if (self.subagent) throw new Error("a subagent's thread can't start or message child threads");
  // A child whose parent was forgotten, and kept, is a thread of its own.
  const child = self.child && !!self.parent;
  const project = () => store.projectOf(thread.threadId);
  const inProjectChat = () => !!store.getThread(thread.threadId)?.project;
  const projectThread = () => child && project() === self.parent;
  return (pi) => {
    let started = 0;
    let siblings = 0;
    pi.on("before_agent_start", (event) => {
      started = 0;
      siblings = 0;
      if (!child) return;
      const parent = store.getThread(self.parent ?? "");
      const o = event.systemPromptOptions;
      o.sections = {
        ...o.sections,
        thread: projectThread()
          ? `This is a thread of the project [t:${self.parent}]${parent?.title ? ` ("${parent.title}")` : ""}: one task of the project, with its own conversation. `
            + "The person may also write here; that conversation is yours and theirs, and the project chat isn't told."
          : `This is a child thread of [t:${self.parent}]${parent?.title ? ` ("${parent.title}")` : ""}: a stream of work of its own. `
            + "Post a short update to the parent with threads message to: \"parent\" at milestones and when you finish, not after every step. "
            + "The person you're talking with may also write here; that conversation is yours and theirs, and the parent isn't told.",
      };
    });

    const description = () => [
      !host ? "" : projectThread()
        ? "Post an update to the project chat (to: \"parent\", needsYou when the person must decide), message another thread of the project, list them, read one's latest messages, or resolve this thread when its work is delivered."
        : child
          ? "Send your parent thread a short update: threads({ action: \"message\", to: \"parent\", text })."
          : "Child threads: start one on a stream of work of its own, which works in the background and which the person can open and steer; message one; list them; read one's latest messages; stop one's running turn."
            + (inProjectChat() ? " In this project chat, also suggest threads (a card the person starts them from), and resolve or reopen one." : ""),
      meter ? "When your context is filling up, compact this thread: threads({ action: \"compact\", summary }) replaces the older part of the conversation with your summary when this turn ends; recent messages stay." : "",
    ].filter(Boolean).join(" ");

    pi.registerTool({
      name: "threads",
      label: "Threads",
      description: description(),
      promptSnippet: [!host ? "" : child ? "post an update to the parent thread" : "start, message and list child threads", meter ? "compact this thread with your own summary" : ""].filter(Boolean).join("; "),
      promptGuidelines: [
        ...(!host ? [] : projectThread() ? PROJECT_THREAD_GUIDELINES : child ? [] : inProjectChat() ? PROJECT_CHAT_GUIDELINES : CHILD_THREAD_GUIDELINES),
        ...(host || meter ? [MENTION_GUIDELINE] : []), ...(meter ? COMPACT_GUIDELINES : []),
      ],
      parameters: Params,
      async execute(_id, p: Params, _signal, _update, ctx) {
        if (p.action === "compact") {
          if (!meter) throw new Error("this thread can't compact");
          const r = askCompaction(meter, String(p.summary ?? ""), ctx.model?.contextWindow ?? 0);
          return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
        }
        if (!host) throw new Error("child threads aren't available here");
        const inProject = projectThread();
        if (p.action === "message") {
          if (!p.text?.trim()) throw new Error("message needs text");
          if (child && p.to === "parent") {
            if (p.needsYou && !inProject) throw new Error("needsYou is for a project's thread");
            await host.message(thread, "parent", p.text, { needsYou: !!p.needsYou });
            return text(p.needsYou ? "Sent to the project chat; it shows you're waiting on the person." : "Sent to the parent thread.");
          }
          if (child && !inProject) throw new Error("a child thread messages only its parent: to: \"parent\"");
          if (!p.id) throw new Error("message needs the thread's id or title");
          const id = pickThread(p.id, host.list(thread));
          if (inProject) {
            // Counted before sending, so calls made at once can't all slip under the limit.
            if (siblings >= host.limits.siblingMessages) throw new Error(`one turn can message the project's other threads at most ${host.limits.siblingMessages} times`);
            siblings++;
            try { await host.message(thread, id, p.text); } catch (err) { siblings--; throw err; }
            return text(`Sent to [t:${id}].`, { threads: [id] });
          }
          await host.message(thread, id, p.text);
          return text(`Sent to [t:${id}].`, { threads: [id] });
        }
        if (p.action === "list") {
          if (child && !inProject) throw new Error("a child thread can't list child threads; it can delegate, and message its parent");
          const rows = host.list(thread);
          return text(rows.length ? rows.map(threadLine).join("\n") : inProject ? "The project has no other threads." : "This thread has no child threads.",
            { threads: rows.map((r) => r.id) });
        }
        if (p.action === "read") {
          if (child && !inProject) throw new Error("a child thread can't read other threads");
          if (!p.id) throw new Error("read needs the thread's id or title");
          const rows = host.list(thread);
          const id = pickThread(p.id, rows);
          if (!rows.some((r) => r.id === id)) throw new Error(`[t:${id}] isn't ${inProject ? "another thread of this project" : "a child thread of this one"}`);
          if (store.getThread(id)?.unlogged) throw new Error(`[t:${id}] isn't logged, so it can't be read from here`);
          const last = Math.min(READ_MAX, Math.max(1, Math.round(p.last ?? READ_DEFAULT)));
          // Read as from another thread, so entries written unlogged are left out; so are tool results and empty tool calls.
          const entries = store.latestEntries(id, last);
          return text(entries.length ? entries.map(formatEntry).join("\n\n") : `[t:${id}] has no messages to read.`, { threads: [id] });
        }
        if (p.action === "stop") {
          if (child) throw new Error("a thread stops only its own child threads");
          if (!host.stop) throw new Error("stop isn't available here");
          if (!p.id) throw new Error("stop needs the thread's id or title");
          const id = pickThread(p.id, host.list(thread));
          return text(await host.stop(thread, id) ? `Stopped [t:${id}]; it is idle. Message it to go on.` : `[t:${id}] wasn't working.`, { threads: [id] });
        }
        if (p.action === "resolve" || p.action === "reopen") {
          if (!host.resolve || (!inProject && !inProjectChat())) throw new Error(`${p.action} is for a project's threads`);
          const resolved = p.action === "resolve";
          if (inProject && (!resolved || (p.id && pickThread(p.id, [{ id: thread.threadId, title: self.title }]) !== thread.threadId))) {
            throw new Error("a project's thread can resolve only itself");
          }
          if (!inProject && !p.id) throw new Error(`${p.action} needs the thread's id or title`);
          const id = inProject ? undefined : pickThread(p.id!, host.list(thread));
          host.resolve(thread, id, resolved);
          return text(`${resolved ? "Resolved" : "Reopened"} ${id ? `[t:${id}]` : "this thread"}.`, id ? { threads: [id] } : undefined);
        }
        if (child) throw new Error("a child thread can't start child threads; it can delegate, and message its parent");
        if (p.action === "suggest") {
          if (!inProjectChat()) throw new Error("suggest is for a project chat");
          const list = (p.threads ?? []).map((t) => ({ title: t.title.trim(), task: t.task.trim() })).filter((t) => t.title && t.task);
          if (!list.length) throw new Error("suggest needs threads, each with a title and a task");
          return text(`Suggested ${list.length === 1 ? "a thread" : `${list.length} threads`}; the person starts them from the card.`, { suggested: list.length });
        }
        if (!p.title?.trim() || !p.task?.trim()) throw new Error("start needs a title and a task");
        // Counted before starting, so calls made at once can't all slip under the limit.
        if (started >= host.limits.perRequest) throw new Error(`one message can start at most ${host.limits.perRequest} child threads`);
        started++;
        let made: { id: string; link: string; queued?: boolean };
        try {
          made = await host.start(thread, { title: p.title.trim(), task: p.task, folders: p.folders, readOnly: p.readOnly, internet: p.internet });
        } catch (err) {
          started--;
          throw err;
        }
        return text(made.queued
          ? `Queued [t:${made.id}]: it starts when another thread finishes.`
          : `Started child thread [t:${made.id}], working in the background.`, { threads: [made.id] });
      },
    });
  };
}
