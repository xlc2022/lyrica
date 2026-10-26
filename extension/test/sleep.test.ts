import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, PersonaProposals, PersonaStore, projectSlug, searchView, WATCHING_MARK, type Pool, type PoolView } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deadUrl, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import { profile, withModels } from "../../core/test/helpers.ts";
import { DREAM_HEADER, memorySections, Sleep, type SleepLimits } from "../src/index.ts";
import { asUserToken } from "../src/sleep.ts";

// Sleep against scripted fake model servers. Each phase is told apart by the
// tools it is offered; each step of a phase answers the next model call.

const SEED = fileURLToPath(new URL("../../persona", import.meta.url));
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Phase = "consolidate" | "dream" | "wake";
type Step = Reply | ((chat: ChatRequest) => Reply);
type Script = Partial<Record<Phase, Step[]>>;

const phaseOf = (c: ChatRequest): Phase | undefined => {
  const tools = (c.tools ?? []).map((t) => t.function.name);
  return tools.includes("write_page") ? "consolidate" : tools.includes("write_journal") ? "dream" : tools.includes("write_wake") ? "wake" : undefined;
};
const call = (name: string, args: unknown): Reply => ({ tools: [{ name, args }] });
const said = (c: ChatRequest) => JSON.stringify(c.messages);
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

