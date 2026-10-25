import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  ASK_GUIDELINE, CHILD_WAKES, isQuestionCall, ROOT_LIMITS, ROOT_TOOL, rootStep, SUDOERS_HOW, normalizeThreadArguments, cleanAsk, CHILD_THREAD_GUIDELINES, cleanSteps, MENTION_GUIDELINE, pickThread, PROJECT_CHAT_GUIDELINES, PROJECT_THREAD_GUIDELINES, STEPS_GUIDELINE, STEPS_LIMITS, threadLine, describe, parseSchedule, ROUTINE_GUIDELINE, WAKEUP_GUIDELINE, WAKEUP_LIMITS, WATCH_GUIDELINE,
  type ChildInfo, type StartRequest, type ThreadsLimits,
} from "@lyrica/core";
import { askCompaction, COMPACT_GUIDELINES, type ContextMeter } from "./context.ts";
import { CODE_NUDGE } from "./code.ts";
import type { ThreadContext } from "./index.ts";
import { syncEntries } from "./record.ts";
import { formatEntry } from "./memory.ts";

// Child threads: streams of work Lyrica starts under the thread she's in. Each
// is a thread like any other, hosted by lyricad, which supplies `ThreadsHost`.
// The same tool compacts the thread she's in, with her own summary.

/**
 * What became of a message: it started the thread's turn, joined its running
 * turn, waits for a free slot, or was only saved (a woken parent past its
 * rounds); to a parent, it wakes the parent or is an update it reads later.
 */
export type Delivery = "started" | "running" | "queued" | "saved" | "wakes" | "update";

export interface ThreadsHost {
  readonly limits: ThreadsLimits;
  /** Child threads one message from this thread may start: more when its model runs in the cloud. */
  perRequest?(from: ThreadContext): number;
  code?(from: ThreadContext, on: boolean): void;
  /** Whether code mode is on in this thread now. */
  codeOn?(from: ThreadContext): boolean;
  /**
   * Switches this thread to a model the person named, from a turn that starts
   * by itself after this one; returns its label, `already` when it runs on it
   * now (nothing changes), or throws with the closest.
   */
  model?(from: ThreadContext, name: string): { label: string; already?: boolean; goesOn?: boolean };
  asked?(from: ThreadContext): Promise<void>;
  /**
   * A script she wrote on one of the thread's machines, for a root step's
   * card, and the account she logs in there as. Without it, there is no
   * run_as_root tool.
   */
  rootScript?(from: ThreadContext, machine: string, path: string): Promise<{ bytes: Buffer; account: string }>;
  questionsChanged?(userId: string, pool: ThreadContext["pool"], thread: string): void;
  /** Her `threads watch`: watch an open pull request on one of the thread's repositories for CI and reviews. Returns what she is told. */
  watch?(from: ThreadContext, repo: string, number: number): Promise<string>;
  /** Whether the thread has a repository whose pull requests can be watched (a GitHub, Forgejo or Gitea account's). */
  watchable?(from: ThreadContext): boolean;
  /** A child's checks still fail after the last round (checks.ts): its parent is told when the turn ends. */
  checksExhausted?(userId: string, pool: ThreadContext["pool"], thread: string, report: string): void;
  /** The thread waits for a plan's usage limit (`plan`, by name) to reset at `until`: a child's parent is told once, without a wake. */
  planWaiting?(userId: string, pool: ThreadContext["pool"], thread: string, plan: string, until: number): void;
  draft?(from: ThreadContext, change: { goal?: string; instructions?: string }): void;
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
  message(from: ThreadContext, to: string, text: string, opts?: { needsYou?: boolean; question?: boolean }): Promise<Delivery>;
  /** This thread's children; in a project's thread, the project's other threads. */
  list(parent: ThreadContext): ChildInfo[];
  /** Resolves a project's thread (`id`, or the calling thread itself), or reopens one. */
  resolve?(from: ThreadContext, id: string | undefined, resolved: boolean, force?: boolean): void | Promise<void>;
  /** Stops a child's running turn, as Pause does. False if it wasn't working. */
  stop?(from: ThreadContext, id: string): Promise<boolean>;
  /** A wake-up for this thread `minutes` from now (already clamped), with its note; refused past `WAKEUP_LIMITS`. */
  later?(from: ThreadContext, minutes: number, note: string): { dueAt: string };
  /** Drops this thread's pending wake-ups. Returns how many. */
  cancelLater?(from: ThreadContext): number;
  /** This thread's checklist changed: its views and its parent's card hear of it. */
  stepsChanged?(from: ThreadContext): void;
  /** Whether the person wants checklists; off, `steps` isn't offered. Read when the session opens. */
  checklistsOn?(from: ThreadContext): boolean;
  /** The person's time zone now, which routines' wall times are in. */
  zone?(from: ThreadContext): string;
}

