import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { DelegationEvent, MessagePage, Subagents, ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/**
 * Li with a thread whose chat model and subagent models are on two fake
 * servers, so the parent's and the subagents' scripted replies never mix.
 */
async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const parent = await fakeOpenAI({ label: "parent", models: [{ id: "chat-model" }] });
  const sub = await fakeOpenAI({ label: "sub", models: [{ id: "sub-model" }] });
  await localModel(li, rt.li.id, parent.baseUrl, "chat-model");
  await li.post(`/api/u/${rt.li.id}/endpoints`, { name: "subs", kind: "local", baseUrl: sub.baseUrl });
  for (const task of ["subagent.cheap", "subagent.strong"]) await li.put(`/api/u/${rt.li.id}/profiles/cloud/${task}`, { model: { endpointId: "subs", modelId: "sub-model" } });
  const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "parent" })).body;
  const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}`;
  return { rt, ...dm, li, parent, sub, thread, path };
}

const is = (type: ThreadEvent["type"]) => (e: ThreadEvent) => e.type === type;
const delegation = (type: DelegationEvent["type"]) => (e: ThreadEvent) => e.type === "delegation" && e.event.type === type;
const background = (task: string) => ({ tools: [{ name: "delegate", args: { task, role: "scout", background: true } }] });

describe("delegation in lyricad", () => {
  it("streams a background run's events, and delivers its result into the live thread", async () => {
    const { rt, li, parent, sub, path, thread } = await setup();
    parent.reply(background("find the seed list"), { text: "I've sent a scout." });
    sub.reply({ text: "The seed list is in the shed." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "where's the seed list?" });
    await stream.until(is("notice"));
    const started = stream.events.find((e) => e.event.type === "delegation" && e.event.event.type === "started")!.event as Extract<ThreadEvent, { type: "delegation" }>;
    expect(started.event).toMatchObject({ parentThreadId: thread.id, role: "scout" });
    await stream.until(delegation("finished"));
    const notice = stream.events.find((e) => e.event.type === "notice")!.event;
    expect(notice).toMatchObject({ type: "notice", text: expect.stringContaining("The seed list is in the shed."), status: "finished" });
    stream.close();

    // Stored too, as a notice, and the subagent's thread lists under its parent with its usage.
    const page = (await li.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.filter((m) => m.role === "notice")).toEqual([
      expect.objectContaining({ parts: [expect.objectContaining({ type: "delegation", status: "finished", text: expect.stringContaining("in the shed") })] }),
    ]);
    const subs = (await li.get<Subagents>(`${path}/subagents`)).body;
    expect(subs.runs).toEqual([expect.objectContaining({ role: "scout", status: "finished", thread: started.event.threadId })]);
    expect(subs.usage.inputTokens).toBeGreaterThan(0);
    const list = (await li.get<ThreadSummary[]>(`/api/u/${rt.li.id}/threads`)).body;
    expect(list.find((t) => t.id === thread.id)!.children.map((c) => c.id)).toEqual([started.event.threadId]);

    // Her next turn sees the result.
    parent.reply({ text: "It's in the shed." });
    const next = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "so?" });
    await next.until(is("turn_end"));
    next.close();
    expect(JSON.stringify(parent.requests.at(-1)!.messages)).toContain("The seed list is in the shed.");
  });

  it("Lock stops the user's runs", async () => {
    const { rt, base, li, parent, sub, path } = await setup();
    parent.reply(background("ask me something"), { text: "Sent." });
    sub.reply({ tools: [{ name: "ask_parent", args: { question: "Which shed?" } }] });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "go" });
    await stream.until(delegation("question"));
    stream.close();
    await li.post(`/api/u/${rt.li.id}/lock`);
    const again = await login(base, "li", "pw");
    const subs = (await again.get<Subagents>(`${path}/subagents`)).body;
    expect(subs.runs.map((r) => r.status)).toEqual(["stopped"]);
  });

  it("forgetting a parent forgets its subagents' threads and records", async () => {
    const { rt, li, parent, sub, path } = await setup();
    parent.reply(background("look around"), { text: "Sent." });
    sub.reply({ text: "Done looking." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "look around" });
    await stream.until(delegation("finished"));
    const child = (stream.events.find((e) => e.event.type === "delegation")!.event as Extract<ThreadEvent, { type: "delegation" }>).event.threadId;
    stream.close();

    expect((await li.del(path)).status).toBe(200);
    expect((await li.get(`/api/u/${rt.li.id}/threads/general/${enc(child)}`)).status).toBe(404);
    const all = (await li.get<ThreadSummary[]>(`/api/u/${rt.li.id}/threads?all=1`)).body;
    expect(all).toEqual([]);
  });

  it("keeps roles and saved workflows per user", async () => {
    const { rt, li } = await setup();
    const roles = `/api/u/${rt.li.id}/roles`;
    const put = await li.put<{ name: string; custom: boolean }[]>(`${roles}/gardener`, {
      description: "Knows plants", prompt: "You know plants.", tier: "cheap", tools: ["read"], readOnly: true, thinking: "off",
    });
    expect(put.body.find((r) => r.name === "gardener")).toMatchObject({ custom: true });
    expect(put.body.find((r) => r.name === "scout")).toMatchObject({ custom: false });
    expect((await li.put(`${roles}/Bad Name`, { prompt: "x", tier: "cheap", tools: [], thinking: "off" })).status).toBe(400);
    expect((await li.del<{ name: string }[]>(`${roles}/gardener`)).body.map((r) => r.name)).not.toContain("gardener");

    const flows = `/api/u/${rt.li.id}/workflows`;
    const saved = await li.put<{ name: string }[]>(`${flows}/review`, { description: "Write then check", spec: { loop: { task: "{input}" } } });
    expect(saved.body.map((w) => w.name)).toEqual(["review"]);
    expect((await li.put(`${flows}/empty`, { description: "", spec: { chain: [] } })).status).toBe(400);
  });
});