/** Ada (administrator) with cloud and local models, a Memory, the seed persona, and Sleep over them. */
async function setup(limits: Partial<SleepLimits> = {}) {
  const m = await withModels();
  m.models.setColumnTask(m.ada.id, "general", "chat", m.cloudRef);
  m.models.setColumnTask(m.ada.id, "private", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(SEED);
  const proposals = new PersonaProposals(m.keyring.self(), m.users, persona);
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-sleep-"));
  dirs.push(cwd);
  const logs: string[] = [];
  const sleep = new Sleep({
    users: m.users, memory, models: m.models, persona, proposals, cwd, hasKey: (id) => m.keyring.hasUserKey(id),
    limits: { retries: 0, ...limits }, log: (l) => logs.push(l),
  });
  /** Scripts both servers: each phase's steps in order, then "Done." A dream and a WAKE unless told otherwise. */
  const script = (given: Script) => {
    const s: Script = { dream: [call("write_journal", { text: "A quiet night." })], wake: [call("write_wake", { text: words(400) })], ...given };
    const at: Record<Phase, number> = { consolidate: 0, dream: 0, wake: 0 };
    const seen: Record<Phase, ChatRequest[]> = { consolidate: [], dream: [], wake: [] };
    const respond = (c: ChatRequest): Reply => {
      const phase = phaseOf(c);
      if (!phase) return { text: "ok" };
      seen[phase].push(c);
      const step = s[phase]?.[at[phase]++];
      return typeof step === "function" ? step(c) : step ?? { text: "Done." };
    };
    m.cloud.respond(respond);
    m.local.respond(respond);
    return seen;
  };
  const view = (pool: Pool = "general", userId = m.ada.id) => memory.openThreadView(userId, pool);
  /** A conversation in which Ada says something and Lyrica notes it. */
  const talk = (v: PoolView, said: string, note?: string) => {
    const t = v.own.createThread({ interface: "web" });
    const e = v.own.appendEntry(t.id, { piId: `p${Math.random()}`, role: "user", data: {}, text: said });
    v.own.appendEntry(t.id, { piId: `p${Math.random()}`, role: "assistant", data: {}, text: "I see." });
    const [n] = note ? v.own.addNotes([{ text: note, source: e }], { author: "lyrica", thread: t.id }) : [];
    return { thread: t.id, entry: e, note: n };
  };
  return { ...m, memory, persona, proposals, sleep, logs, script, view, talk };
}

describe("a night's sleep", () => {
  it("consolidates notes into cited pages, dreams as reflection, and writes WAKE last, which the next thread wakes up with", async () => {
    const s = await setup();
    const v = s.view();
    const { note, thread } = s.talk(v, "My homelab has three nodes now.", "{user}'s homelab has three nodes");
    const wake = `I'm waking up thinking about the homelab. ${words(450)}`;
    const seen = s.script({
      consolidate: [
        (c) => { expect(said(c)).toContain(note!); expect(said(c)).toContain(`t:${thread}`); return call("read_memory", { id: `t:${thread}` }); },
        call("write_page", { slug: "homelab", title: "Homelab", summary: "{user}'s homelab", text: `Three nodes [${note}].` }),
      ],
      dream: [call("write_journal", { text: "I dreamt of racks of humming machines." })],
      wake: [call("write_wake", { text: wake })],
    });

    const run = await s.sleep.run(s.ada.id, "general", "manual");
    expect(run).toMatchObject({ status: "complete", reason: "manual" });
    expect(Object.keys(run.phases)).toEqual(["consolidate", "dream", "wake"]);
    expect(seen.consolidate.length).toBeGreaterThan(0);

    const page = v.own.get("p:homelab")!;
    expect(page.text).toBe(`Three nodes [${note}].`);
    expect(v.own.cameFrom("p:homelab")).toEqual([note]);
    expect(v.own.usedIn(note!)).toEqual(["p:homelab"]);
    const [journal] = v.own.listJournal();
    expect(journal!.text.startsWith(DREAM_HEADER)).toBe(true);
    // WAKE last: after the page and the dream.
    const at = (id: string) => v.own.revisions(id).at(-1)!.createdAt;
    expect(at("wake") >= at(journal!.id) && at(journal!.id) >= at("p:homelab")).toBe(true);
    // Each phase is a thread in the pool's sleep interface, so it can be recalled later.
    expect(Object.values(run.phases).map((p) => v.own.getThread(p!.thread)!.interface)).toEqual(["sleep", "sleep", "sleep"]);

    // The next new thread wakes up with WAKE and the time since they last talked.
    const next = v.own.createThread({ interface: "web" });
    const sections = await memorySections(v, "hello", { threadId: next.id, user: { id: s.ada.id, profile: s.ada.profile }, folders: [] });
    expect(sections.wake).toBe(wake);
    expect(sections.lastTalk).toBeInstanceOf(Date);
    expect(v.own.watermark()).toBe(run.until);
    v.close();
  });

  it("forgets its phase threads after 36 hours, keeping what they wrote, and recall never finds a deleted note in them", async () => {
    const s = await setup();
    const v = s.view();
    const { note } = s.talk(v, "My bike is a garnet tourer.", "{user} rides a garnet tourer");
    s.script({
      consolidate: [call("read_memory", { id: note! }), call("raise", { text: "Ask about the tourer" })],
    });
    const run = await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(run.status).toBe("complete");
    const threads = Object.values(run.phases).map((p) => p!.thread);
    // The note's text is in consolidate's transcript, but deleted, nothing finds it there.
    expect(JSON.stringify(v.own.loadEntries(threads[0]!))).toContain("garnet");
    v.own.delete(note!, "lyrica");
    expect(v.own.search("garnet tourer", { limit: 10 }).filter((h) => h.id.startsWith("e:sleep/"))).toEqual([]);

    const later = (h: number) => new Date(Date.now() + h * 3600_000);
    expect(s.sleep.prune(later(35))).toBe(0);
    expect(s.sleep.prune(later(37))).toBe(3);
    for (const t of threads) {
      expect(v.own.getThread(t)).toBeUndefined();
      expect(v.own.getThreadTombstone(t)).toBeDefined();
    }
    // What sleep wrote stays: the journal, WAKE and the question.
    expect(v.own.listJournal()).toHaveLength(1);
    expect(v.own.getWake()).toBeDefined();
    expect(v.own.listItems().map((i) => i.text)).toEqual(["Ask about the tourer"]);
    v.close();
  });

  it("keeps dreams out of WAKE and items out of every thread but one started from it", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "I'm thinking about the garden.", "{user} is planning the garden");
    const seen = s.script({
      dream: [
        call("raise", { text: "A thought before writing" }),
        call("write_journal", { text: "Moonlit tomatoes climbing a ladder." }),
        call("raise", { text: "Ask about the moonlit tomato idea" }),
        // The same subject again keeps the one item.
        call("raise", { text: "Ask them about the moonlit tomato idea" }),
      ],
      wake: [
        call("recall", { query: "moonlit tomatoes" }),
        call("read_memory", { id: v.own.listJournal(1)[0]?.id ?? "j:none" }),
        call("write_wake", { text: `The garden is in motion. ${words(420)}` }),
      ],
    });
    const run = await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(run.status).toBe("complete");

    // The wake phase never saw the dream: not in recall, not by reading it, not from the dream's thread.
    expect(seen.wake.length).toBeGreaterThan(1);
    for (const c of seen.wake) expect(said(c)).not.toMatch(/Moonlit tomatoes|ladder/);
    expect(v.own.getWake()).not.toMatch(/moonlit|tomato/i);

    const [item, before] = v.own.listItems();
    expect(item).toMatchObject({ kind: "thought", text: "Ask about the moonlit tomato idea", run: run.id });
    // Each thought links to tonight's dream: its journal entry, or its thread before the entry was written.
    expect(item!.source).toBe(v.own.listJournal(1)[0]!.id);
    expect(before).toMatchObject({ text: "A thought before writing", source: `t:${run.phases.dream!.thread}` });

    // No other thread has the item in its context, and recall can't find it.
    const user = { id: s.ada.id, profile: s.ada.profile };
    const other = v.own.createThread({ interface: "web" });
    const plain = await memorySections(v, "what about the tomato idea?", { threadId: other.id, user, folders: [] });
    expect(JSON.stringify(plain)).not.toContain("Ask about the moonlit tomato idea");
    expect(plain.opening).toBeUndefined();
    // A thread started from it has it, and she opens with it.
    const chat = v.own.createThread({ interface: "web" });
    v.own.startItem(item!.id, chat.id);
    const opened = await memorySections(v, "", { threadId: chat.id, user, folders: [] });
    expect(opened.opening).toContain("Ask about the moonlit tomato idea");

    // The dream still comes up through recall when a conversation touches it.
    expect(searchView(v, "tomatoes ladder").map((h) => h.kind)).toContain("journal");
    v.close();
  });

  it("creates p:about-user from notes, updates it, and keeps the user's own words, asking instead", async () => {
    const s = await setup();
    const v = s.view();
    const first = s.talk(v, "Please don't call me sweetie.", "{user} can't stand being called sweetie");
    s.script({ consolidate: [call("write_page", { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `{user} can't stand being called sweetie [${first.note}].` })] });
    expect((await s.sleep.run(s.ada.id, "general", "manual")).status).toBe("complete");
    expect(v.own.get("p:about-user")!.text).toBe(`Ada can't stand being called sweetie [${first.note}].`);

    // Ada writes her own line on the page; then says something new.
    const owner = s.memory.openOwnerView(s.ada.id);
    const mine = "I'm a night owl, and I like it that way.";
    owner.general.edit("p:about-user", { text: `${mine}\n\n${owner.general.get("p:about-user", { raw: true })!.text}` }, `user:${s.ada.id}`);
    owner.close();
    const second = s.talk(v, "I've started getting up at 6.", "{user} gets up at 6 now");

    const results: string[] = [];
    s.script({
      consolidate: [
        call("write_page", { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `{user} is an early riser [${second.note}].` }),
        (c) => { results.push(said(c)); return call("raise", { text: "You wrote you're a night owl, but now you get up at 6. Which is it?", source: "p:about-user" }); },
        call("write_page", { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `${mine}\n\n{user} can't stand being called sweetie [${first.note}]. {user} gets up at 6 now [${second.note}].` }),
      ],
    });
    await s.sleep.run(s.ada.id, "general", "manual");
    expect(results[0]).toContain("has text a user wrote");
    const page = v.own.get("p:about-user")!;
    expect(page.text).toContain(mine);
    expect(page.text).toContain(`gets up at 6 now [${second.note}]`);
    expect(v.own.listItems().find((i) => i.kind === "question")).toMatchObject({ source: "p:about-user" });
    v.close();
  });

  it("writes only to private in private sleep, citing general; general sleep never opens private", async () => {
    const s = await setup();
    const g = s.view("general");
    const p = s.view("private");
    const general = s.talk(g, "I run a homelab.", "{user} runs a homelab");
    const secret = s.talk(p, "I'm seeing Dr. Okafor.", "{user} sees Dr. Okafor");
    const openSpy = vi.spyOn(s.memory, "openThreadView");

    s.script({ consolidate: [call("write_page", { slug: "health", title: "Health", summary: "private", text: `Therapy [${secret.note}], and the homelab helps [general/${general.note}].` })] });
    await s.sleep.run(s.ada.id, "private", "manual");
    expect(p.own.cameFrom("p:health")).toEqual([`general/${general.note}`, secret.note]);
    expect(g.own.get("p:health")).toBeUndefined();
    expect(g.own.sleepChanges("", new Date().toISOString())).toEqual({ notes: [], pages: [], journal: [] });
    // Private sleep ran on the local model only.
    expect(s.cloud.requests).toHaveLength(0);

    openSpy.mockClear();
    s.script({ consolidate: [(c) => { expect(said(c)).not.toContain("Okafor"); return call("recall", { query: "Okafor" }); }, (c) => { expect(said(c).split("Okafor").length).toBe(2); return { text: "Done." }; }] });
    await s.sleep.run(s.ada.id, "general", "manual");
    expect(openSpy.mock.calls.map((c) => c[1])).toEqual(["general"]);
    // General sleep ran on the general column's model.
    expect(s.cloud.requests.length).toBeGreaterThan(0);
    g.close();
    p.close();
  });

  it("keeps out of the private page about the user what general's page already says, and tidies it when general's changes", async () => {
    const s = await setup();
    const g = s.view("general");
    const p = s.view("private");
    const homelab = s.talk(g, "I run a homelab.", "{user} runs a homelab");
    s.script({ consolidate: [call("write_page", { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `{user} runs a homelab [${homelab.note}].` })] });
    await s.sleep.run(s.ada.id, "general", "manual");

    // The private page repeats the homelab beside something private.
    const secret = s.talk(p, "I'm seeing Dr. Okafor.", "{user} sees Dr. Okafor");
    const prompts: string[] = [];
    s.script({
      consolidate: [
        (c) => { prompts.push(said(c)); return call("write_page", { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `{user} runs a homelab [general/${homelab.note}]. {user} sees Dr. Okafor [${secret.note}].` }); },
      ],
    });
    await s.sleep.run(s.ada.id, "private", "manual");
    expect(prompts[0]).toContain("General memory's page about Ada [general/p:about-user]");
    expect(prompts[0]).toContain("Ada runs a homelab");
    expect(prompts[0]).toContain("Drop anything it already says");

    // General's page changes; private sleep runs with nothing else new, and drops the repeat.
    const owner = s.memory.openOwnerView(s.ada.id);
    owner.general.edit("p:about-user", { text: `${g.own.get("p:about-user", { raw: true })!.text} {user} likes jazz.` }, `user:${s.ada.id}`);
    owner.close();
    s.script({ consolidate: [call("write_page", { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `{user} sees Dr. Okafor [${secret.note}].` })] });
    expect((await s.sleep.run(s.ada.id, "private", "manual")).status).toBe("complete");
    expect(p.own.get("p:about-user")!.text).toBe(`Ada sees Dr. Okafor [${secret.note}].`);
    // Nothing is left to tidy, so the next night has nothing to do.
    expect((await s.sleep.run(s.ada.id, "private", "manual")).skipReason).toBe("no-activity");
    // General never sees the private page.
    expect(g.own.get("p:about-user")!.text).not.toContain("Okafor");
    g.close();
    p.close();
  });

  it("waits for a plan out of usage, and runs once the user falls back", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "Hello there.", "{user} said hello");
    const plan = s.models.addPlan(s.ada, { name: "chatgpt", plan: "chatgpt", credential: { access: "a", refresh: "r", expires: Date.now() + 3_600_000 } });
    s.models.setColumnTask(s.ada.id, "general", "sleep.dream", { offeringId: s.models.addModel(s.ada, plan.id, { modelId: "gpt-5" }).id });
    s.models.reportPlanLimit(plan.id, Date.now() + 40 * 60_000);
    expect(await s.sleep.run(s.ada.id, "general", "scheduled")).toMatchObject({ status: "skipped", skipReason: "plan-limit" });
    expect(s.sleep.planWaits(s.ada.id)).toEqual([{ pool: "general", endpointId: plan.id }]);
    // Still limited: the tick leaves it waiting.
    s.sleep.resumeWaiting();
    expect(s.sleep.planWaits(s.ada.id)).toHaveLength(1);
    // The user falls back, so the dream goes to the next model and the run goes ahead.
    s.models.setColumnTask(s.ada.id, "general", "sleep.dream", [{ offeringId: s.models.addModel(s.ada, plan.id, { modelId: "gpt-5.1" }).id }, s.cloudRef]);
    expect(s.models.fallBackFromLimit(plan.id)).toBe(true);
    s.script({});
    s.sleep.resumeWaiting();
    expect(s.sleep.planWaits(s.ada.id)).toEqual([]);
    await vi.waitFor(() => expect(v.own.listSleepRuns(5)[0]).toMatchObject({ status: "complete" }), { timeout: 20_000 });
    v.close();
  });

  it("skips when the endpoint is offline without moving the watermark, and resumes a partial run", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "Hello there.", "{user} said hello");
    const dead = s.models.addEndpoint(s.ada, { name: "dead", kind: "cloud", baseUrl: await deadUrl() });
    s.models.setColumnTask(s.ada.id, "general", "sleep.dream", { offeringId: s.models.addModel(s.ada, dead.id, { modelId: "m" }).id });
    const skipped = await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(skipped).toMatchObject({ status: "skipped", skipReason: "endpoint-down", phases: {} });
    expect(v.own.watermark()).toBeUndefined();
    expect(await s.sleep.check(s.ada.id, "general")).toMatchObject({ skip: "endpoint-down" });

    // The endpoint is back, but drops during the dream: consolidate stays done.
    s.models.setColumnTask(s.ada.id, "general", "sleep.dream");
    s.script({ dream: [{ status: 500 }] });
    const partial = await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(partial.status).toBe("partial");
    expect(partial.phases.consolidate?.done).toBe(true);
    expect(partial.phases.dream?.done).toBe(false);
    expect(v.own.watermark()).toBe(partial.until);

    // Next time it carries on from the dream, as the same run.
    const seen = s.script({ dream: [call("write_journal", { text: "A quiet night." })], wake: [call("write_wake", { text: words(400) })] });
    const resumed = await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(resumed).toMatchObject({ id: partial.id, status: "complete" });
    expect(resumed.phases.consolidate).toEqual(partial.phases.consolidate);
    expect(seen.consolidate).toHaveLength(0);
    await expect(s.sleep.check(s.ada.id, "general")).resolves.toMatchObject({ skip: "no-activity" });
    v.close();
  });

  it("with Fallback off, skips a night whose phase's first model is away rather than use the next", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "Hello there.", "{user} said hello");
    const dead = s.models.addEndpoint(s.ada, { name: "dead", kind: "cloud", baseUrl: await deadUrl() });
    s.models.setColumnTask(s.ada.id, "general", "sleep.dream", [{ offeringId: s.models.addModel(s.ada, dead.id, { modelId: "m" }).id }, s.cloudRef]);
    expect(s.sleep.fallback(s.ada.id)).toBe(true);
    s.sleep.setFallback(s.ada.id, false);
    expect(s.sleep.fallback(s.ada.id)).toBe(false);
    expect(await s.sleep.run(s.ada.id, "general", "scheduled")).toMatchObject({ status: "skipped", skipReason: "endpoint-down" });
    expect(v.own.watermark()).toBeUndefined();
    // On, the next model in the list sleeps.
    s.sleep.setFallback(s.ada.id, true);
    s.script({});
    expect((await s.sleep.run(s.ada.id, "general", "scheduled")).status).toBe("complete");
    v.close();
  });

  it("never sleeps unlogged threads or entries written after the run began", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "Logged and ordinary.", "{user} said something ordinary");
    const hidden = v.own.createThread({ interface: "web", unlogged: true });
    v.own.appendEntry(hidden.id, { piId: "u1", role: "user", data: {}, text: "UNLOGGED-MARKER" });
    const later = v.own.createThread({ interface: "web" });
    const future = new Date(Date.now() + 60_000).toISOString();
    v.own.appendEntry(later.id, { piId: "f1", role: "user", data: {}, text: "LATER-MARKER" }, future);
    let instruction = "";
    s.script({ consolidate: [(c) => { instruction = said(c); return { text: "Done." }; }] });
    const run = await s.sleep.run(s.ada.id, "general", "manual");
    expect(instruction).not.toContain(hidden.id);
    expect(instruction).not.toContain(later.id);
    // The later entry waits for the next sleep.
    expect(v.own.sleepMaterial(v.own.watermark(), new Date(Date.now() + 120_000).toISOString()).threads.map((t) => t.id)).toEqual([later.id]);
    expect(run.until < future).toBe(true);
    // An entry written at the very millisecond the watermark names is slept next time.
    v.own.appendEntry(later.id, { piId: "f2", role: "user", data: {}, text: "EDGE" }, run.until);
    expect(v.own.sleepMaterial(v.own.watermark(), future).threads.map((t) => t.id)).toEqual([later.id]);
    v.close();
  });

  it("makes a normal user's dream proposal a draft in their own user.db", async () => {
    const s = await setup();
    const sam = await s.users.createUser("sam", "pw2", profile("Sam"), { admin: false });
    await s.users.authenticate("sam", "pw2");
    const gpu = s.models.addEndpoint(sam, { name: "gpu", kind: "local", baseUrl: s.local.baseUrl });
    s.models.setColumnTask(sam.id, "general", "chat", { offeringId: (await s.models.discover(sam, gpu.id))[0]!.id });
    const v = s.view("general", sam.id);
    s.talk(v, "Tell me about friendship.", "{user} asked about friendship");
    s.script({ dream: [call("propose_persona", { path: "persona_topics/friends.md", text: "Friends are chosen family.", reason: "a dream about Sam" })] });
    await s.sleep.run(sam.id, "general", "manual");
    expect(s.proposals.drafts(sam.id)).toEqual([expect.objectContaining({ text: "Friends are chosen family.", author: "sleep" })]);
    expect(s.persona.proposals()).toEqual([]);
    expect(v.own.listItems()).toEqual([expect.objectContaining({ kind: "persona", source: expect.stringMatching(/^draft:\d+$/) })]);
    v.close();
  });

  it("records no-activity and no-key skips, and logs no text", async () => {
    const s = await setup();
    const v = s.view();
    expect(await s.sleep.run(s.ada.id, "general", "scheduled")).toMatchObject({ status: "skipped", skipReason: "no-activity" });
    v.close();

    s.keyring.lockUser(s.ada.id);
    expect(await s.sleep.run(s.ada.id, "general", "scheduled")).toMatchObject({ status: "skipped", skipReason: "no-key" });
    await s.users.authenticate("ada", "pw");
    // Recorded once the key is back.
    const marker = "ZEBRA-MARKER-7";
    const again = s.view();
    s.talk(again, `My secret word is ${marker}.`, `{user}'s secret word is ${marker}`);
    s.script({ consolidate: [call("write_page", { slug: "secret", title: marker, summary: marker, text: `${marker} [${again.own.search(marker, { kinds: ["note"] })[0]!.id}]` })] });
    await s.sleep.run(s.ada.id, "general", "manual");
    expect(again.own.listSleepRuns().map((r) => [r.status, r.skipReason])).toEqual([["complete", undefined], ["skipped", "no-key"], ["skipped", "no-activity"]]);
    expect(s.logs.length).toBeGreaterThan(0);
    expect(s.logs.join("\n")).not.toContain(marker);
    again.close();
  });

  it("stops at Lock, or past a phase's limit, and marks the run partial", async () => {
    const s = await setup({ turns: 2 });
    const v = s.view();
    s.talk(v, "Something.", "{user} said something");
    s.script({ consolidate: [call("recall", { query: "a" }), call("recall", { query: "b" }), call("recall", { query: "c" })] });
    const limited = await s.sleep.run(s.ada.id, "general", "manual");
    expect(limited).toMatchObject({ status: "partial", phases: { consolidate: { done: false, limit: "turns" } } });
    expect(v.own.watermark()).toBeUndefined();

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    s.script({ consolidate: [() => { release(); return call("recall", { query: "x" }); }] });
    const running = s.sleep.run(s.ada.id, "general", "manual");
    await held;
    await s.sleep.stop(s.ada.id);
    expect((await running).status).toBe("partial");
    v.close();
  });
});

