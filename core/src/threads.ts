// Child threads and projects: the shapes lyricad and the threads tool share,
// and her guidance about them. Pure, so it lives here rather than in the
// extension (principle 8's budget).
import type { PoolView } from "./store/memory.ts";

/** What a parent's message to its child starts with, so the child's thread can show it as hers. Only lyricad writes it. */
export const fromParent = (parentThreadId: string) => `[From t:${parentThreadId}]\n\n`;
export const FROM_PARENT = /^\[From t:([^\]\s]+)\]\n\n/;
/** Only lyricad writes an answer mark; the label remains a user's message. */
export const ANSWER = /^\[Answer to q:/;
export const answerMark = (n: number) => `[Answer to q:${n}]\n\n`;
export interface Ask { question: string; options: { label: string; consequence: string }[]; recommended: number; context?: string }
export const ASK_LIMITS = { question: 300, context: 1200, minOptions: 2, maxOptions: 4, label: 40, consequence: 200 };
/** Only unambiguous repairs, shared by Pi preparation and encrypted-log readers. */
export function normalizeThreadArguments(input: unknown): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const a = { ...input } as Record<string, any>;
  for (const field of ["options", "steps"]) {
    if (typeof a[field] === "string") {
      try { const parsed = JSON.parse(a[field]); if (Array.isArray(parsed)) a[field] = parsed; } catch { /* Validation explains the shape. */ }
    }
  }
  if (Array.isArray(a.steps)) a.steps = a.steps.map((s: any) => {
    if (typeof s === "string") return { text: s, state: "todo" };
    if (!s || typeof s !== "object") return s;
    const aliases: Record<string, string> = { in_progress: "doing", "in progress": "doing", active: "doing", started: "doing", pending: "todo", "not started": "todo", complete: "done", completed: "done", finished: "done" };
    return { ...s, state: typeof s.state === "string" ? aliases[s.state.toLowerCase()] ?? s.state : s.state };
  });
  if (typeof a.recommended === "string" && Array.isArray(a.options)) {
    const matches = a.options.flatMap((o: any, i: number) => typeof o?.label === "string" && o.label.toLowerCase() === a.recommended.toLowerCase() ? [i] : []);
    if (matches.length === 1) a.recommended = matches[0];
  }
  return a;
}
const received = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
function invalid(action: "ask" | "steps", field: string, value: unknown, allowed: string): never {
  const example = action === "ask"
    ? 'threads({ action: "ask", question, options: [{ label, consequence }, …], recommended: 0 })'
    : 'threads({ action: "steps", steps: [{ text, state: "todo" }] })';
  throw new Error(`${field} received ${received(value)}; ${allowed}. Example: ${example}`);
}
/** Structural validation, shared by the tool and encrypted-log readers. */
export function cleanAsk(input: unknown): Ask {
  const a = normalizeThreadArguments(input);
  const str = (v: unknown, max: number, field: string): string => {
    if (typeof v !== "string" || !v.trim() || v.trim().length > max) invalid("ask", field, v, `must have 1 to ${max} characters`);
    return (v as string).trim();
  };
  const question = str(a?.question, ASK_LIMITS.question, "question");
  if (!Array.isArray(a?.options) || a.options.length < 2 || a.options.length > 4) invalid("ask", "options", a?.options, "must be an array of 2 to 4 options");
  const options = a.options.map((o: any, i: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) invalid("ask", `options[${i}]`, o, "each option is { label, consequence }");
    return { label: str(o.label, ASK_LIMITS.label, `options[${i}].label`), consequence: str(o.consequence, ASK_LIMITS.consequence, `options[${i}].consequence`) };
  });
  options.forEach((o: Ask["options"][number], i: number) => {
    if (options.some((other: Ask["options"][number], j: number) => j < i && other.label.toLowerCase() === o.label.toLowerCase())) invalid("ask", `options[${i}].label`, o.label, "option labels must be unique ignoring case");
  });
  if (!Number.isInteger(a.recommended) || a.recommended < 0 || a.recommended >= options.length) invalid("ask", "recommended", a.recommended, `must be an option index from 0 to ${options.length - 1}`);
  if (a.context !== undefined && (typeof a.context !== "string" || a.context.trim().length > ASK_LIMITS.context)) invalid("ask", "context", a.context, "must be a string of at most 1200 characters");
  return { question, options, recommended: a.recommended, ...(a.context !== undefined ? { context: a.context.trim() } : {}) };
}
/** The tool whose card asks the person to run a script as root (docs/workspace.md, "Root steps"). */
export const ROOT_TOOL = "run_as_root";

