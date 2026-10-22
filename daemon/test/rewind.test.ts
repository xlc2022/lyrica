import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { EndpointInfo, MessagePage, Pins, RemovalPlan, RewindResponse, ThreadEvent, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const has = (cmd: string) => { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };
const homeRunnable = process.getuid?.() !== 0 && has("bwrap") && has("gocryptfs") && has("fusermount3") && existsSync("/dev/fuse");

/** Ada with a local chat model, subagent models on a second server, and one general thread. */
async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }, { id: "other" }] });
  const sub = await fakeOpenAI({ label: "sub", models: [{ id: "sub-model" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  await ada.post(`/api/u/${rt.ada.id}/endpoints`, { name: "subs", kind: "local", baseUrl: sub.baseUrl });
  for (const task of ["subagent.cheap", "subagent.strong"]) await ada.put(`/api/u/${rt.ada.id}/columns/general/${task}`, { model: { endpointId: "subs", modelId: "sub-model" } });
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Garden" })).body;
  const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  /** Sends a message and waits for its turn to end. */
  const say = async (text: string) => {
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
  };
  const messages = async () => (await ada.get<MessagePage>(`${path}/messages`)).body.messages;
  const said = async () => (await messages()).map((m) => `${m.role}: ${m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`);
  return { rt, ...dm, ada, model, sub, thread, path, stream, say, messages, said };
}

const turnEnd = (e: ThreadEvent) => e.type === "turn_end";

describe("rewinding a thread", () => {
  it("regenerates a reply: it and what followed go, and the question is asked again", async () => {
    const { ada, model, path, stream, say, messages, said, logs } = await setup();
    model.reply({ text: "Tulips." }, { text: "In bed two." }, { text: "Daffodils." });
    await say("what should I plant?");
    await say("where?");
    const reply = (await messages()).find((m) => m.role === "assistant")!;

    const from = stream.events.length;
    const r = await ada.post<RewindResponse>(`${path}/messages/${reply.n}/rewind`, { action: "regenerate" });
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
    const { rt, ada, model, path, stream, say, messages, said } = await setup();
    const cloud = (await ada.post<EndpointInfo>(`/api/u/${rt.ada.id}/endpoints`, { name: "cloud", kind: "cloud", baseUrl: model.baseUrl })).body;
    const gpu = (await ada.get<EndpointInfo[]>(`/api/u/${rt.ada.id}/endpoints`)).body.find((e) => e.name === "gpu")!;
    const offering = (ep: EndpointInfo, id: string) => ({ offeringId: ep.models.find((m) => m.modelId === id)!.id });
    await ada.patch(`${path}/settings`, { localOnly: true });
    model.reply({ text: "One." });
    await say("count");
    const reply = (await messages()).find((m) => m.role === "assistant")!;

    const refused = await ada.post(`${path}/messages/${reply.n}/rewind`, { action: "regenerate", model: offering(cloud, "qwen3.8-27b") });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/cloud model/);
    expect(await said()).toEqual(["user: count", "assistant: One."]);

    model.reply({ text: "Two." });
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages/${reply.n}/rewind`, { action: "regenerate", model: offering(gpu, "other") })).status).toBe(200);
    await stream.until(turnEnd, from);
    expect(model.requests.at(-1)!.model).toBe("other");
    expect(await said()).toEqual(["user: count", "assistant: Two."]);
    expect((await ada.get<ThreadSettings>(`${path}/settings`)).body.models.chat.model).toEqual(offering(gpu, "other"));
  });

  it("edits a message, and deletes the last turn again and again", async () => {
    const { ada, model, path, stream, say, messages, said } = await setup();
    model.reply({ text: "A." }, { text: "B." }, { text: "C." }, { text: "B2." });
    await say("one");
    await say("two");
    await say("three");
    const two = (await messages()).find((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "two"))!;

    const from = stream.events.length;
    expect((await ada.post(`${path}/messages/${two.n}/rewind`, { action: "edit", text: "two, edited" })).status).toBe(200);
    await stream.until(turnEnd, from);
    expect(await said()).toEqual(["user: one", "assistant: A.", "user: two, edited", "assistant: B2."]);

    for (const left of [["user: one", "assistant: A."], []]) {
      const last = (await messages()).filter((m) => m.role === "user").at(-1)!;
      expect((await ada.post(`${path}/messages/${last.n}/rewind`, { action: "delete" })).status).toBe(200);
      expect(await said()).toEqual(left);
    }
    // She goes on from what's left.
    model.reply({ text: "Fresh." });
    await say("again");
    expect(await said()).toEqual(["user: again", "assistant: Fresh."]);
    expect((await ada.post(`${path}/messages/1/rewind`, { action: "edit", text: " " })).status).toBe(400);
  });

  it("removes a note written in a removed turn, flags a page citing it, and stops its subagent", async () => {
    const { rt, d, ada, model, sub, path, thread, stream, say, messages, said } = await setup();
    model.reply({ tools: [{ name: "remember", args: { notes: [{ text: "{user} keeps bees" }] } }] }, { text: "Noted." });
    await say("I keep bees");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sub.respond(async () => { await gate; return { text: "late" }; });
    model.reply({ tools: [{ name: "delegate", args: { task: "count the hives", role: "scout", background: true } }] }, { text: "Sent a scout." });
    await say("count the hives");
    await stream.until((e) => e.type === "delegation" && e.event.type === "started");
    const child = (stream.events.find((e) => e.event.type === "delegation")!.event as Extract<ThreadEvent, { type: "delegation" }>).event.threadId;

    const view = d.services!.memory.openThreadView(rt.ada.id, "general");
    const note = view.own.search("bees", { kinds: ["note"] })[0]!.id;
    view.own.putPage({ slug: "bees", title: "Bees", summary: "x", text: `Ada keeps bees [${note}].` }, "sleep");
    view.close();

    const first = (await messages()).find((m) => m.role === "user")!;
    const r = await ada.post<RewindResponse>(`${path}/messages/${first.n}/rewind`, { action: "delete" });
    release();
    expect(r.body).toMatchObject({ subagents: 1 });
    expect(await said()).toEqual([]);
    const after = d.services!.memory.openThreadView(rt.ada.id, "general");
    expect(after.own.get(note)).toBeUndefined();
    expect(after.own.get("p:bees")!.flagged).toBe(true);
    expect(after.own.getThread(child)).toBeUndefined();
    expect(after.own.getThread(thread.id)).toBeDefined();
    after.close();
    expect(d.services!.delegation.store.runs(rt.ada.id, "general", { parent: thread.id })).toEqual([]);
  });

  it("refuses while a turn runs", async () => {
    const { ada, model, path, say, messages } = await setup();
    model.reply({ text: "A." });
    await say("one");
    let release!: () => void;
    model.respond(async () => { await new Promise<void>((r) => (release = r)); return { text: "slow" }; });
    await ada.post(`${path}/messages`, { text: "two" });
    const r = await ada.post(`${path}/messages/1/rewind`, { action: "delete" });
    expect(r.status).toBe(409);
    release();
    expect((await messages()).length).toBeGreaterThan(0);
  });
});

describe("pinning a message", () => {
  it("puts it in her prompt word for word, keeps it in a branch, and counts it when its turn is removed", async () => {
    const { ada, model, path, say, messages } = await setup();
    model.reply({ text: "Noted." }, { text: "Sure." }, { text: "Again." });
    await say("the gate code is 4417");
    await say("thanks");
    const [code, reply] = await messages();
    expect((await ada.put(`${path}/messages/${code!.n}/pin`, {})).status).toBe(200);
    expect((await messages())[0]!.pinned).toBe(true);
    expect((await ada.get<Pins>(`${path}/pins`)).body).toEqual({ pins: [expect.objectContaining({ n: code!.n, role: "user", text: "the gate code is 4417" })], shortened: false });

    await say("what was it?");
    // The top stays as the model has it, so its cache holds: the pin comes in the turn's messages.
    const [before, now] = model.requests.slice(-2);
    expect(now!.messages[0]).toEqual(before!.messages[0]);
    expect(JSON.stringify(now!.messages.slice(1))).toContain("User: the gate code is 4417");

    const branch = (await ada.post<{ id: string }>(`${path}/messages/${reply!.n}/branch`, {})).body;
    expect((await ada.get<Pins>(path.replace(/[^/]+$/, encodeURIComponent(branch.id)) + "/pins")).body.pins).toHaveLength(1);
    expect((await ada.post<RewindResponse>(`${path}/messages/${code!.n}/rewind`, { action: "delete" })).body).toMatchObject({ pins: 1 });
    expect((await ada.get<Pins>(`${path}/pins`)).body.pins).toEqual([]);
  });

  it("refuses a message that isn't there, and an entry that isn't a message", async () => {
    const { ada, model, path, say, messages } = await setup();
    model.reply({ text: "A." });
    await say("one");
    const first = (await messages())[0]!;
    expect(first.n).toBeGreaterThan(1); // Pi's own entries come first
    expect((await ada.put(`${path}/messages/1/pin`, {})).status).toBe(400);
    expect((await ada.put(`${path}/messages/99/pin`, {})).status).toBe(404);
    expect((await ada.del(`${path}/messages/${first.n}/pin`)).status).toBe(200);
  });
});

describe("removing turns that did things", () => {
  it("previews what goes without changing anything, and lists commands and pins", async () => {
    const { ada, model, path, say, messages, said } = await setup();
    model.reply({ tools: [{ name: "bash", args: { command: "git switch -c tidy && echo done" } }] }, { text: "Ran it." });
    await say("tidy up");
    const first = (await messages())[0]!;
    await ada.put(`${path}/messages/${first.n}/pin`, {});
    const before = await said();

    const plan = (await ada.post<RemovalPlan>(`${path}/messages/${first.n}/rewind`, { action: "delete", preview: true })).body;
    expect(plan).toMatchObject({ pins: 1, subagents: 0, commands: ["git switch -c tidy && echo done"] });
    expect(plan.messages).toBeGreaterThan(1);
    expect(await said()).toEqual(before);
    expect((await ada.post<RewindResponse>(`${path}/messages/${first.n}/rewind`, { action: "delete", skip: ["nothing"] })).body).toMatchObject({ pins: 1, files: 0, branches: 0 });
    expect(await said()).toEqual([]);
  });
});

describe.skipIf(!homeRunnable)("removing turns that changed files", () => {
  it("deletes what they made, puts back what they changed, keeps what changed since, and the sweep clears snapshots", async () => {
    const { rt, d, ada, model, path, thread, say, messages, logs } = await setup();
    const call = (p: string, content: string) => ({ name: "write", args: { path: `/workspace/${p}`, content } });
    model.reply({ tools: [call("base.txt", "v1")] }, { text: "Wrote v1." });
    await say("write base");
    model.reply({ tools: [call("base.txt", "v2"), call("new.txt", "fresh"), call("other.txt", "hers")] }, { text: "Wrote more." });
    await say("write more");
    const dir = d.services!.workspace.threadDir({ userId: rt.ada.id, pool: "general", threadId: thread.id });
    writeFileSync(join(dir, "other.txt"), "someone else's");

    const second = (await messages()).filter((m) => m.role === "user")[1]!;
    const plan = (await ada.post<RemovalPlan>(`${path}/messages/${second.n}/rewind`, { action: "delete", preview: true })).body;
    expect(plan.files.map(({ path: p, action, ticked }) => [p, action, ticked]).sort()).toEqual([
      ["/workspace/base.txt", "restore", true],
      ["/workspace/new.txt", "delete", true],
      ["/workspace/other.txt", "keep", false],
    ]);
    expect((await ada.post<RewindResponse>(`${path}/messages/${second.n}/rewind`, { action: "delete" })).body).toMatchObject({ files: 2 });
    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("v1");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(readFileSync(join(dir, "other.txt"), "utf8")).toBe("someone else's");

    // base.txt's first write is still undoable; a month on, the sweep clears it, and logs counts only.
    d.sweep(new Date(Date.now() + 31 * 864e5));
    expect(logs.find((l) => l.startsWith("sweep:"))).toMatch(/^sweep: \d+ snapshots, 1 change records, \d+ thread folders, \d+ worktrees removed$/);
    expect(logs.join("\n")).not.toMatch(/base\.txt|v1|fresh/);
  });
});

describe("branching a thread", () => {
  it("copies the turns up to a message into a nested child with the parent's settings", async () => {
    const { rt, ada, model, path, thread, say, messages } = await setup();
    await ada.patch(`${path}/settings`, { localOnly: true, unlogged: true });
    model.reply({ text: "A." }, { text: "B." });
    await say("one");
    await say("two");
    const a = (await messages()).find((m) => m.role === "assistant")!;

    const r = await ada.post<ThreadSummary>(`${path}/messages/${a.n}/branch`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ parent: thread.id, title: "Garden (branch)", unlogged: true, subagent: false });
    const bpath = `/api/u/${rt.ada.id}/threads/general/${enc(r.body.id)}`;
    const branch = (await ada.get<MessagePage>(`${bpath}/messages`)).body.messages;
    expect(branch.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((await messages()).length).toBe(4);
    const settings = (await ada.get<ThreadSettings>(`${bpath}/settings`)).body;
    expect(settings).toMatchObject({ localOnly: true, unlogged: true });
    // It can't be made wider than its parent.
    expect((await ada.patch(`${bpath}/settings`, { localOnly: false })).status).toBe(400);
    expect((await ada.patch(`${bpath}/settings`, { unlogged: false })).status).toBe(400);
    const list = (await ada.get<ThreadSummary[]>(`/api/u/${rt.ada.id}/threads`)).body;
    expect(list.find((t) => t.id === thread.id)!.children.map((c) => c.id)).toEqual([r.body.id]);
  });
});