describe("consolidation that keeps to its job", () => {
  it("sizes a phase's token budget by its model's context window, and records the limit it stopped at", async () => {
    // The cloud model's window is 128,000: four windows is far more than a phase uses here.
    const roomy = await setup({ tokens: 1 });
    roomy.talk(roomy.view(), "Something.", "{user} said something");
    roomy.script({ consolidate: [call("recall", { query: "a" })] });
    expect((await roomy.sleep.run(roomy.ada.id, "general", "manual")).status).toBe("complete");

    const tight = await setup({ tokens: 1, windows: 0 });
    tight.talk(tight.view(), "Something.", "{user} said something");
    tight.script({ consolidate: [call("recall", { query: "a" })] });
    expect(await tight.sleep.run(tight.ada.id, "general", "manual")).toMatchObject({ status: "partial", phases: { consolidate: { done: false, limit: "tokens" } } });
    expect(tight.logs).toContain("sleep general consolidate stopped at its tokens limit");
  });

  it("writes {user} only for the person's whole name, never a date or someone sharing their first name", () => {
    expect(asUserToken("May Lin moved the review to May 3rd; May Chen agreed.", "May Lin")).toBe("{user} moved the review to May 3rd; May Chen agreed.");
  });

  it("lets a newer note supersede an older one, flags the pages citing it, and never supersedes the user's own note", async () => {
    const s = await setup();
    const v = s.view();
    const old = s.talk(v, "Claude merges our pull requests.", "Claude merges the pull requests");
    v.own.putPage({ slug: "workflow", title: "Workflow", summary: "how work merges", text: `Claude merges [${old.note}].` }, "sleep");
    const owner = s.memory.openOwnerView(s.ada.id);
    const mine = owner.general.addNotes([{ text: "Reviews happen on Fridays" }], { author: `user:${s.ada.id}` })[0]!;
    owner.close();
    await new Promise((r) => setTimeout(r, 2));
    const newer = s.talk(v, "Since this week I merge my own pull requests.", "{user} now merges pull requests after review");
    const seen = s.script({
      consolidate: [
        (c) => { expect(said(c)).toContain("the newer one holds"); return call("supersede", { notes: [old.note], by: newer.note }); },
        call("supersede", { notes: [mine], by: newer.note }),
        call("write_page", { slug: "workflow", title: "Workflow", summary: "how work merges", text: `Claude merges [${old.note}].` }),
        call("write_page", { slug: "workflow", title: "Workflow", summary: "how work merges", text: `{user} merges after review [${newer.note}].` }),
      ],
    });
    await new Promise((r) => setTimeout(r, 2));
    expect((await s.sleep.run(s.ada.id, "general", "manual")).status).toBe("complete");
    // Replaced, still readable and citable; the page citing it came up for a rewrite, and the rewrite cleared it.
    expect(v.own.get(old.note!)).toMatchObject({ supersededBy: newer.note });
    // Folding deletes nothing, so it leaves no tombstone: the entry can still be noted.
    expect(v.own.isTombstoned(old.note!) || v.own.isTombstoned(old.entry)).toBe(false);
    expect(said(seen.consolidate[1]!)).toContain("Rewrite [p:workflow] from current notes");
    expect(said(seen.consolidate[2]!)).toContain("was added by a user: raise a question instead");
    expect(v.own.get(mine)!.supersededBy).toBeUndefined();
    // A page cites the note that replaced one, never the replaced note.
    expect(said(seen.consolidate[3]!)).toContain(`[${old.note}] was superseded by [${newer.note}]: cite the current note instead`);
    expect(v.own.cameFrom("p:workflow")).toEqual([newer.note]);
    expect(v.own.get("p:workflow")).toMatchObject({ flagged: false });
    v.close();
  });

  it("writes WAKE from the last one beside the notes written since, never from its own context, and strips a copied dream header", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "Can you finish the jump-to-latest button?", "The jump-to-latest button is open and hers to finish");
    s.script({ wake: [call("write_wake", { text: `The jump-to-latest button is still open. ${words(420)}` })] });
    expect((await s.sleep.run(s.ada.id, "general", "manual")).status).toBe("complete");
    const lastWake = v.own.get("wake")!.text;
    await new Promise((r) => setTimeout(r, 2));
    const done = s.talk(v, "The jump-to-latest button merged.", "The jump-to-latest button merged");
    const seen = s.script({
      dream: [call("write_journal", { text: `${DREAM_HEADER}\n\n**${DREAM_HEADER}**\n\nA river of buttons.` })],
      wake: [call("write_wake", { text: `The button is done. ${words(420)}` })],
    });
    await new Promise((r) => setTimeout(r, 2));
    expect((await s.sleep.run(s.ada.id, "general", "manual")).status).toBe("complete");
    const prompt = said(seen.wake[0]!);
    expect(prompt).toContain("It is a draft, not a source");
    expect(prompt).toContain(`[${done.note}]`);
    // The old WAKE comes once, in the instruction, not again as what she woke up with.
    expect(prompt.split(lastWake.slice(0, 40)).length).toBe(2);
    const [journal] = v.own.listJournal();
    expect(journal!.text).toBe(`${DREAM_HEADER}\n\nA river of buttons.`);
    v.close();
  });

  it("writes pages before reading conversations, reads only so many, keeps no near-copies, and writes {user} for the name", async () => {
    const s = await setup();
    const v = s.view();
    const { note, entry } = s.talk(v, "I take my tea without sugar.", "{user} takes tea without sugar");
    const reads = Array.from({ length: 13 }, (_, i) => call("recall", { query: `q${i}` }));
    const seen = s.script({
      consolidate: [
        call("read_memory", { id: entry }),
        (c) => { expect(said(c)).toContain("Write the pages first"); return call("write_page", { slug: "about-user", title: "About Ada", summary: "who Ada is", text: `Ada takes tea without sugar [${note}].` }); },
        call("remember", { notes: [{ text: `Ada takes her tea without sugar [${entry}]` }, { text: `Ada drinks it at four [${entry}]` }] }),
        ...reads,
      ],
    });
    // Sleep takes notes made before it starts (created_at < until): one made in the same millisecond waits for the next run.
    await new Promise((r) => setTimeout(r, 2));
    expect((await s.sleep.run(s.ada.id, "general", "manual")).status).toBe("complete");
    // The page and the new note say {user}, which shows as her name; the near-copy wasn't saved again.
    expect(v.own.get("p:about-user", { raw: true })!.text).not.toContain("Ada");
    expect(v.own.get("p:about-user")!.text).toBe(`Ada takes tea without sugar [${note}].`);
    const notes = v.own.usedIn(entry).filter((id) => id.startsWith("n:"));
    expect(notes).toHaveLength(2);
    expect(said(seen.consolidate[3]!)).toContain(`Already noted, so not saved again: [${note}]`);
    // Twelve reads of conversation after the page, then a refusal.
    expect(said(seen.consolidate.at(-1)!)).toContain("enough: write what you have");
    v.close();
  });

  it("writes {user} for the name in the journal, WAKE and what she raises, and shows the name", async () => {
    const s = await setup();
    const v = s.view();
    s.talk(v, "I'm thinking about the garden.", "{user} is planning the garden");
    s.script({
      dream: [call("write_journal", { text: "Ada and I walked the garden." }), call("raise", { text: "Ada owes me a decision on the beds" })],
      wake: [call("write_wake", { text: `Ada is planning the garden. ${words(400)}` })],
    });
    expect((await s.sleep.run(s.ada.id, "general", "manual")).status).toBe("complete");
    const journal = v.own.listJournal(1)[0]!;
    expect(v.own.get(journal.id, { raw: true })!.text).not.toContain("Ada");
    expect(journal.text).toContain("Ada and I walked the garden.");
    expect(v.own.get("wake", { raw: true })!.text).not.toContain("Ada");
    expect(v.own.getWake()).toMatch(/^Ada is planning the garden\./);
    expect(v.own.listItems().map((i) => i.text)).toEqual(["Ada owes me a decision on the beds"]);
    v.close();
  });
});

