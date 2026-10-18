import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THREADS_LIMITS, PRONOUN_PRESETS, type Persona, type Profile } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLyricaExtension, createThreadsExtension, ASK_NUDGE, recordEntries, type ThreadContext } from "../src/index.ts";
import { withMemory } from "./helpers.ts";

// Runs the extension inside a real Pi session against pi-ai's fake model, and
// records what the model receives on each turn.

const persona: Persona = {
  core: [{ path: "SOUL.md", text: "She is Lyrica." }],
  topics: [{ id: "music", summary: "", triggers: ["song"], priority: 2, text: "Music is structured feeling." }],
};
const profile: Profile = { displayName: "Ada", pronouns: PRONOUN_PRESETS.she, previousNames: [] };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Step = (ctx: { messages: unknown[] }) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;

/** A Pi session for the thread, run by pi-ai's fake model, with its entries recorded in the pool. */
async function session(thread: ThreadContext, steps?: Step[], extra: ExtensionFactory[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-pi-"));
  dirs.push(dir);
  const seen: { system: string; turn: string }[] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  const record = (ctx: { messages: unknown[] }) => {
    const text = (m: unknown) => JSON.stringify(m);
    seen.push({
      system: ctx.messages.filter((m) => (m as { role: string }).role === "system").map(text).join("\n"),
      turn: ctx.messages.filter((m) => text(m).includes("<time>")).map(text).join("\n"),
    });
  };
  const reply: Step = (ctx) => { record(ctx); return fauxAssistantMessage("ok"); };
  faux.setResponses((steps ?? [reply, reply]).map((step) => (ctx: { messages: unknown[] }) => { if (steps) record(ctx); return step(ctx); }));

  let minute = 0;
  const lyrica = createLyricaExtension(thread, {
    persona: () => persona, profile: () => profile, now: () => new Date(Date.UTC(2026, 9, 9, 12, minute++)),
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), lyrica, ...extra],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir, undefined, thread.view.own.loadEntries(thread.threadId) as never),
    noTools: "builtin",
  });
  await session.bindExtensions({});
  await session.setModel(faux.getModel());
  recordEntries(session, thread.view.own, thread.threadId);
  return { session, seen };
}

