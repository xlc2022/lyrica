import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { DelegationEvent, EndpointInfo, MessagePage, Subagents, ThreadEvent, ThreadSummary } from "../src/api.ts";
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
  const subs = (await li.post<EndpointInfo>(`/api/u/${rt.li.id}/endpoints`, { name: "subs", kind: "local", baseUrl: sub.baseUrl })).body;
  for (const task of ["subagent.cheap", "subagent.strong"]) await li.put(`/api/u/${rt.li.id}/profiles/cloud/${task}`, { model: { offeringId: subs.models[0]!.id } });
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
    // The stored delegate call and the delivered result name the subagent's thread, so their cards can open it.
    // (Live, a background call returns before its subagents exist; their `started` events carry each thread.)
    const ref = { pool: "general", id: started.event.threadId };
    const page = (await li.get<MessagePage>(`${path}/messages`)).body;
    const parts = page.messages.flatMap((m) => m.parts);
    expect(parts.find((p) => p.type === "tool" && p.name === "delegate")).toMatchObject({ threads: [ref] });
    expect(parts.find((p) => p.type === "delegation")).toMatchObject({ threads: [ref] });
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

  it("names a foreground run's subagent threads on the delegate call as it ends", async () => {
    const { li, parent, sub, path } = await setup();
    parent.reply({ tools: [{ name: "delegate", args: { task: "check the shed", role: "scout" } }] }, { text: "Checked." });
    sub.reply({ text: "Seeds found." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "check" });
    await stream.until(is("turn_end"));
    const child = (stream.events.find((e) => e.event.type === "delegation")!.event as Extract<ThreadEvent, { type: "delegation" }>).event.threadId;
    expect(stream.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ name: "delegate", threads: [{ pool: "general", id: child }] });
    stream.close();
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
    // Bad values are refused with the reason, never a 500.
    const ok = { description: "", prompt: "x", tier: "cheap", tools: [], readOnly: false, thinking: "off" };
    for (const [name, bad, why] of [
      ["Bad Name", {}, /role names/], ["x", { tier: "huge" }, /tier/], ["x", { thinking: "lots" }, /thinking/],
      ["x", { tier: undefined }, /tier/], ["x", { prompt: "" }, /prompt/], ["x", { tools: "read" }, /tools/],
    ] as const) {
      const r = await li.put<{ error: string }>(`${roles}/${encodeURIComponent(name)}`, { ...ok, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error).toMatch(why);
    }
    expect((await li.del<{ name: string }[]>(`${roles}/gardener`)).body.map((r) => r.name)).not.toContain("gardener");

    const flows = `/api/u/${rt.li.id}/workflows`;
    const saved = await li.put<{ name: string }[]>(`${flows}/review`, { description: "Write then check", spec: { loop: { task: "{input}" } } });
    expect(saved.body.map((w) => w.name)).toEqual(["review"]);
    expect((await li.put(`${flows}/empty`, { description: "", spec: { chain: [] } })).status).toBe(400);
  });
});