describe("project pages", () => {
  /** A project chat with one thread, where Ada says something and Lyrica notes it. */
  const project = (v: PoolView, said: string, note: string, opts: { unlogged?: boolean } = {}) => {
    const chat = v.own.createThread({ interface: "web", project: true, goal: "Ship the garden app", title: "Garden app", unlogged: opts.unlogged });
    const thread = v.own.createThread({ interface: "web", parent: chat.id, child: true });
    const e = v.own.appendEntry(thread.id, { piId: `p${Math.random()}`, role: "user", data: {}, text: said });
    const [n] = opts.unlogged ? [] : v.own.addNotes([{ text: note, source: e }], { author: "lyrica", thread: thread.id });
    return { chat: chat.id, thread: thread.id, note: n, slug: projectSlug(chat.id) };
  };

  it("keeps each project's page from that night's project notes, citing them, and the next thread of the project starts with it", async () => {
    const s = await setup();
    const v = s.view();
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = project(v, "Let's use SQLite, not Postgres.", "{user} decided the garden app uses SQLite, not Postgres");
    // Sleep covers material strictly before its cutoff, including on a fast test host.
    vi.advanceTimersByTime(1);
    let instruction = "";
    s.script({
      consolidate: [
        (c) => { instruction = said(c); return call("write_page", { slug: p.slug, title: "Garden app", summary: "the garden app project", text: `Decided: SQLite, not Postgres [${p.note}].` }); },
      ],
    });
    expect((await s.sleep.run(s.ada.id, "general", "scheduled")).status).toBe("complete");
    expect(instruction).toContain(`Page: ${p.slug} (create it)`);
    expect(instruction).toContain(`Notes: [${p.note}]`);
    expect(instruction).toContain("Ship the garden app");
    const later = v.own.createThread({ interface: "web", parent: p.chat, child: true });
    expect(v.own.pageForProject(later.id)?.text).toBe(`Decided: SQLite, not Postgres [${p.note}].`);
    expect(v.own.cameFrom(`p:${p.slug}`)).toEqual([p.note]);
    // Folded into the page, the note stays a note.
    expect(v.own.get(p.note!)).toBeDefined();
    v.close();
  });

  it("keeps Ada's instructions on a project's page word for word, and still rewrites its own part after she edits them", async () => {
    const s = await setup();
    const v = s.view();
    const p = project(v, "Write the changelog in German.", "{user} wants the garden app's changelog in German");
    const instruct = (text: string) => {
      const owner = s.memory.openOwnerView(s.ada.id);
      owner.general.setProjectInstructions(p.chat, text, `user:${s.ada.id}`);
      owner.close();
    };
    instruct("Always measure in metric.");
    s.script({ consolidate: [call("write_page", { slug: p.slug, title: "Garden app", summary: "the garden app project", text: `Changelog in German [${p.note}].` })] });
    await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(v.own.get(`p:${p.slug}`)).toMatchObject({ instructions: "Always measure in metric.", text: `Changelog in German [${p.note}].` });

    // Ada changes her instructions; the next night sleep rewrites its own part as before.
    instruct("Always measure in metric. Prices in euros.");
    const later = s.talk(v, "Ship on the 1st.", "{user} ships the garden app on the 1st");
    const results: string[] = [];
    s.script({
      consolidate: [
        call("write_page", { slug: p.slug, title: "Garden app", summary: "the garden app project", text: `Changelog in German [${p.note}]. Ships on the 1st [${later.note}].` }),
        (c) => { results.push(said(c)); return { text: "Done." }; },
      ],
    });
    await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(results[0]).toContain(`Wrote p:${p.slug}`);
    expect(v.own.get(`p:${p.slug}`)).toMatchObject({
      instructions: "Always measure in metric. Prices in euros.",
      text: `Changelog in German [${p.note}]. Ships on the 1st [${later.note}].`,
    });
    v.close();
  });

  it("shows a project chat's look at its threads as a pointer, never as the person's words", async () => {
    const s = await setup();
    const v = s.view();
    const p = project(v, "Let's use SQLite, not Postgres.", "{user} decided the garden app uses SQLite, not Postgres");
    const before = v.own.lastUserMessage();
    v.own.appendEntry(p.chat, { piId: "look", role: "user", data: {}, text: `${WATCHING_MARK}In [t:${p.thread}]:\n- The person wrote: "Let's use SQLite, not Postgres."` });
    // Not the person talking, and not something recall finds.
    expect(v.own.lastUserMessage()).toEqual(before);
    expect(v.own.search("SQLite Postgres").map((h) => h.id).some((id) => id.startsWith(`e:${p.chat}#`))).toBe(false);
    const read: string[] = [];
    s.script({
      consolidate: [
        call("read_memory", { id: `t:${p.chat}` }),
        (c) => { read.push(said(c)); return { text: "Done." }; },
      ],
    });
    await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(read[0]).toContain(`watching threads: a look at [t:${p.thread}]`);
    expect(read[0]).not.toContain("The person wrote");
    v.close();
  });

  it("writes a private project's page only in private sleep, and none for an unlogged project", async () => {
    const s = await setup();
    const g = s.view("general");
    const pv = s.view("private");
    const secret = project(pv, "The surprise party is on the 12th.", "{user} planned the surprise party for the 12th");
    const quiet = project(g, "Nothing to keep.", "", { unlogged: true });
    s.talk(g, "Something ordinary.", "{user} said something ordinary");

    const general: string[] = [];
    s.script({
      consolidate: [
        (c) => { general.push(said(c)); return call("write_page", { slug: secret.slug, title: "Party", summary: "x", text: `The 12th [${secret.note}].` }); },
        (c) => { general.push(said(c)); return call("write_page", { slug: quiet.slug, title: "Quiet", summary: "x", text: "Something [n:20261011-00000000]." }); },
        (c) => { general.push(said(c)); return { text: "Done." }; },
      ],
    });
    await s.sleep.run(s.ada.id, "general", "scheduled");
    expect(general[0]).not.toContain(secret.chat);
    expect(general[0]).not.toContain(quiet.chat);
    expect(general[1]).toContain("there's no such project here");
    expect(general[2]).toContain("isn't logged in memory");
    expect(g.own.get(`p:${secret.slug}`)).toBeUndefined();
    expect(g.own.get(`p:${quiet.slug}`)).toBeUndefined();

    s.script({ consolidate: [call("write_page", { slug: secret.slug, title: "Party", summary: "the party", text: `The 12th [${secret.note}].` })] });
    await s.sleep.run(s.ada.id, "private", "scheduled");
    expect(pv.own.get(`p:${secret.slug}`)!.text).toBe(`The 12th [${secret.note}].`);
    expect(s.cloud.requests.filter((r) => JSON.stringify(r).includes("surprise party"))).toHaveLength(0);
    g.close();
    pv.close();
  });

  it("keeps an unlogged project chat's title and goal out of sleep, even when its threads are logged", async () => {
    const s = await setup();
    const v = s.view();
    const p = project(v, "We pick the paint on Friday.", "{user} picks the paint on Friday");
    v.own.setUnlogged(p.chat, true);
    let instruction = "";
    s.script({ consolidate: [(c) => { instruction = said(c); return { text: "Done." }; }] });
    await s.sleep.run(s.ada.id, "general", "scheduled");
    // The thread itself is still slept, as an ordinary thread.
    expect(instruction).toContain(`t:${p.thread}`);
    expect(instruction).not.toContain(p.chat);
    expect(instruction).not.toContain("Ship the garden app");
    expect(instruction).not.toContain(p.slug);
    v.close();
  });
});