/** Messages `threads read` returns by default, and at most. */
export const READ_DEFAULT = 10;
const MODEL_PARAM = "For model: the model the person named, in their words.";
const MODEL_ACTION = "model: switch this thread to a model the person asked for; a turn on it starts by itself when this one ends.";
/** The text the model action adds to the tool's definition, for tests that size a window around it. */
export const THREAD_MODEL_TEXT = [MODEL_PARAM, MODEL_ACTION, "model"];
export const READ_MAX = 30;

/** The longest message one thread sends another: words, not files (docs/workspace.md, "Handing files over"). */
export const MESSAGE_MAX = 8_000;
// A run this long of base64 (or base64url) characters, line breaks aside, is a file, not words.
const ENCODED = /[A-Za-z0-9+/=_-]{400,}/;

/** Refuses a message that carries a file, naming the route that works. */
export function checkWords(text: string, max = Infinity): void {
  const file = ENCODED.test(text.replace(/[\r\n]/g, ""));
  if (file || text.length > max) {
    throw new Error(`${file ? "That looks like an encoded file" : `That message is ${text.length.toLocaleString("en-US")} characters, over ${max.toLocaleString("en-US")}`}. Files don't travel by message: write it in your own folder, which your parent, child and project threads can read, and say its path.`);
  }
}

const Params = Type.Object({
  action: StringEnum(["code", "model", "ask", "start", "message", "list", "read", "stop", "later", "watch", "routine", "steps", "suggest", "fold", "draft", "resolve", "reopen", "compact"] as const),
  on: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String({ description: MODEL_PARAM })),
  done: Type.Optional(Type.String({ maxLength: 1200 })),
  goal: Type.Optional(Type.String({ maxLength: 2000 })),
  instructions: Type.Optional(Type.String({ maxLength: 2000 })),
  ids: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "For fold: existing thread IDs to suggest bringing into this project. The person applies the card." })),
  title: Type.Optional(Type.String({ description: "For start: the child thread's title." })),
  task: Type.Optional(Type.String({ description: "For start: what to work on, with everything it needs. It starts with your persona and memory, but none of this conversation." })),
  base: Type.Optional(Type.Boolean()),
  folders: Type.Optional(Type.Array(Type.String(), { description: "For start: only these of this thread's folders." })),
  readOnly: Type.Optional(Type.Boolean({ description: "For start: it may read the folders but not change them." })),
  internet: Type.Optional(Type.Literal(false, { description: "For start: false cuts it off from the internet." })),
  code: Type.Optional(Type.Boolean({ description: "For start: true starts it in code mode." })),
  id: Type.Optional(Type.String({ description: "For message, read, stop, resolve and reopen: the thread's ID ([t:…]) or current title." })),
  minutes: Type.Optional(Type.Number({ description: `For later: how many minutes from now to wake this thread, 1 to ${WAKEUP_LIMITS.maxMinutes}.` })),
  note: Type.Optional(Type.String({ description: "For later or routine add: the note to yourself the wake-up starts with: what to check and what to do then." })),
  routineAction: Type.Optional(StringEnum(["add", "list", "pause", "resume", "remove"] as const, { description: "For routine: what to do with this thread's routines." })),
  routineId: Type.Optional(Type.Integer({ minimum: 1, description: "For routine pause, resume or remove: the routine's numeric ID from routine list." })),
  schedule: Type.Optional(Type.Object({
    kind: Type.String({ description: "daily, weekdays, weekly, yearly or every." }),
    time: Type.Optional(Type.String({ description: "HH:MM in the person's time zone." })),
    day: Type.Optional(Type.Number({ description: "For weekly: 0 (Sunday) to 6 (Saturday)." })),
    date: Type.Optional(Type.String({ description: "For yearly: MM-DD." })),
    hours: Type.Optional(Type.Number({ description: "For every: a whole number from 1 to 168, counted from now." })),
  }, { description: "For routine add: the recurring schedule." })),
  newThread: Type.Optional(Type.Boolean({ description: "For routine add: open a fresh thread each time; false (default) runs here." })),
  cancel: Type.Optional(Type.Literal(true, { description: "For later: drop this thread's pending wake-ups instead." })),
  pr: Type.Optional(Type.String({ description: "For watch: the pull request, as owner/repo#number or its URL, on one of this thread's repositories." })),
  steps: Type.Optional(Type.Array(Type.Object({ text: Type.String(), state: StringEnum(["todo", "doing", "done"] as const) }),
    { description: `For steps: this thread's whole checklist, at most ${STEPS_LIMITS.steps} steps of a few words each; an empty list clears it.` })),
  last: Type.Optional(Type.Number({ description: `For read: how many of its latest messages, ${READ_DEFAULT} by default, at most ${READ_MAX}.` })),
  to: Type.Optional(Type.Literal("parent", { description: "For message from a child thread: to its parent." })),
  text: Type.Optional(Type.String({ description: "For message: what to say." })),
  question: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "For ask: the question; for message: true wakes the parent." })),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), consequence: Type.String() }), { description: "For ask: 2–4 unique labels and their consequences." })),
  recommended: Type.Optional(Type.Integer({ description: "For ask: the recommended option's index." })),
  context: Type.Optional(Type.String({ description: "For ask: brief context, if needed." })),
  needsYou: Type.Optional(Type.Boolean({ description: "For message to the parent: the person must decide something before you can go on." })),
  threads: Type.Optional(Type.Array(Type.Object({ title: Type.String(), task: Type.String() }), { description: "For suggest: the threads you propose, each with a title and its task." })),
  force: Type.Optional(Type.Literal(true)),
  summary: Type.Optional(Type.String({ description: "For compact: what the next stretch needs: what you're doing, decisions, open questions, paths and names." })),
});
type Params = Static<typeof Params>;
type Field = keyof typeof Params.properties;