describe("in a Pi session", () => {
  it("records the user entry before a hanging model answers, without duplicating it at turn end", async () => {
    const thread = (await withMemory()).thread().context;
    let finish!: (reply: ReturnType<typeof fauxAssistantMessage>) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const { session: s } = await session(thread, [() => new Promise((resolve) => {
      finish = resolve;
      started();
    })]);
    let ended = false;
    s.subscribe((e) => { if (e.type === "turn_end") ended = true; });
    const turn = s.prompt("keep this message");
    try {
      await called;
      expect(ended).toBe(false);
      const users = () => thread.view.own.loadEntries(thread.threadId).filter((e) =>
        (e as { message?: { role: string } }).message?.role === "user");
      const before = users();
      expect(before).toHaveLength(1);
      expect(thread.view.own.lastEntry(thread.threadId, ["user"])?.text).toBe("keep this message");
      finish(fauxAssistantMessage("Done."));
      await turn;
      expect(ended).toBe(true);
      expect(users()).toEqual(before);
    } finally {
      finish?.(fauxAssistantMessage("Done."));
      await turn;
      s.dispose();
    }
  });

  it("survives a failed early record and records the user entry at turn end", async () => {
    const thread = (await withMemory()).thread().context;
    const store = thread.view.own;
    const append = store.appendEntry.bind(store);
    let failed = 0;
    // The first write, the early one right after send, fails as a locked store would.
    store.appendEntry = ((...args: Parameters<typeof append>) => {
      if (failed++ === 0) throw new Error("store locked");
      return append(...args);
    }) as typeof store.appendEntry;
    const errors: string[] = [];
    const log = console.error;
    console.error = (line: string) => { errors.push(String(line)); };
    const { session: s } = await session(thread, [() => fauxAssistantMessage("Done.")]);
    try {
      await s.prompt("keep this anyway");
    } finally {
      console.error = log;
      s.dispose();
    }
    expect(errors.some((e) => e.includes("recording a sent message failed (Error)"))).toBe(true);
    expect(errors.join("\n")).not.toContain("keep this anyway");
    expect(store.loadEntries(thread.threadId).filter((e) => (e as { message?: { role: string } }).message?.role === "user")).toHaveLength(1);
  });

  it("keeps the system prompt identical across turns and sends the time as a message", async () => {
    const { session: s, seen } = await session((await withMemory()).thread().context);
    try {
      await s.prompt("sing me a song");
      await s.prompt("another song, please");
    } finally {
      s.dispose();
    }
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(first!.system).toContain("She is Lyrica.");
    expect(first!.system).toContain('<topic id=\\"music\\">');
    expect(first!.system).toContain("You are talking with Ada (pronouns: she/her).");
    expect(first!.system).not.toContain("<time>");
    expect(first!.system).not.toContain("expert coding assistant");
    expect(second!.system).toBe(first!.system);
    expect(first!.turn).toContain("12:00");
    expect(second!.turn).toContain("12:01");
  });

  it("keeps the tools' own prompt guidance", async () => {
    const { session: s, seen } = await session((await withMemory()).thread().context);
    try {
      await s.prompt("hello");
    } finally {
      s.dispose();
    }
    expect(seen[0]!.system).toContain("- recall: search memory beyond what came up automatically");
    expect(seen[0]!.system).toContain("Save notes liberally with remember");
    expect(seen[0]!.system).toContain("write {user} where");
  });

  it("brings back in a new session what she remembered in an earlier one", async () => {
    const m = await withMemory();
    const first = m.thread();
    const { session: s1 } = await session(first.context, [
      () => fauxAssistantMessage(fauxToolCall("remember", { notes: [{ text: "{user}'s cat Miso hates the vacuum cleaner", about: ["pets"] }] }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Noted."),
    ]);
    try {
      await s1.prompt("My cat Miso hates the vacuum cleaner.");
    } finally {
      s1.dispose();
    }
    const [hit] = first.view.own.search("Miso", { kinds: ["note"] });
    const note = first.view.own.get(hit!.id)!;
    // The note cites the message it came from.
    const said = first.view.own.lastEntry(first.threadId, ["user"])!;
    expect(said.text).toBe("My cat Miso hates the vacuum cleaner.");
    expect(note.text).toBe(`Ada's cat Miso hates the vacuum cleaner [${said.id}]`);
    expect(first.view.own.loadEntries(first.threadId).length).toBeGreaterThanOrEqual(4);

    const second = m.thread();
    const { session: s2, seen } = await session(second.context, [(ctx) => { void ctx; return fauxAssistantMessage("Miso!"); }]);
    try {
      await s2.prompt("Should I vacuum today? Miso is around.");
    } finally {
      s2.dispose();
    }
    expect(seen[0]!.turn).toContain(`[${hit!.id}] (note) Ada's cat Miso hates the vacuum cleaner`);
    expect(second.view.own.loadEntries(second.threadId).length).toBeGreaterThanOrEqual(2);
  });
});


describe("question and checklist recovery", () => {
  const host = { limits: DEFAULT_THREADS_LIMITS, start: async () => ({ id: "unused", link: "unused" }), message: async () => "started" as const, list: () => [], stepsChanged: () => {} };
  it("rebuilds a card from stringified options and corrects a bad state in the same turn", async () => {
    const t = (await withMemory()).thread().context;
    const options = [{ label: "Keep", consequence: "Keeps it." }, { label: "Remove", consequence: "Removes it." }];
    const { session: s } = await session(t, [
      () => fauxAssistantMessage([fauxToolCall("threads", { action: "ask", question: "Which?", options: JSON.stringify(options), recommended: "keep" })]),
      () => fauxAssistantMessage([fauxToolCall("threads", { action: "steps", steps: [{ text: "Check", state: "invalid-secret" }] })]),
      ctx => { const text = JSON.stringify(ctx.messages); expect(text).toContain("steps[0].state"); expect(text).toContain("todo, doing, done"); return fauxAssistantMessage([fauxToolCall("threads", { action: "steps", steps: [{ text: "Check", state: "doing" }] })]); },
      () => fauxAssistantMessage("Which route?\n- Keep\n- Remove"),
    ], [createThreadsExtension(t, host)]);
    try {
      await s.prompt("Prepare the work.");
      const q = t.view.own.openQuestion(t.threadId)!;
      expect(t.view.own.readAsk(t.threadId, q.n)).toMatchObject({ options, recommended: 0 });
      expect(t.view.own.steps(t.threadId)).toEqual([{ text: "Check", state: "doing" }]);
      expect(t.view.own.loadEntries(t.threadId).some((e: any) => e.customType === "lyrica-ask-nudge")).toBe(false);
    } finally { s.dispose(); }
  });

  for (const reply of ["Which route?\n\n- Keep\n- Remove", "- Keep\n- Remove\n\nWhich route?"]) {
    it(`sends one hidden follow-up for ${JSON.stringify(reply)} and drops it next turn`, async () => {
      const t = (await withMemory()).thread().context;
      const { session: s } = await session(t, [
        () => fauxAssistantMessage(reply),
        ctx => { expect(JSON.stringify(ctx.messages)).toContain(ASK_NUDGE); return fauxAssistantMessage(reply); },
        ctx => { expect(JSON.stringify(ctx.messages)).not.toContain(ASK_NUDGE); return fauxAssistantMessage("Done."); },
      ], [createThreadsExtension(t, host)]);
      try {
        await s.prompt("Choose a route.");
        const nudges = () => t.view.own.loadEntries(t.threadId).filter((e: any) => e.customType === "lyrica-ask-nudge");
        expect(nudges()).toHaveLength(1);
        expect(nudges()[0]).toMatchObject({ display: false });
        await s.prompt("Keep it.");
        expect(nudges()).toHaveLength(1);
      } finally { s.dispose(); }
    });
  }
  for (const reply of ["Any thoughts?", "- One\n- Two\n\nThe report is ready.\n\nHow was your day?"]) {
    it("does not nudge an ordinary reply", async () => {
      const t = (await withMemory()).thread().context;
      const { session: s } = await session(t, [() => fauxAssistantMessage(reply)], [createThreadsExtension(t, host)]);
      try {
        await s.prompt("Tell me about it.");
        expect(t.view.own.loadEntries(t.threadId).some((e: any) => e.customType === "lyrica-ask-nudge")).toBe(false);
      } finally { s.dispose(); }
    });
  }

});