/** The question a root step asks, for Notifications, the project card and her stored answer: from the call's arguments. */
export function rootAsk(args: unknown): Ask | undefined {
  const a = args as { machine?: unknown; why?: unknown } | null;
  if (typeof a?.machine !== "string" || !a.machine || typeof a.why !== "string") return undefined;
  return {
    question: `Run as root on ${a.machine}?`.slice(0, 300),
    context: a.why.trim().slice(0, 1200),
    options: [
      { label: "Done", consequence: "You ran it. She checks the result and carries on." },
      { label: "Not now", consequence: "Nothing runs. She says what waits on it." },
    ],
    recommended: 0,
  };
}

/** Whether a stored tool call is a question card: `threads` ask, or a root step. */
export const isQuestionCall = (name: unknown, args: unknown): boolean =>
  (name === "threads" && (args as { action?: unknown } | null)?.action === "ask") || name === ROOT_TOOL;

/** A question card's question, from its stored call; undefined if it doesn't hold one. */
export function askOfCall(name: unknown, args: unknown): Ask | undefined {
  if (name === ROOT_TOOL) return rootAsk(args);
  try { return cleanAsk(args); } catch { return undefined; }
}
export const ASK_GUIDELINE = "Ask on a card (threads ask) only for a fork that changes the person's goal, an output they will notice, or a step no one can undo. Ask once, without repeating it in prose. Put the recommended option first. Keep working on it where the step can be undone; otherwise end the turn. The answer arrives in a later turn.";

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
export type ThreadState = "working" | "waiting" | "queued" | "held" | "idle" | "resolved";

export interface ChildInfo { id: string; title?: string; status: ChildStatus; state?: ThreadState; needsYou?: boolean; updatedAt: string; steps?: ThreadStep[] }

/** One step of a thread's checklist (`threads steps`), which the person follows on its card: done, under way, or not started. */
export interface ThreadStep { text: string; state: "done" | "doing" | "todo" }

/** A checklist's length, and the characters a step keeps. */
export const STEPS_LIMITS = { steps: 12, chars: 80 };

/** Her guidance on the checklist. */
export const STEPS_GUIDELINE = "On work of several steps that runs a while, keep this thread's checklist, which the person follows on its card instead of reading the thread: threads({ action: \"steps\", steps }), each step short, with its state (todo, doing or done). Set it when you start, update it as each step starts or finishes, and leave every step at its real end state when the work ends. Not for a quick answer.";

/** A checklist as `threads` takes it: steps trimmed and cut to `STEPS_LIMITS.chars`, empty ones dropped. Refuses one that is too long. */
export function cleanSteps(input: unknown): ThreadStep[] {
  const steps = normalizeThreadArguments({ steps: input }).steps;
  if (!Array.isArray(steps)) invalid("steps", "steps", steps, "must be an array of { text, state }");
  const clean: ThreadStep[] = steps.map((s: any, i: number) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) invalid("steps", `steps[${i}]`, s, "each step is { text, state }");
    if (typeof s.text !== "string") invalid("steps", `steps[${i}].text`, s.text, "must be a string");
    if (!["todo", "doing", "done"].includes(s.state)) invalid("steps", `steps[${i}].state`, s.state, "must be one of todo, doing, done");
    return { text: s.text.trim().replace(/\s+/g, " "), state: s.state };
  }).filter((s: ThreadStep) => s.text);
  if (clean.length > STEPS_LIMITS.steps) invalid("steps", "steps", steps, `a checklist has at most ${STEPS_LIMITS.steps} steps; merge some`);
  return clean.map((s) => ({ ...s, text: s.text.length > STEPS_LIMITS.chars ? `${s.text.slice(0, STEPS_LIMITS.chars - 1)}…` : s.text }));
}

/** Where a checklist stands, in a few words: the step under way, else the next one, with the count done. */
const stepsNote = (steps: ThreadStep[]) => {
  const done = steps.filter((s) => s.state === "done").length;
  const now = steps.find((s) => s.state === "doing") ?? steps.find((s) => s.state === "todo");
  return `${done} of ${steps.length} steps done${now ? `, ${now.state === "doing" ? "now" : "next"}: ${JSON.stringify(now.text)}` : ""}`;
};