/** The actions each field serves: a thread is sent only the fields of the actions it has. */
const FIELD_ACTIONS: Record<Exclude<Field, "action">, string[]> = {
  on: ["code"], done: ["code"], model: ["model"],
  goal: ["draft"], instructions: ["draft"], ids: ["fold"], threads: ["suggest"],
  title: ["start"], task: ["start", "code"], folders: ["start"], readOnly: ["start"], internet: ["start"], code: ["start"], base: ["start"],
  id: ["message", "read", "stop", "resolve", "reopen"], text: ["message"], to: ["message"], question: ["message", "ask"], options: ["ask"], recommended: ["ask"], context: ["ask"], needsYou: ["message"], last: ["read"],
  minutes: ["later"], cancel: ["later"], note: ["later", "routine"], pr: ["watch"],
  routineAction: ["routine"], routineId: ["routine"], schedule: ["routine"], newThread: ["routine"],
  steps: ["steps"], summary: ["compact"], force: ["resolve"],
};

/** Principle 8: the parameters for these actions only, so a thread's tool definition carries nothing it can't use. */
function paramsFor(actions: string[], drop: Field[]) {
  const keep = Object.entries(Params.properties).filter(([k]) => k !== "action" && !drop.includes(k as Field)
    && FIELD_ACTIONS[k as Exclude<Field, "action">].some((a) => actions.includes(a)));
  return Type.Object({ action: StringEnum(actions), ...Object.fromEntries(keep) });
}

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

