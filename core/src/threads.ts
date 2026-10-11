// Child threads and projects: the shapes lyricad and the threads tool share,
// and her guidance about them. Pure, so it lives here rather than in the
// extension (principle 8's budget).
import type { PoolView } from "./store/memory.ts";

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

/** Her guidance in a thread that can start child threads, outside a project. */
export const CHILD_THREAD_GUIDELINES = [
  "Use a subagent (delegate) when you need an answer to carry on and the task is bounded: searching, reading, reviewing, checking.",
  "Start a child thread (threads start) when the work is a stream of its own that outlasts this conversation, that the person may want to follow or steer, or that needs a long context of its own, such as \"I'll keep going on the homelab migration in its own thread.\" Say so, mentioning it.",
  "A child thread posts updates here as it goes. Message it with threads message; the person can also talk to it directly.",
];

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

/** One line of the threads tool's list. */
export const threadLine = (r: ChildInfo) =>
  `[t:${r.id}] ${r.title ? JSON.stringify(r.title) : "(untitled)"}: ${r.state ?? r.status}${r.needsYou ? " (waiting on the person)" : ""}, last ${r.updatedAt}`;

/**
 * The project section: the goal, the project page (the user's instructions
 * first), the project's notes since the last sleep, and in the project chat
 * its threads. Empty outside a project.
 */
export function projectSection(own: PoolView["own"], threadId: string, projectThreads?: () => string | undefined): string | undefined {
  const id = own.projectOf(threadId);
  if (!id) return undefined;
  const chat = own.getThread(id)!;
  const page = own.pageForProject(id);
  const notes = own.projectNotes(id, own.watermark());
  const threads = id === threadId ? projectThreads?.() : undefined;
  return [
    `Project [t:${id}]${chat.title ? ` "${chat.title}"` : ""}${id === threadId ? ": this is its project chat." : ": this thread is one of its threads."}`,
    chat.goal && `Goal, in the person's words: ${chat.goal}`,
    page?.instructions && `The person's instructions for this project:\n${page.instructions}`,
    page && !page.archived && page.text.trim() && `<page id="${page.id}" title="${page.title}">\n${page.text}\n</page>`,
    notes.length ? `Notes since the last sleep:\n${notes.map((n) => `- [${n.id}] ${n.text}`).join("\n")}` : undefined,
    threads && `Its threads:\n${threads}`,
  ].filter(Boolean).join("\n\n");
}
