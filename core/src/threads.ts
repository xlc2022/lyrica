// Child threads and projects: the shapes lyricad and the threads tool share,
// and her guidance about them. Pure, so it lives here rather than in the
// extension (principle 8's budget).
import type { PoolView } from "./store/memory.ts";

/** What a parent's message to its child starts with, so the child's thread can show it as hers. Only lyricad writes it. */
export const fromParent = (parentThreadId: string) => `[From t:${parentThreadId}]\n\n`;
export const FROM_PARENT = /^\[From t:([^\]\s]+)\]\n\n/;
/** The mark lyricad puts on what it shows the project chat about its threads (daemon/src/watch.ts). */
export const WATCHING_MARK = "[Watching threads]\n\n";
export const WATCHING = /^\[Watching threads\]\n\n/;
/**
 * What a wake-up's note starts with (daemon/src/wakeups.ts): when it was set
 * and, if it fires late (the user was locked), when it was due. Times are
 * UTC, to the minute. Only lyricad writes it.
 */
export const wakeupMark = (setAt: string, dueAt?: string) => `[Wake-up, set ${minute(setAt)}${dueAt ? `, due ${minute(dueAt)}` : ""}]\n\n`;
export const WAKEUP = /^\[Wake-up, set ([0-9T:-]+Z)(?:, due ([0-9T:-]+Z))?\]\n\n/;
const minute = (iso: string) => `${iso.slice(0, 16)}Z`;

/** A thread's wake-ups: pending at once, fired in a day, and how far ahead, in minutes. */
export const WAKEUP_LIMITS = { pending: 3, perDay: 24, maxMinutes: 7 * 24 * 60 };

/**
 * A look as memory shows it: which threads it pointed at, never what it
 * quoted, so sleep and recall take the person's words from where they were said.
 */
export function lookPointer(text: string): string | undefined {
  if (!WATCHING.test(text)) return undefined;
  const ids = [...new Set([...text.matchAll(/^In \[t:([^\]\s]+)\]:/gm)].map((m) => m[1]!))];
  return `watching threads: a look at ${ids.map((id) => `[t:${id}]`).join(", ") || "its threads"}; what was said is in those threads.`;
}

export type ChildStatus = "working" | "waiting" | "idle";

/** A project's thread, as the project chat sees it: waiting covers an approval and a question for the person (`needsYou`). */
export type ThreadState = "working" | "waiting" | "queued" | "idle" | "resolved";

export interface ChildInfo { id: string; title?: string; status: ChildStatus; state?: ThreadState; needsYou?: boolean; updatedAt: string; steps?: ThreadStep[] }

/** One step of a thread's checklist (`threads steps`), which the person follows on its card: done, under way, or not started. */
export interface ThreadStep { text: string; state: "done" | "doing" | "todo" }

/** A checklist's length, and the characters a step keeps. */
export const STEPS_LIMITS = { steps: 12, chars: 80 };

/** Her guidance on the checklist. */
export const STEPS_GUIDELINE = "On work of several steps that runs a while, keep this thread's checklist, which the person follows on its card instead of reading the thread: threads({ action: \"steps\", steps }), each step short, with its state (todo, doing or done). Set it when you start, update it as each step starts or finishes, and leave every step at its real end state when the work ends. Not for a quick answer.";

/** A checklist as `threads` takes it: steps trimmed and cut to `STEPS_LIMITS.chars`, empty ones dropped. Refuses one that is too long. */
export function cleanSteps(steps: ThreadStep[]): ThreadStep[] {
  const clean = steps.map((s) => ({ text: s.text.trim().replace(/\s+/g, " "), state: s.state })).filter((s) => s.text);
  if (clean.length > STEPS_LIMITS.steps) throw new Error(`a checklist has at most ${STEPS_LIMITS.steps} steps; merge some`);
  return clean.map((s) => ({ ...s, text: s.text.length > STEPS_LIMITS.chars ? `${s.text.slice(0, STEPS_LIMITS.chars - 1)}…` : s.text }));
}

/** Where a checklist stands, in a few words: the step under way, else the next one, with the count done. */
const stepsNote = (steps: ThreadStep[]) => {
  const done = steps.filter((s) => s.state === "done").length;
  const now = steps.find((s) => s.state === "doing") ?? steps.find((s) => s.state === "todo");
  return `${done} of ${steps.length} steps done${now ? `, ${now.state === "doing" ? "now" : "next"}: ${JSON.stringify(now.text)}` : ""}`;
};

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
  "You're told when a child thread stops with an error or finishes without a report. Read its latest messages with threads read; stop one that went wrong with threads stop.",
];

