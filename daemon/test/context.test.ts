import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { CODING_GUIDELINE, CONTINUATION_GUIDELINES, MODEL_CHOICE_TEXT, RECALL_GUIDELINES, SKILL_TOOL_TEXT, THREAD_MODEL_TEXT, WORK_GUIDELINES } from "@lyrica/extension";
import type { CallInfo, EndpointInfo, MessagePage, ThreadEvent, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** An unlocked lyricad, Ada logged in, a local model with a 16k window, and one thread in `pool`. */
async function setup(pool: "general" | "private" = "general", window = 16_384) {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  const ref = await localModel(ada, rt.ada.id, model.baseUrl);
  await ada.patch(`/api/u/${rt.ada.id}/offerings/${ref.offeringId}`, { contextWindow: window });
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool, title: "long work" })).body;
  const path = `/api/u/${rt.ada.id}/threads/${pool}/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  const turn = async (text: string) => {
    const ends = stream.events.filter((e) => e.event.type === "turn_end").length;
    await ada.post(`${path}/messages`, { text });
    await stream.until((e) => e.type === "turn_end" && stream.events.filter((x) => x.event.type === "turn_end").length > ends, 0, 20_000);
  };
  /**
   * After her first turn, sets the window to that turn's context plus `headroom`, so a boundary
   * scenario holds whatever the machine adds to her prompt (paths, tools), which a fixed window doesn't.
   */
  const fitAfterFirst = (headroom: number) => {
    const first = stream.events.find((e) => e.event.type === "context")!.event as Extract<ThreadEvent, { type: "context" }>;
    return ada.patch(`/api/u/${rt.ada.id}/offerings/${ref.offeringId}`, { contextWindow: first.context.tokens + headroom });
  };
  return { rt, ...dm, ada, model, ref, thread, path, stream, turn, fitAfterFirst };
}

// Keep these boundary scenarios at the same headroom over her first turn as before the new
// operational guidance. The fake endpoint estimates one token per four chars;
// allow for JSON/bullet formatting and Pi's 8% reserve at the window's edge.
const guidanceTokens = Math.ceil((JSON.stringify([...CONTINUATION_GUIDELINES, ...WORK_GUIDELINES, CODING_GUIDELINE, ...MODEL_CHOICE_TEXT, ...THREAD_MODEL_TEXT, ...RECALL_GUIDELINES, ...Object.values(SKILL_TOOL_TEXT)]).length + 96) / (4 * 0.92));
/** The window over her first turn's context (a long message on top of her prompt) where Pi compacts by the third. */
const TIGHT = 1406 + guidanceTokens;
/**
 * The window over her first turn's context where three long turns and a short one still fit, with no compaction.
 * Pi's reserve is 8% of the whole window, which grows with her prompt while this headroom doesn't: 5090 had left
 * the short turn two tokens under Pi's edge, so a few more tokens of tool text compacted it early.
 */
const ROOMY = 5600 + guidanceTokens;
/**
 * The window over her first, medium turn's context where seven more medium turns and a short one fit. Pi keeps the
 * window's newest quarter when it compacts, and this window is her whole prompt plus headroom: with three long
 * turns a slightly longer prompt (CI's, or a tool's new text) kept them all ("Nothing to compact"). Shorter turns
 * leave older ones to cut, with room to spare under Pi's edge.
 */
const MANY = 7200 + guidanceTokens;
/** The medium turns after the first. */
const MORE = ["SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH", "SEVENTH", "EIGHTH"];

/** A long message with a word to find it by. */
const long = (mark: string) => `${mark} ${"the quick brown fox jumps over the lazy dog ".repeat(200)}`;
/** A third of a long one. */
const medium = (mark: string) => `${mark} ${"the quick brown fox jumps over the lazy dog ".repeat(66)}`;
const SUMMARY = (`SUMMARY-MARK. We are writing the migration guide for the offering IDs. Decided: one transaction per database, redirects one hop long. ` +
  `Open: whether Clean up should suggest groups. Paths: docs/models.md, core/src/models/schema.ts. Names: Ada, the blackwell host. `.repeat(3)).trim();
const sent = (r: { messages: { content?: unknown }[] }) => JSON.stringify(r.messages);

describe("her context", () => {
  it("is measured each turn, carried in her status line, and recorded on the call with speeds and no text", async () => {
    const { rt, ada, model, path, stream, turn } = await setup();
    model.reply({ text: "Here is a careful answer about Miso.", slowMs: 120 });
    await turn("tell me about Miso the cat");
    const context = stream.events.find((e) => e.event.type === "context")?.event as Extract<ThreadEvent, { type: "context" }>;
    expect(context.context).toMatchObject({ window: 16_384, parts: expect.arrayContaining([{ name: "conversation", tokens: expect.any(Number) }]) });
    const settings = (await ada.get<ThreadSettings>(`${path}/settings`)).body;
    expect(settings.context).toMatchObject({ window: 16_384, reserve: 1311 });
    const used = settings.context!.parts.filter((p) => p.name !== "reserve" && p.name !== "free").reduce((a, p) => a + p.tokens, 0);
    expect(used).toBe(settings.context!.tokens);

    // The next turn's context carries the numbers, and only the numbers.
    await turn("and her sister?");
    expect(sent(model.requests[1]!)).toMatch(/<context>\\nContext \d+% of 16k · [\d.]+k? free/);

    const calls = (await ada.get<CallInfo[]>(`/api/u/${rt.ada.id}/models/calls`)).body.filter((c) => c.task === "chat");
    expect(calls[1]!.pace).toMatchObject({ window: 16_384, outputTokens: 5, promptTokens: expect.any(Number), tokPerSec: expect.any(Number) });
    expect(calls[1]!.pace!.genMs).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(calls)).not.toMatch(/Miso|sister/);
    // The text library shows each copy's median speed.
    const lib = (await ada.get<{ entries: { copies: { speed?: { tokPerSec?: number } }[] }[] }>(`/api/u/${rt.ada.id}/library/text`)).body;
    expect(lib.entries.flatMap((e) => e.copies).some((c) => c.speed?.tokPerSec !== undefined)).toBe(true);
    stream.close();
  });

  it("once the session closes, reads the last request's prompt from the call record, not every call's output added to it", async () => {
    const { rt, d, ada, model, path, thread, stream, turn } = await setup();
    model.reply({ tools: [{ name: "recall", args: { query: "Miso" } }] }, { text: "Nothing on Miso yet." });
    await turn("what do you remember about Miso?");
    await d.services!.host.forget(rt.ada.id, "general", thread.id);
    const settings = (await ada.get<ThreadSettings>(`${path}/settings`)).body;
    const calls = (await ada.get<CallInfo[]>(`/api/u/${rt.ada.id}/models/calls`)).body.filter((c) => c.task === "chat");
    expect(settings.context).toMatchObject({ parts: [], tokens: calls[0]!.pace!.promptTokens, compactions: 0 });
    stream.close();
  });

  it("follows a window changed while the thread is open, without reopening it", async () => {
    const { rt, ada, model, ref, path, stream, turn } = await setup();
    model.reply({ text: "First." }, { text: "Second." });
    await turn("one");
    // The user sets the copy's context by hand on the Models page, mid-conversation.
    const offering = (await ada.get<ThreadSettings>(`${path}/settings`)).body;
    await ada.patch(`/api/u/${rt.ada.id}/offerings/${ref.offeringId}`, { contextWindow: 65_536 });
    await turn("two");
    const windows = stream.events.filter((e) => e.event.type === "context").map((e) => (e.event as Extract<ThreadEvent, { type: "context" }>).context.window);
    expect(offering.context?.window).toBe(16_384);
    expect(windows.at(-1)).toBe(65_536);
    stream.close();
  });

  it("is compacted by Pi at the window's edge when she doesn't, with a marker", async () => {
    // Principle 8: the window follows the seed persona and tool definitions; a turn must land between Pi's reserve and the window.
    const { ada, path, stream, turn, fitAfterFirst } = await setup("general", 16_384 + guidanceTokens);
    await turn(long("FIRST-MARK"));
    await fitAfterFirst(TIGHT);
    await turn(long("SECOND-MARK"));
    await turn(long("THIRD-MARK"));
    expect(stream.events.some((e) => e.event.type === "compacted")).toBe(true);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.flatMap((m) => m.parts).some((p) => p.type === "compacted")).toBe(true);
    stream.close();
  });

  it("compacts before a turn the conversation no longer fits, after the window shrank, instead of sending it whole", async () => {
    const { rt, ada, model, ref, stream, turn, fitAfterFirst } = await setup("general", 16_384 + guidanceTokens);
    await turn(long("FIRST-MARK"));
    await fitAfterFirst(ROOMY);
    await turn(long("SECOND-MARK"));
    await turn(long("THIRD-MARK"));
    expect(stream.events.some((e) => e.event.type === "compacted")).toBe(false);
    // The copy now runs at a window the conversation fills (a switch to a smaller model, or a load at a smaller context).
    const last = stream.events.filter((e) => e.event.type === "context").at(-1)!.event as Extract<ThreadEvent, { type: "context" }>;
    await ada.patch(`/api/u/${rt.ada.id}/offerings/${ref.offeringId}`, { contextWindow: last.context.tokens });
    const before = model.requests.length;
    await turn("go on");
    expect(stream.events.some((e) => e.event.type === "compacted")).toBe(true);
    // The summary was written first; the turn's own request went without the old messages.
    const asked = model.requests.slice(before);
    expect(asked[0]!.tools?.length ?? 0).toBe(0);
    const chat = asked.find((r) => r.tools?.length)!;
    expect(sent(chat)).not.toContain("FIRST-MARK");
    expect(sent(chat)).toContain("go on");
    stream.close();
  });

  it("compacts with her summary when the turn ends: the old messages go, the recent ones stay, and a marker holds the summary", async () => {
    const { ada, model, path, stream, turn, fitAfterFirst } = await setup("general", 16_384 + guidanceTokens);
    await turn(medium("FIRST-MARK"));
    await fitAfterFirst(MANY);
    for (const mark of MORE) await turn(medium(`${mark}-MARK`));
    expect(stream.events.filter((e) => e.event.type === "compacted")).toHaveLength(0);
    const requestsBefore = model.requests.length;
    model.reply({ tools: [{ name: "threads", args: { action: "compact", summary: SUMMARY } }] }, { text: "Compacting now." });
    await turn("let's tidy up before the next part");
    const compacted = stream.events.find((e) => e.event.type === "compacted")?.event as Extract<ThreadEvent, { type: "compacted" }>;
    expect(stream.events.filter((e) => e.event.type === "compacted")).toHaveLength(1);
    // Her summary needs no extra model request, even if the final reply crosses Pi’s threshold.
    expect(model.requests.length - requestsBefore).toBe(2);
    expect(compacted.summary).toBe(SUMMARY);
    expect(compacted.after).toBeLessThan(compacted.before);

    // The marker stays in the thread, and expands to her summary.
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.flatMap((m) => m.parts)).toContainEqual({ type: "compacted", before: compacted.before, after: compacted.after, summary: SUMMARY });

    // The next request holds her summary and the recent messages, not the old ones.
    const before = model.requests.length;
    await turn("go on");
    const next = sent(model.requests[before]!);
    expect(next).toContain("SUMMARY-MARK");
    expect(next).not.toContain("FIRST-MARK");
    expect(next).toContain("let's tidy up before the next part");
    // The meter counts the compaction and reports what is left after it.
    const after = (await ada.get<ThreadSettings>(`${path}/settings`)).body.context!;
    expect(after.compactions).toBe(1);
    expect(after.tokens).toBeLessThan(compacted.before);
    stream.close();
  });

  it("in a private thread, compacts with its local model when her summary is too short to stand on its own", async () => {
    const { ada, model, path, stream, turn, fitAfterFirst } = await setup("private", 16_384 + guidanceTokens);
    await turn(medium("FIRST-MARK"));
    await fitAfterFirst(MANY);
    for (const mark of MORE) await turn(medium(`${mark}-MARK`));
    model.reply(
      { tools: [{ name: "threads", args: { action: "compact", summary: "NOTES-MARK keep the migration plan" } }] },
      { text: "Compacting." },
      { text: "PI-SUMMARY-MARK: the migration plan, decided and open points." },
    );
    await turn("tidy up");
    // Pi wrote the summary, with her notes as its instructions, on the thread's own local model.
    const summarising = model.requests.find((r) => sent(r).includes("NOTES-MARK") && !r.tools?.length);
    expect(summarising).toBeDefined();
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.flatMap((m) => m.parts).find((p) => p.type === "compacted")).toMatchObject({ summary: expect.stringContaining("PI-SUMMARY-MARK") });
    stream.close();
  });

  it("doesn't compact when the turn that asked for it was stopped", async () => {
    const { ada, model, path, stream, turn, fitAfterFirst } = await setup("general", 16_384 + guidanceTokens);
    await turn(long("FIRST-MARK"));
    await fitAfterFirst(ROOMY);
    await turn(long("SECOND-MARK"));
    await turn(long("THIRD-MARK"));
    model.reply({ tools: [{ name: "threads", args: { action: "compact", summary: SUMMARY } }] }, { text: "Compacting now, once I finish this long thought.", slowMs: 5000 });
    const ends = stream.events.filter((e) => e.event.type === "turn_end").length;
    const from = stream.events.length;
    await ada.post(`${path}/messages`, { text: "tidy up" });
    await stream.until((e) => e.type === "tool_end", from);
    await stream.until((e) => e.type === "message_start", stream.events.length);
    await ada.post(`${path}/stop`);
    await stream.until((e) => e.type === "turn_end" && stream.events.filter((x) => x.event.type === "turn_end").length > ends, 0, 20_000);
    expect(stream.events.some((e) => e.event.type === "compacted")).toBe(false);
    const before = model.requests.length;
    await turn("go on");
    expect(sent(model.requests[before]!)).toContain("FIRST-MARK");
    stream.close();
  });

  it("records counts only in a thread that isn't logged", async () => {
    const { rt, ada, path, stream, turn } = await setup();
    expect((await ada.patch(`${path}/settings`, { unlogged: true })).status).toBe(200);
    await turn("a secret about the garden");
    const calls = (await ada.get<CallInfo[]>(`/api/u/${rt.ada.id}/models/calls`)).body.filter((c) => c.task === "chat");
    expect(calls[0]!.pace).toMatchObject({ promptTokens: expect.any(Number), outputTokens: 5 });
    expect(JSON.stringify(calls)).not.toMatch(/secret|garden/);
    stream.close();
  });
});

// Keeps the endpoint type import used by tools that check unused imports.
export type { EndpointInfo };
