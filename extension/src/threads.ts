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

/** A project's thread, as the project chat sees it: waiting covers an approval and a question for the person (`needsYou`). */
export type ThreadState = "working" | "waiting" | "queued" | "idle" | "resolved";

export interface ChildInfo { id: string; title?: string; status: ChildStatus; state?: ThreadState; needsYou?: boolean; updatedAt: string }

export interface StartRequest { title: string; task: string; folders?: string[]; readOnly?: boolean; internet?: false }

export interface Suggestion { title: string; task: string }

export interface ThreadsLimits {
  /** Child threads one message to the parent may start. */
  perRequest: number;
  /** Child threads working at once, per user. */
  concurrency: number;
  /** Messages one turn of a project's thread may send to the project's other threads. */
  siblingMessages: number;
}

export const DEFAULT_THREADS_LIMITS: ThreadsLimits = { perRequest: 3, concurrency: 2, siblingMessages: 3 };

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
}

const Params = Type.Object({
  action: Type.Union(["start", "message", "list", "suggest", "resolve", "reopen", "compact"].map((a) => Type.Literal(a))),
  title: Type.Optional(Type.String({ description: "For start: the child thread's title." })),
  task: Type.Optional(Type.String({ description: "For start: what to work on, with everything it needs. It starts with your persona and memory, but none of this conversation." })),
  folders: Type.Optional(Type.Array(Type.String(), { description: "For start: only these of this thread's folders." })),
  readOnly: Type.Optional(Type.Boolean({ description: "For start: it may read the folders but not change them." })),
  internet: Type.Optional(Type.Literal(false, { description: "For start: false cuts it off from the internet." })),
  id: Type.Optional(Type.String({ description: "For message, resolve and reopen: the thread, by its ID ([t:…]) or its current title." })),
  to: Type.Optional(Type.Literal("parent", { description: "For message from a child thread: to its parent." })),
  text: Type.Optional(Type.String({ description: "For message: what to say." })),
  needsYou: Type.Optional(Type.Boolean({ description: "For message to the parent from a project's thread: the person must decide something before you can go on." })),
  threads: Type.Optional(Type.Array(Type.Object({ title: Type.String(), task: Type.String() }), { description: "For suggest: the threads you propose, each with a title and its task." })),
  summary: Type.Optional(Type.String({ description: "For compact: what the next stretch needs: what you're doing, decisions, open questions, paths and names." })),
});
type Params = Static<typeof Params>;

/** Her guidance in a project chat: she coordinates, and the work happens in threads. Guidance, never a boundary. */
export const PROJECT_CHAT_GUIDELINES = [
  "This is a project chat: you coordinate the project here, and the work happens in its threads.",
  "Answer a quick question here yourself. Start one thread per task (threads start), even when one message holds several; mention each.",
  "A follow-up about work a thread is already on goes to that thread (threads message); say which thread you sent it to.",
  "When the person asks you to propose first, suggest threads (threads suggest) instead of starting them.",
  "When the person says how they want the project run (how many threads at once, who to ask, what to avoid), save it as a note with remember.",
];

/** Her guidance in a project's thread. */
export const PROJECT_THREAD_GUIDELINES = [
  "Post an update to the project chat (threads message to: \"parent\") at milestones and when you finish, not after every step.",
  "Set needsYou only when the person must decide something before you can go on.",
  "Save lasting decisions about the project with remember.",
  "When the work is delivered, resolve this thread (threads resolve).",
  "You may message another thread of this project (threads message with its id) when its work affects yours.",
];

/** How she mentions a thread, in every thread: by ID, which the person sees as its current title. */
export const MENTION_GUIDELINE = "Mention a thread as [t:<id>] and a message as [e:<id>#<n>]: the person sees the thread's current title, linked, so don't write the title beside it. A person may name a thread by its title; use its ID when you mention it.";

/**
 * A thread named by its ID (bare, `t:…` or `[t:…]`) or its current title,
 * among `rows`. A title matches without regard to case; one that matches
 * more than one thread is refused, listing them.
 */
export function pickThread(ref: string, rows: { id: string; title?: string }[]): string {
  const bare = ref.trim().replace(/^\[(.*)\]$/, "$1").replace(/^t:/, "");
  if (rows.some((r) => r.id === bare)) return bare;
  const named = rows.filter((r) => r.title?.trim().toLowerCase() === ref.trim().toLowerCase());
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new Error(`more than one thread is called ${JSON.stringify(ref.trim())}: ${named.map((r) => `[t:${r.id}]`).join(", ")}; use its ID`);
  // Not one of these: the host says whether it exists at all.
  return bare;
}

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

const listLine = (r: ChildInfo) =>
  `[t:${r.id}] ${r.title ? JSON.stringify(r.title) : "(untitled)"}: ${r.state ?? r.status}${r.needsYou ? " (waiting on the person)" : ""}, last ${r.updatedAt}`;

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
        ? "Post an update to the project chat (to: \"parent\", needsYou when the person must decide), message another thread of the project, list them, or resolve this thread when its work is delivered."
        : child
          ? "Send your parent thread a short update: threads({ action: \"message\", to: \"parent\", text })."
          : "Child threads: start one on a stream of work of its own, which works in the background and which the person can open and steer; message one; list them."
            + (inProjectChat() ? " In this project chat, also suggest threads (a card the person starts them from), and resolve or reopen one." : ""),
      meter ? "When your context is filling up, compact this thread: threads({ action: \"compact\", summary }) replaces the older part of the conversation with your summary when this turn ends; recent messages stay." : "",
    ].filter(Boolean).join(" ");

    pi.registerTool({
      name: "threads",
      label: "Threads",
      description: description(),
      promptSnippet: [!host ? "" : child ? "post an update to the parent thread" : "start, message and list child threads", meter ? "compact this thread with your own summary" : ""].filter(Boolean).join("; "),
      promptGuidelines: [
        ...(!host ? [] : projectThread() ? PROJECT_THREAD_GUIDELINES : child ? [] : inProjectChat() ? PROJECT_CHAT_GUIDELINES : [
          "Use a subagent (delegate) when you need an answer to carry on and the task is bounded: searching, reading, reviewing, checking.",
          "Start a child thread (threads start) when the work is a stream of its own that outlasts this conversation, that the person may want to follow or steer, or that needs a long context of its own, such as \"I'll keep going on the homelab migration in its own thread.\" Say so, mentioning it.",
          "A child thread posts updates here as it goes. Message it with threads message; the person can also talk to it directly.",
        ]),
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
          return text(rows.length ? rows.map(listLine).join("\n") : inProject ? "The project has no other threads." : "This thread has no child threads.",
            { threads: rows.map((r) => r.id) });
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