/** What she is told became of a message, so she says no more than happened. */
function sentTo(id: string, d: Delivery): string {
  if (d === "running") return `Sent to [t:${id}]; it takes it into the turn it is running.`;
  if (d === "queued") return `Saved in [t:${id}]; as many threads as the limit allows are working, so it starts when one finishes.`;
  if (d === "saved") return `Saved in [t:${id}] without starting it: you've answered it several times since the person last wrote. It sees this when the person writes in it, or you message it from a turn of your own.`;
  return `Sent to [t:${id}]; it starts a turn.`;
}

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
  /** Whether `ref` names this child's parent, by its ID or its current title. */
  const pickParent = (ref: string) => pickThread(ref, [{ id: self.parent!, title: store.getThread(self.parent!)?.title }]) === self.parent;
  const steps = !!host?.stepsChanged && host.checklistsOn?.(thread) !== false;
  // Only a thread with a repository on a forge it can watch is offered watch (principle 8).
  const watching = !!host?.watch && !!host.watchable?.(thread);
  return (pi) => {
    let asked = false;
    let nudged = false;
    // She once coded a whole change with code mode off, guidance or not: the first edit says so, once a session.
    let codeNudged = false;
    pi.on("tool_result", (e) => {
      if (codeNudged || !host?.code || !host.codeOn || inProjectChat() || e.isError || (e.toolName !== "edit" && e.toolName !== "write")) return;
      if (host.codeOn(thread)) return;
      codeNudged = true;
      return { content: [...e.content, { type: "text" as const, text: CODE_NUDGE }] };
    });
    pi.on("agent_start", () => { asked = false; nudged = false; });
    pi.on("message_end", (e) => {
      if (e.message.role === "assistant" && e.message.content.some(c => c.type === "toolCall" && isQuestionCall(c.name, c.arguments))) asked = true;
    });
    pi.on("turn_end", (e) => {
      if (!host || (child && !projectThread()) || asked || nudged || store.openQuestion(thread.threadId)) return;
      if (e.message.role !== "assistant" || e.message.content.some(c => c.type === "toolCall")) return;
      const reply = e.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      if (!proseQuestion(reply)) return;
      nudged = true;
      pi.sendMessage({ customType: "lyrica-ask-nudge", content: ASK_NUDGE, display: false }, { deliverAs: "followUp", triggerTurn: true });
    });
    let started = 0;
    /** Messages this turn to each of the project's other threads, by thread. */
    const siblings = new Map<string, number>();
    pi.on("before_agent_start", (event) => {
      started = 0;
      siblings.clear();
      if (!child) return;
      const parent = store.getThread(self.parent ?? "");
      const o = event.systemPromptOptions;
      o.sections = {
        ...o.sections,
        thread: projectThread()
          ? `This is a thread of the project [t:${self.parent}]${parent?.title ? ` ("${parent.title}")` : ""}: one task of the project, with its own conversation. `
            + "The person may also write here; that conversation is yours and theirs, and the project chat isn't told."
          : `This is a child thread of [t:${self.parent}]${parent?.title ? ` ("${parent.title}")` : ""}: a stream of work of its own. `
            + "Post a short update to the parent with threads message to: \"parent\" at milestones, not after every step. Always end with a message to the parent: the result, or what blocked you. Use question: true when you need an answer; progress updates do not wake the parent. "
            + "The person you're talking with may also write here; that conversation is yours and theirs, and the parent isn't told.",
      };
    });

    // The schema says how to call each action; the description says what each is for, once.
    const description = () => [
      !host ? "" : projectThread()
        ? "Post an update to the project chat (message to: \"parent\"), message another thread of the project, list them, read one's latest messages, or resolve this thread when its work is delivered."
        : child
          ? "Send your parent thread a short update (message to: \"parent\")."
          : "Child threads: start one on a stream of work of its own, which works in the background and which the person can open and steer; message, list, read or stop one."
            + (inProjectChat() ? " In this project chat, also suggest threads (a card the person starts them from), fold in existing threads, draft Goal and Instructions for Project settings, and resolve or reopen one." : ""),
      host?.model ? MODEL_ACTION : "",
      host && (!child || projectThread()) ? "ask: one question on a card for the person." : "",
      host?.later ? "later: a wake-up that starts a turn here with your note." : "",
      watching ? "watch: a pull request's CI results and reviews wake this thread." : "",
      host ? "routine: this thread's routines, at most 10 including paused ones." : "",
      steps ? "steps: this thread's checklist, shown on its card." : "",
      meter ? "compact: when this turn ends, your summary replaces the older part of this conversation; recent messages stay." : "",
    ].filter(Boolean).join(" ");

    const actions = [
      ...(host?.code ? ["code"] : []), ...(host?.model ? ["model"] : []),
      ...(!host ? [] : projectThread() ? ["message", "list", "read", ...(host.resolve ? ["resolve"] : [])]
        : child ? ["message"]
        : ["start", "message", "list", "read", ...(host.stop ? ["stop"] : []),
          ...(inProjectChat() ? ["suggest", "fold", ...(host.draft ? ["draft"] : []), ...(host.resolve ? ["resolve", "reopen"] : [])] : [])]),
      ...(host && (!child || projectThread()) ? ["ask"] : []),
      ...(host?.later ? ["later"] : []), ...(watching ? ["watch"] : []), ...(host ? ["routine"] : []), ...(steps ? ["steps"] : []), ...(meter ? ["compact"] : []),
    ];
    // to and question are a child's, needsYou a project thread's; a child outside a project messages only its parent.
    const drop: Field[] = [...(inProjectChat() ? [] : ["base"] as const), ...(child ? [] : ["to"] as const), ...(projectThread() ? [] : ["needsYou"] as const), ...(child && !projectThread() ? ["id"] as const : [])];

    pi.registerTool({
      name: "threads",
      label: "Threads",
      description: description(),
      promptSnippet: [host?.code ? "turn code mode on or off with code({ on, task, done })" : "", !host ? "" : child ? "post an update to the parent thread" : "start, message and list child threads", host?.later ? "set a wake-up for this thread" : "", host ? "manage this thread's routines" : "", steps ? "keep this thread's checklist" : "", meter ? "compact this thread with your own summary" : ""].filter(Boolean).join("; "),
      promptGuidelines: [
        ...(!host ? [] : projectThread() ? PROJECT_THREAD_GUIDELINES : child ? [] : inProjectChat() ? PROJECT_CHAT_GUIDELINES : CHILD_THREAD_GUIDELINES),
        ...(host && (!child || projectThread()) ? [ASK_GUIDELINE] : []),
        ...(host?.later ? [WAKEUP_GUIDELINE] : []), ...(watching ? [WATCH_GUIDELINE] : []), ...(host ? [ROUTINE_GUIDELINE] : []), ...(steps ? [STEPS_GUIDELINE] : []), ...(host || meter ? [MENTION_GUIDELINE] : []), ...(meter ? COMPACT_GUIDELINES : []),
      ],
      parameters: paramsFor(actions, drop),
      prepareArguments(input) {
        const a = input as { action?: string } | null;
        if (a?.action !== "ask" && a?.action !== "steps") return input as Params;
        const normalized = normalizeThreadArguments(input);
        if (a.action === "ask") cleanAsk(normalized);
        else cleanSteps(normalized.steps);
        return normalized as Params;
      },
      async execute(_id, p: Params, _signal, _update, ctx) {
        if (p.action === "compact") {
          if (!meter) throw new Error("this thread can't compact");
          const r = askCompaction(meter, String(p.summary ?? ""), ctx.model?.contextWindow ?? 0);
          return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
        }
        if (!host) throw new Error("child threads aren't available here");
        if (p.action === "code") {
          if (!host.code) throw new Error("code mode is unavailable here");
          if (typeof p.on !== "boolean") throw new Error("code needs on: true or false");
          if ((p.task?.length ?? 0) > 300 || (p.done?.length ?? 0) > 1200) throw new Error("code task is at most 300 characters and done is at most 1200");
          host.code(thread, p.on);
          if (p.task !== undefined || p.done !== undefined) store.setCodeTask(thread.threadId, p.task ?? "", p.done ?? "");
          return text(`Code mode ${p.on ? "on" : "off"} from the next turn.`);
        }
        if (p.action === "model") {
          if (!host.model) throw new Error("switching models is unavailable here");
          if (!p.model) throw new Error("model needs the model's name");
          const m = host.model(thread, p.model);
          return text(m.already
            ? `This thread already runs on ${m.label}; nothing changed. Go on now.`
            : m.goesOn ? `This thread runs on ${m.label} from the next turn, which starts by itself when this one ends: end this turn now, and go on there.`
            : `This thread runs on ${m.label} from the person's next message. Tell them so.`);
        }
        if (p.action === "ask") {
          if (child && !projectThread()) throw new Error("a child asks its parent with message question: true");
          cleanAsk(p);
          syncEntries(ctx.sessionManager, store, thread.threadId);
          const n = store.questionCall(thread.threadId, _id);
          if (n === undefined) throw new Error("ask needs its stored tool call");
          store.askQuestion(thread.threadId, n);
          await host.asked?.(thread);
          return text("The question is on a card. Carry on with the recommended option if that step can be undone; otherwise end the turn. The answer arrives in a later turn.");
        }
        if (p.action === "routine") {
          try {
            if (p.routineAction === "list") {
              const rows = store.routines(thread.threadId);
              return text(rows.length ? rows.map((r) => `Routine ${r.id}: ${describe(r.schedule)}, ${r.paused ? "paused" : `next ${r.nextAt}`}, ${r.newThread ? "opens a new thread" : "runs here"}.`).join("\n") : "This thread has no routines.");
            }
            if (p.routineAction === "add") {
              if (!p.note?.trim()) throw new Error("routine add needs a note to yourself");
              const at = new Date().toISOString();
              const schedule = parseSchedule(p.schedule?.kind === "every" ? { ...p.schedule, from: at } : p.schedule);
              if (store.routines(thread.threadId).length >= 10) throw new Error("this thread has at most 10 routines, including paused ones; remove one first");
              const id = store.addRoutine(thread.threadId, schedule, p.note.trim(), !!p.newThread, at, host.zone?.(thread));
              return text(`Added routine ${id}: ${describe(schedule)}, ${p.newThread ? "opens a new thread" : "runs here"}.`);
            }
            if (!["pause", "resume", "remove"].includes(p.routineAction ?? "")) throw new Error("routine needs add, list, pause, resume or remove");
            if (!Number.isSafeInteger(p.routineId) || p.routineId! < 1) throw new Error("routine needs its numeric ID from routine list");
            const changed = p.routineAction === "remove"
              ? store.removeRoutine(thread.threadId, p.routineId!)
              : store.pauseRoutine(thread.threadId, p.routineId!, p.routineAction === "pause", undefined, host.zone?.(thread));
            if (!changed) throw new Error("this thread has no routine with that ID");
            return text(`${p.routineAction === "remove" ? "Removed" : p.routineAction === "pause" ? "Paused" : "Resumed"} routine ${p.routineId}.`);
          } catch (err) {
            return { ...text(err instanceof Error ? err.message : "The routine could not be changed."), isError: true };
          }
        }
        if (p.action === "steps") {
          if (!steps || !host.stepsChanged) throw new Error("checklists are off here");
          const list = cleanSteps(p.steps ?? []);
          store.setSteps(thread.threadId, list);
          host.stepsChanged(thread);
          const done = list.filter((s) => s.state === "done").length;
          return text(list.length ? `Checklist set: ${done} of ${list.length} steps done.` : "Checklist cleared.");
        }
        if (p.action === "later") {
          if (!host.later || !host.cancelLater) throw new Error("wake-ups aren't available here");
          if (p.cancel) {
            const n = host.cancelLater(thread);
            return text(n ? `Dropped ${n === 1 ? "this thread's wake-up" : `${n} wake-ups`}.` : "This thread has no wake-up waiting.");
          }
          if (!p.note?.trim()) throw new Error("later needs a note to yourself");
          const asked = Math.round(p.minutes ?? 0);
          const minutes = Math.min(WAKEUP_LIMITS.maxMinutes, Math.max(1, asked));
          const { dueAt } = host.later(thread, minutes, p.note.trim());
          return text(`This thread wakes at ${dueAt.slice(0, 16)}Z (in ${minutes} minute${minutes === 1 ? "" : "s"}${minutes !== asked ? `; ${asked} is out of range` : ""}), with your note.`);
        }
        if (p.action === "watch") {
          if (!watching || !host.watch) throw new Error("watching pull requests isn't available here");
          const m = /([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#|\/pulls?\/)(\d+)\s*$/.exec(p.pr?.trim() ?? "");
          if (!m) throw new Error("watch needs pr as owner/repo#number, or the pull request's URL");
          return text(await host.watch(thread, m[1]!, Number(m[2])));
        }
        const inProject = projectThread();
        if (p.action === "message") {
          // A boolean written as a word (a tool format that makes every value text) is that boolean; any other text is the question, asked.
          if (typeof p.question === "string" && /^\s*(true|false|yes|no)\s*$/i.test(p.question)) p.question = /^\s*(true|yes)\s*$/i.test(p.question);
          if (typeof p.question === "string") { p.text = [p.text?.trim(), p.question.trim()].filter(Boolean).join("\n\n"); p.question = !!p.question.trim(); }
          if (p.question !== undefined && typeof p.question !== "boolean") throw new Error("message question must be true or false");
          if (!p.text?.trim()) throw new Error("message needs text");
          checkWords(p.text, MESSAGE_MAX);
          // A child's message with no recipient, or naming its parent, goes to the parent.
          if (child && p.to === undefined && (!p.id || (self.parent && pickParent(p.id)))) p.to = "parent";
          if (child && p.to === "parent") {
            if (p.needsYou && !inProject) throw new Error("needsYou is for a project's thread");
            const d = await host.message(thread, "parent", p.text, { needsYou: !!p.needsYou, question: !!p.question });
            return text(p.needsYou ? "Sent to the project chat; it shows you're waiting on the person." : d === "wakes" ? "Sent to the parent thread; it wakes to answer."
              : "Sent to the parent thread as an update: it reads it on its next turn, or when you end your turn. To get an answer before you go on, send it with question: true.");
          }
          if (child && !inProject) throw new Error("a child thread messages only its parent: to: \"parent\"");
          if (!p.id) throw new Error("message needs the thread's id or title");
          const id = pickThread(p.id, host.list(thread));
          if (inProject) {
            // Per thread, so a turn can tell several threads the same news; counted before sending, so calls made at once can't all slip under it.
            const max = host.limits.siblingMessages;
            const sent = siblings.get(id) ?? 0;
            if (sent >= max) throw new Error(`This turn has sent [t:${id}] its ${max} messages, so this one wasn't sent. Put what's left in one message next turn, or send it to the project chat (to: "parent").`);
            siblings.set(id, sent + 1);
            let d: Delivery;
            try { d = await host.message(thread, id, p.text); } catch (err) { siblings.set(id, siblings.get(id)! - 1); throw err; }
            const left = max - siblings.get(id)!;
            return text(`${sentTo(id, d)} (${left} more to [t:${id}] this turn.)`, { threads: [id] });
          }
          return text(sentTo(id, await host.message(thread, id, p.text)), { threads: [id] });
        }
        if (p.action === "list") {
          if (child && !inProject) throw new Error("a child thread can't list child threads; it can delegate, and message its parent");
          const rows = host.list(thread);
          return text(rows.length ? rows.map(threadLine).join("\n") : inProject ? "The project has no other threads." : "This thread has no child threads.",
            { threads: rows.map((r) => r.id) });
        }
        if (p.action === "read") {
          if (!p.id) throw new Error("read needs the thread's id or title");
          // Her own subagents' threads read like any other: delegate wait gives a run's result too.
          const sub = store.getThread(pickThread(p.id, []));
          const own = sub?.subagent && sub.parent === thread.threadId;
          if (child && !inProject && !own) throw new Error("a child thread can't read other threads");
          const rows = own ? [{ id: sub!.id }] : host.list(thread);
          const id = pickThread(p.id, rows);
          if (inProject && id === self.parent) throw new Error(`[t:${id}] is your project chat: it can't be read from here, but you can message it with to: "parent"`);
          if (!rows.some((r) => r.id === id)) {
            const other = store.getThread(id);
            throw new Error(`[t:${id}] isn't ${inProject ? "another thread of this project" : "a child thread of this one"}${other?.subagent ? "; for a subagent's result, use delegate with action wait and its run ID" : ""}`);
          }
          if (store.getThread(id)?.unlogged) throw new Error(`[t:${id}] isn't logged, so it can't be read from here`);
          const last = Math.min(READ_MAX, Math.max(1, Math.round(p.last ?? READ_DEFAULT)));
          // Read as from another thread, so entries written unlogged are left out; so are tool results and empty tool calls.
          const entries = store.latestEntries(id, last);
          const read = entries.length ? entries.map(formatEntry).join("\n\n") : `[t:${id}] has no messages to read.`;
          // Its parent is woken when it ends: say so, so she ends her turn rather than sleeping to read again.
          const working = !child && !own && rows.find((r) => r.id === id && "status" in r && r.status === "working");
          return text(working ? `${read}\n\n[t:${id}] is still working. ${CHILD_WAKES}` : read, { threads: [id] });
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
          await host.resolve(thread, id, resolved, p.force === true);
          return text(`${resolved ? "Resolved" : "Reopened"} ${id ? `[t:${id}]` : "this thread"}.`, id ? { threads: [id] } : undefined);
        }
        if (child) throw new Error("a child thread can't start child threads; it can delegate, and message its parent");
        if (p.action === "fold") {
          if (!inProjectChat()) throw new Error("fold is for a project chat");
          if (!p.ids?.length) throw new Error("fold needs thread ids");
          return text(`Suggested folding in ${p.ids.length} threads; the person applies the card.`, { threads: p.ids });
        }
        if (p.action === "draft") {
          if (!inProjectChat() || !host.draft) throw new Error("draft is for a project chat");
          if (p.goal === undefined && p.instructions === undefined) throw new Error("draft needs Goal or Instructions");
          host.draft(thread, { goal: p.goal, instructions: p.instructions });
          return text("Draft saved for editing in Project settings; nothing applied.");
        }
        if (p.action === "suggest") {
          if (!inProjectChat()) throw new Error("suggest is for a project chat");
          const list = (p.threads ?? []).map((t) => ({ title: t.title.trim(), task: t.task.trim() })).filter((t) => t.title && t.task);
          if (!list.length) throw new Error("suggest needs threads, each with a title and a task");
          return text(`Suggested ${list.length === 1 ? "a thread" : `${list.length} threads`}; the person starts them from the card.`, { suggested: list.length });
        }
        if (!p.title?.trim() || !p.task?.trim()) throw new Error("start needs a title and a task");
        checkWords(p.task);
        // Counted before starting, so calls made at once can't all slip under the limit.
        const most = host.perRequest?.(thread) ?? host.limits.perRequest;
        if (started >= most) throw new Error(`one message can start at most ${most} child threads`);
        started++;
        let made: { id: string; link: string; queued?: boolean };
        try {
          made = await host.start(thread, { title: p.title.trim(), task: p.task, folders: p.folders, readOnly: p.readOnly, internet: p.internet, code: p.code, base: p.base });
        } catch (err) {
          started--;
          throw err;
        }
        return text(made.queued
          ? `Queued [t:${made.id}]: it starts when another thread finishes.`
          : `Started child thread [t:${made.id}], working in the background.`, { threads: [made.id] });
      },
    });

    // A root step: never in an ordinary child thread, which asks its parent instead.
    if (host?.rootScript && (!child || projectThread())) {
      const read = host.rootScript.bind(host);
      pi.registerTool({
        name: ROOT_TOOL,
        label: "Run as root",
        description: `Ask the person, on a card, to run as root a script you wrote with write on one of your machines; the answer comes in a later turn. Optionally offer sudoers lines for a root command needed again (one command, full path, fixed arguments).`,
        promptSnippet: "hand a root step on a machine to the person, on a card",
        parameters: Type.Object({
          machine: Type.String({ description: "One of your machines, by name." }),
          path: Type.String({ description: "The script's absolute path there." }),
          why: Type.String({ description: `What it does and why it needs root (at most ${ROOT_LIMITS.why} characters).` }),
          sudoers: Type.Optional(Type.Array(Type.String(), { description: "Each \"<account> ALL=(root) NOPASSWD: /usr/bin/program args\"." })),
        }),
        async execute(id, p: { machine: string; path: string; why: string; sudoers?: string[] }, _signal, _update, ctx) {
          const { bytes, account } = await read(thread, p.machine, p.path);
          const step = rootStep(p, bytes, account);
          syncEntries(ctx.sessionManager, store, thread.threadId);
          const n = store.questionCall(thread.threadId, id);
          if (n === undefined) throw new Error("run_as_root needs its stored tool call");
          store.askQuestion(thread.threadId, n);
          await host.asked?.(thread);
          return {
            content: [{ type: "text" as const, text: `The root step is on a card, with the hash ${step.sha256}: \`${step.command}\`${step.sudoers ? `, and ${step.sudoers.length} sudoers line(s) to add with ${SUDOERS_HOW}` : ""}. Carry on with what doesn't depend on it, or end the turn; the answer arrives in a later turn, and then check that it worked.` }],
            details: { root: step },
          };
        },
      });
    }
  };
}

export const ASK_NUDGE = "Your reply ends with a question offering options. If the person must choose before you can go on, put it on a card with threads ask, and don't repeat it in prose; otherwise carry on.";

/** Only the final question paragraph and its adjacent list count. */
export function proseQuestion(text: string): boolean {
  const lines = text.trim().split(/\r?\n/);
  const item = (s: string) => /^\s*(?:[-*]|\d+[.)]|[A-Z]\))\s+\S/.test(s);
  let end = lines.length - 1;
  if (item(lines[end]!)) {
    let count = 0;
    while (end >= 0 && (item(lines[end]!) || !lines[end]!.trim())) { if (item(lines[end]!)) count++; end--; }
    if (count < 2 || count > 4 || end < 0) return false;
    const paragraph: string[] = [];
    while (end >= 0 && lines[end]!.trim()) paragraph.unshift(lines[end--]!);
    return paragraph.join(" ").trim().endsWith("?") && !paragraph.some(item);
  }
  // A closing question paragraph must immediately follow the list.
  const paragraph: string[] = [];
  while (end >= 0 && lines[end]!.trim() && !item(lines[end]!)) paragraph.unshift(lines[end--]!);
  if (!paragraph.join(" ").trim().endsWith("?")) return false;
  while (end >= 0 && !lines[end]!.trim()) end--;
  let count = 0;
  while (end >= 0 && item(lines[end]!)) { count++; end--; }
  return count >= 2 && count <= 4;
}