export interface StartRequest { title: string; task: string; folders?: string[]; readOnly?: boolean; internet?: false; code?: boolean; base?: boolean }

export interface Suggestion { title: string; task: string }

export interface ThreadsLimits {
  /** Child threads one message to the parent may start. */
  perRequest: number;
  /** The same for a thread whose model runs in the cloud, which uses no local GPU. */
  cloudPerRequest: number;
  /**
   * Child threads working at once, per user: a ceiling only, since each model
   * already takes as many requests at once as it can serve (models.md).
   */
  concurrency: number;
  /** Messages one turn of a project's thread may send to the project's other threads. */
  siblingMessages: number;
}

export const DEFAULT_THREADS_LIMITS: ThreadsLimits = { perRequest: 3, cloudPerRequest: 6, concurrency: 32, siblingMessages: 3 };

/** Her guidance in a thread that can start child threads, outside a project. */
export const CHILD_THREAD_GUIDELINES = [
  "Use a subagent (delegate) when you need an answer to carry on and the task is bounded: searching, reading, reviewing, checking.",
  "Start a child thread (threads start) when the work is a stream of its own that outlasts this conversation, that the person may want to follow or steer, or that needs a long context of its own, such as \"I'll keep going on the homelab migration in its own thread.\" Say so, mentioning it.",
  "A child thread posts updates here as it goes. Message it with threads message; the person can also talk to it directly.",
  "You're told when a child thread stops with an error; when it ends without a report, you get its last message as its report. Read its latest messages with threads read; stop one that went wrong with threads stop.",
];

/** Her guidance in a project chat: she coordinates, and the work happens in threads. Guidance, never a boundary. */
export const PROJECT_CHAT_GUIDELINES = [
  "This is a project chat: you coordinate the project here, and the work happens in its threads. "
    + "Its folders and repositories are read-only to you here: read them and run checks, and start a thread for any change (not your scratch folder).",
  "Answer a quick question here yourself. Start one thread per task (threads start), even when one message holds several; mention each.",
  "A follow-up about work a thread is already on goes to that thread (threads message); say which thread you sent it to.",
  "A coding build with several parts (say physics and its tests, rendering, track and lap logic) splits even when the parts fit together: "
    + "first one code: true, base: true thread sets up the repository and the interfaces the parts share (stubs, conventions) and reports and resolves, then one code: true thread per part starts, together, each in its own worktree. "
    + "Each brief names the files that part owns, what is done and what it depends on. A small job (one feature or fix) keeps one thread. "
    + "When the parts report their branches, start one code: true, base: true merge thread. It merges each branch in turn, runs tests after each merge, and messages the owning thread about conflicts or red tests rather than fixing that thread's files. It deletes each branch after merging it. Only one base thread may be open; resolve the scaffold before starting the merge thread. A small job that works in the original checkout uses base: true too. When a thread's report names the check that tests the ask and what it showed, a light look is enough; check fully yourself only when that evidence is missing or doesn't match the ask.",
  "You're told when a thread stops with an error; when it ends without a report, you get its last message as its report. Read a thread's latest messages with threads read; stop one that went wrong with threads stop.",
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
  "Use threads ask when the person must decide something.",
  "Save lasting decisions about the project with remember.",
  "When the work is delivered, resolve this thread (threads resolve).",
  "You may message another thread of this project (threads message with its id) when its work affects yours, and read its latest messages (threads read).",
  "In a shared repository, change and commit only the files your brief gives you; ask the thread that owns another file for what you need.",
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
export function recentWorkAllowed(thread: { interface?: string; project?: boolean; child?: boolean; subagent?: boolean; unlogged?: boolean }, localOnly: boolean, projectLocalOnly: boolean): boolean {
  return thread.interface !== "sleep" && !thread.project && !thread.child && !thread.subagent && !thread.unlogged && (!localOnly || projectLocalOnly);
}

/** Bounded welcome context: at most ten selected threads, ten messages each, 16,000 characters total. */
export const WELCOME_LIMITS = { threads: 10, entries: 10, chars: 16_000 };
