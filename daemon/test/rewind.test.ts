import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { EndpointInfo, MessagePage, RewindResponse, ThreadEvent, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** Li with a local chat model, subagent models on a second server, and one general thread. */
async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }, { id: "other" }] });
  const sub = await fakeOpenAI({ label: "sub", models: [{ id: "sub-model" }] });
  await localModel(li, rt.li.id, model.baseUrl);
  await li.post(`/api/u/${rt.li.id}/endpoints`, { name: "subs", kind: "local", baseUrl: sub.baseUrl });
  for (const task of ["subagent.cheap", "subagent.strong"]) await li.put(`/api/u/${rt.li.id}/profiles/cloud/${task}`, { model: { endpointId: "subs", modelId: "sub-model" } });
  const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "Garden" })).body;
  const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}`;
  const stream = li.events(`${path}/events`);
  await stream.ready;
  /** Sends a message and waits for its turn to end. */
  const say = async (text: string) => {
    const from = stream.events.length;
    expect((await li.post(`${path}/messages`, { text })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
  };
  const messages = async () => (await li.get<MessagePage>(`${path}/messages`)).body.messages;
  const said = async () => (await messages()).map((m) => `${m.role}: ${m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`);
  return { rt, ...dm, li, model, sub, thread, path, stream, say, messages, said };
}

const turnEnd = (e: ThreadEvent) => e.type === "turn_end";

describe("rewinding a thread", () => {
  it("regenerates a reply: it and what followed go, and the question is asked again", async () => {
    const { li, model, path, stream, say, messages, said, logs } = await setup();
    model.reply({ text: "Tulips." }, { text: "In bed two." }, { text: "Daffodils." });
    await say("what should I plant?");
    await say("where?");
    const reply = (await messages()).find((m) => m.role === "assistant")!;

    const from = stream.events.length;
    const r = await li.post<RewindResponse>(`${path}/messages/${reply.n}/rewind`, { action: "regenerate" });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBeGreaterThan(2);
    await stream.until(turnEnd, from);
    expect(stream.events.slice(from).map((e) => e.event.type)).toContain("rewound");
    expect(await said()).toEqual(["user: what should I plant?", "assistant: Daffodils."]);
    // The model saw the question once, without the old answers.
    const sent = JSON.stringify(model.requests.at(-1)!.messages);
    expect(sent).not.toContain("Tulips.");
    expect(sent).not.toContain("where?");
    expect(sent.split("what should I plant?").length).toBe(2);
    expect(logs.join("\n")).not.toMatch(/plant|Tulips|Daffodils/);
  });

  it("regenerates with another model the thread may use, and refuses a cloud one in a local-only thread", async () => {
    const { rt, li, model, path, stream, say, messages, said } = await setup();
    const cloud = (await li.post<EndpointInfo>(`/api/u/${rt.li.id}/endpoints`, { name: "cloud", kind: "cloud", baseUrl: model.baseUrl })).body;
    const gpu = (await li.get<EndpointInfo[]>(`/api/u/${rt.li.id}/endpoints`)).body.find((e) => e.name === "gpu")!;
    const offering = (ep: EndpointInfo, id: string) => ({ offeringId: ep.models.find((m) => m.modelId === id)!.id });
    await li.patch(`${path}/settings`, { localOnly: true });
    model.reply({ text: "One." });
    await say("count");
    const reply = (await messages()).find((m) => m.role === "assistant")!;

    const refused = await li.post(`${path}/messages/${reply.n}/rewind`, { action: "regenerate", model: offering(cloud, "qwen3.8-27b") });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/cloud model/);
    expect(await said()).toEqual(["user: count", "assistant: One."]);

    model.reply({ text: "Two." });
    const from = stream.events.length;
    expect((await li.post(`${path}/messages/${reply.n}/rewind`, { action: "regenerate", model: offering(gpu, "other") })).status).toBe(200);
    await stream.until(turnEnd, from);
    expect(model.requests.at(-1)!.model).toBe("other");
    expect(await said()).toEqual(["user: count", "assistant: Two."]);
    expect((await li.get<ThreadSettings>(`${path}/settings`)).body.models.chat.model).toEqual(offering(gpu, "other"));
  });

  it("edits a message, and deletes the last turn again and again", async () => {
    const { li, model, path, stream, say, messages, said } = await setup();
    model.reply({ text: "A." }, { text: "B." }, { text: "C." }, { text: "B2." });
    await say("one");
    await say("two");
    await say("three");
    const two = (await messages()).find((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "two"))!;

    const from = stream.events.length;
    expect((await li.post(`${path}/messages/${two.n}/rewind`, { action: "edit", text: "two, edited" })).status).toBe(200);
    await stream.until(turnEnd, from);
    expect(await said()).toEqual(["user: one", "assistant: A.", "user: two, edited", "assistant: B2."]);

    for (const left of [["user: one", "assistant: A."], []]) {
      const last = (await messages()).filter((m) => m.role === "user").at(-1)!;
      expect((await li.post(`${path}/messages/${last.n}/rewind`, { action: "delete" })).status).toBe(200);
      expect(await said()).toEqual(left);
    }
    // She goes on from what's left.
    model.reply({ text: "Fresh." });
    await say("again");
    expect(await said()).toEqual(["user: again", "assistant: Fresh."]);
    expect((await li.post(`${path}/messages/1/rewind`, { action: "edit", text: " " })).status).toBe(400);
  });

  it("removes a note written in a removed turn, flags a page citing it, and stops its subagent", async () => {
    const { rt, d, li, model, sub, path, thread, stream, say, messages, said } = await setup();
    model.reply({ tools: [{ name: "remember", args: { notes: [{ text: "{user} keeps bees" }] } }] }, { text: "Noted." });
    await say("I keep bees");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sub.respond(async () => { await gate; return { text: "late" }; });
    model.reply({ tools: [{ name: "delegate", args: { task: "count the hives", role: "scout", background: true } }] }, { text: "Sent a scout." });
    await say("count the hives");
    await stream.until((e) => e.type === "delegation" && e.event.type === "started");
    const child = (stream.events.find((e) => e.event.type === "delegation")!.event as Extract<ThreadEvent, { type: "delegation" }>).event.threadId;

    const view = d.services!.memory.openThreadView(rt.li.id, "general");
    const note = view.own.search("bees", { kinds: ["note"] })[0]!.id;
    view.own.putPage({ slug: "bees", title: "Bees", summary: "x", text: `Li keeps bees [${note}].` }, "sleep");
    view.close();

    const first = (await messages()).find((m) => m.role === "user")!;
    const r = await li.post<RewindResponse>(`${path}/messages/${first.n}/rewind`, { action: "delete" });
    release();
    expect(r.body).toMatchObject({ subagents: 1 });
    expect(await said()).toEqual([]);
    const after = d.services!.memory.openThreadView(rt.li.id, "general");
    expect(after.own.get(note)).toBeUndefined();
    expect(after.own.get("p:bees")!.flagged).toBe(true);
    expect(after.own.getThread(child)).toBeUndefined();
    expect(after.own.getThread(thread.id)).toBeDefined();
    after.close();
    expect(d.services!.delegation.store.runs(rt.li.id, "general", { parent: thread.id })).toEqual([]);
  });

  it("refuses while a turn runs", async () => {
    const { li, model, path, say, messages } = await setup();
    model.reply({ text: "A." });
    await say("one");
    let release!: () => void;
    model.respond(async () => { await new Promise<void>((r) => (release = r)); return { text: "slow" }; });
    await li.post(`${path}/messages`, { text: "two" });
    const r = await li.post(`${path}/messages/1/rewind`, { action: "delete" });
    expect(r.status).toBe(409);
    release();
    expect((await messages()).length).toBeGreaterThan(0);
  });
});

describe("branching a thread", () => {
  it("copies the turns up to a message into a nested child with the parent's settings", async () => {
    const { rt, li, model, path, thread, say, messages } = await setup();
    await li.patch(`${path}/settings`, { localOnly: true, unlogged: true });
    model.reply({ text: "A." }, { text: "B." });
    await say("one");
    await say("two");
    const a = (await messages()).find((m) => m.role === "assistant")!;

    const r = await li.post<ThreadSummary>(`${path}/messages/${a.n}/branch`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ parent: thread.id, title: "Garden (branch)", unlogged: true, subagent: false });
    const bpath = `/api/u/${rt.li.id}/threads/general/${enc(r.body.id)}`;
    const branch = (await li.get<MessagePage>(`${bpath}/messages`)).body.messages;
    expect(branch.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((await messages()).length).toBe(4);
    const settings = (await li.get<ThreadSettings>(`${bpath}/settings`)).body;
    expect(settings).toMatchObject({ localOnly: true, unlogged: true });
    // It can't be made wider than its parent.
    expect((await li.patch(`${bpath}/settings`, { localOnly: false })).status).toBe(400);
    expect((await li.patch(`${bpath}/settings`, { unlogged: false })).status).toBe(400);
    const list = (await li.get<ThreadSummary[]>(`/api/u/${rt.li.id}/threads`)).body;
    expect(list.find((t) => t.id === thread.id)!.children.map((c) => c.id)).toEqual([r.body.id]);
  });
});