/** Her guidance in a project chat: she coordinates, and the work happens in threads. Guidance, never a boundary. */
export const PROJECT_CHAT_GUIDELINES = [
  "This is a project chat: you coordinate the project here, and the work happens in its threads.",
  "Answer a quick question here yourself. Start one thread per task (threads start), even when one message holds several; mention each.",
  "A follow-up about work a thread is already on goes to that thread (threads message); say which thread you sent it to.",
  "You're told when a thread stops with an error or finishes without a report. Read a thread's latest messages with threads read; stop one that went wrong with threads stop.",
  "When the person asks you to propose first, suggest threads (threads suggest) instead of starting them.",
  "When setting up from recent work supplied in this turn, draft Goal and Instructions with threads draft for the person to edit in Project settings; never apply them yourself. Suggest existing threads to bring in with threads fold and their ids; the person applies the Fold in card.",
  "When the person says how they want the project run (how many threads at once, who to ask, what to avoid), save it as a note with remember.",
  "A message starting [Watching threads] isn't from the person: it is a look at the project's threads, saying which threads it was about and why, "
    + "which threads it told what (they have those lines already), and maybe a line it raised for the person. "
    + "When it raises something, tell the person in a line or two what they must know or decide; never repeat their words back to them.",
];

/** Her guidance in a project's thread. */
export const PROJECT_THREAD_GUIDELINES = [
  "Post an update to the project chat (threads message to: \"parent\") at milestones, not after every step. Always end with a message to the parent: the result, or what blocked you.",
  "Use question: true in a message to the parent when you need an answer; plain progress updates do not wake it.",
  "Set needsYou only when the person must decide something before you can go on.",
  "Save lasting decisions about the project with remember.",
  "When the work is delivered, resolve this thread (threads resolve).",
  "You may message another thread of this project (threads message with its id) when its work affects yours, and read its latest messages (threads read).",
];

/** Her guidance on wake-ups, in every thread with the threads tool. */
export const WAKEUP_GUIDELINE = "To come back to something later without waiting in this turn (CI to finish, a review to land), set a wake-up: threads later with minutes and a note to yourself. "
  + "At that time the note starts a turn here, marked [Wake-up, set …]. One wakes only this thread; at most 3 wait at once and wake-ups and routines together fire at most 24 times a day.";

/** Her guidance on recurring turns requested by the user. */
export const ROUTINE_GUIDELINE = "Use threads routine for what the user asked to happen regularly; a one-off later is a wake-up.";

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
  `[t:${r.id}] ${r.title ? JSON.stringify(r.title) : "(untitled)"}: ${r.state ?? r.status}${r.needsYou ? " (waiting on the person)" : ""}, last ${r.updatedAt}${r.steps?.length ? `; ${stepsNote(r.steps)}` : ""}`;

/**
 * The project section: the goal, the user's instructions, the project's
 * notes since the last sleep, in the project chat its threads, then the
 * project page. Empty outside a project.
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
    // Before the page, so a long page is what the section budget cuts, not today's notes.
    notes.length ? `Notes since the last sleep:\n${notes.map((n) => `- [${n.id}] ${n.text}`).join("\n")}` : undefined,
    threads && `Its threads:\n${threads}`,
    page && !page.archived && page.text.trim() && `<page id="${page.id}" title="${page.title}">\n${page.text}\n</page>`,
  ].filter(Boolean).join("\n\n");
}

/** Only lyricad writes a routine marker. */
export const ROUTINE = /^\[Routine, ([^\]\n]+)\]\n\n/;

/** Recent-work selection stays in one pool; local-only text needs a local-only project. */
export function recentWorkAllowed(thread: { project?: boolean; child?: boolean; subagent?: boolean; unlogged?: boolean }, localOnly: boolean, projectLocalOnly: boolean): boolean {
  return !thread.project && !thread.child && !thread.subagent && !thread.unlogged && (!localOnly || projectLocalOnly);
}

/** Bounded welcome context: at most ten selected threads, ten messages each, 16,000 characters total. */
export const WELCOME_LIMITS = { threads: 10, entries: 10, chars: 16_000 };
