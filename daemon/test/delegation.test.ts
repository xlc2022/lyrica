import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { DelegationEvent, EndpointInfo, MessagePage, PermissionRequest, Subagents, ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/**
 * Li with a thread whose chat model and subagent models are on two fake
 * servers, so the parent's and the subagents' scripted replies never mix.
 */
async function setup(opts: Parameters<typeof daemon>[1] = {}) {
  const rt = await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const parent = await fakeOpenAI({ label: "parent", models: [{ id: "chat-model" }] });
  const sub = await fakeOpenAI({ label: "sub", models: [{ id: "sub-model" }] });
  await localModel(li, rt.li.id, parent.baseUrl, "chat-model");
  const subs = (await li.post<EndpointInfo>(`/api/u/${rt.li.id}/endpoints`, { name: "subs", kind: "local", baseUrl: sub.baseUrl })).body;
  for (const task of ["subagent.cheap", "subagent.strong"]) await li.put(`/api/u/${rt.li.id}/profiles/custom/${task}`, { model: { offeringId: subs.models[0]!.id } });
  const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "parent" })).body;
  const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}`;
  return { rt, ...dm, li, parent, sub, thread, path };
}

const is = (type: ThreadEvent["type"]) => (e: ThreadEvent) => e.type === type;
const delegation = (type: DelegationEvent["type"]) => (e: ThreadEvent) => e.type === "delegation" && e.event.type === type;
const background = (task: string) => ({ tools: [{ name: "delegate", args: { task, role: "scout", background: true } }] });

describe("delegation in lyricad", () => {
  it("streams a background run's events, and delivers its result into the live thread", async () => {
    const { rt, d, li, parent, sub, path, thread } = await setup();
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
    // Subagents live in their delegate cards, not the thread list; a child thread (a fork) nests under its parent.
    const own = d.services!.memory.openThreadView(rt.li.id, "general");
    const fork = own.own.createThread({ interface: "web", parent: thread.id, title: "a fork" });
    own.close();
    const list = (await li.get<ThreadSummary[]>(`/api/u/${rt.li.id}/threads`)).body;
    expect(list.map((t) => t.id)).toEqual([thread.id]);
    expect(list[0]!.children.map((c) => c.id)).toEqual([fork.id]);

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
    // A model named by its label is saved by its offering ID, so renaming the endpoint breaks nothing.
    const named = await li.put<{ name: string; spec: { chain: { model?: string }[] } }[]>(`${flows}/named`, { description: "", spec: { chain: [{ task: "{input}", model: "subs/sub-model" }] } });
    const subs = (await li.get<EndpointInfo[]>(`/api/u/${rt.li.id}/endpoints`)).body.find((e) => e.name === "subs")!;
    expect(named.body.find((w) => w.name === "named")!.spec.chain[0]!.model).toBe(subs.models[0]!.id);
    expect((await li.put<{ error: string }>(`${flows}/nope`, { description: "", spec: { chain: [{ task: "x", model: "subs/nothing" }] } })).body.error).toMatch(/no model subs\/nothing/);
  });
});

describe("talking with subagents in lyricad", () => {
  const started = (stream: { events: { event: ThreadEvent }[] }) =>
    (stream.events.find((e) => e.event.type === "delegation" && e.event.event.type === "started")!.event as Extract<ThreadEvent, { type: "delegation" }>).event;
  const permission = (stream: { events: { event: ThreadEvent }[] }) => stream.events.find((e) => e.event.type === "permission")!.event as PermissionRequest;

  it("asks for a writer subagent's command in its thread and its parent's; the first answer wins", async () => {
    const { rt, li, parent, sub, path } = await setup();
    await li.patch(`${path}/settings`, { mode: "ask-commands" });
    parent.reply({ tools: [{ name: "delegate", args: { task: "run two commands", role: "worker", background: true } }] }, { text: "A worker is on it." });
    sub.respond((r) => {
      const results = r.messages.filter((m) => m.role === "tool").length;
      return results < 2 ? { tools: [{ name: "bash", args: { command: `echo ${results + 1}` } }] } : { text: "Ran what I could." };
    });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "start the worker" });
    await stream.until(is("permission"));
    const a = permission(stream);
    expect(a).toMatchObject({ tool: "bash", args: { command: "echo 1" }, subagent: { role: "worker", runId: expect.any(String), parentThreadId: expect.any(String) } });
    expect(a.subagent!.threadId).toBe(started(stream).threadId);
    expect(sub.requests).toHaveLength(1);

    // The subagent's own thread shows the same request, and either view may answer it.
    const childPath = `/api/u/${rt.li.id}/threads/general/${enc(a.subagent!.threadId)}`;
    const child = li.events(`${childPath}/events`);
    await child.until(is("hello"));
    expect((child.events[0]!.event as { permissions: PermissionRequest[] }).permissions.map((p) => p.requestId)).toEqual([a.requestId]);
    expect((await li.post(`${childPath}/permissions/${a.requestId}`, { allow: true })).status).toBe(200);
    expect((await li.post(`${path}/permissions/${a.requestId}`, { allow: false })).status).toBe(404);
    await stream.until((e) => e.type === "permission_end" && e.requestId === a.requestId);
    await child.until((e) => e.type === "permission_end" && e.requestId === a.requestId);
    for (const s of [stream, child]) expect(s.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: true, reason: "answered" });

    // The next is denied from the parent's view: that call alone is refused, and the subagent is told.
    await child.until((e) => e.type === "permission" && e.requestId !== a.requestId);
    const b = child.events.map((e) => e.event).find((e): e is Extract<ThreadEvent, { type: "permission" }> => e.type === "permission" && e.requestId !== a.requestId)!;
    expect(b.args).toEqual({ command: "echo 2" });
    await li.post(`${path}/permissions/${b.requestId}`, { allow: false });
    await stream.until((e) => e.type === "notice" && e.status === "finished");
    child.close();
    stream.close();
    const results = sub.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
    expect(results).toHaveLength(2);
    expect(results[0]).not.toContain("Not approved");
    expect(results[1]).toContain("Not approved");
  });

  it("refuses a subagent's call nobody answers in time", async () => {
    const { li, parent, sub, path } = await setup({ permissionMs: 300 });
    await li.patch(`${path}/settings`, { mode: "ask-changes" });
    parent.reply({ tools: [{ name: "delegate", args: { task: "write it", role: "worker" } }] }, { text: "Done." });
    sub.reply({ tools: [{ name: "write", args: { path: "/workspace/a.txt", content: "x" } }] }, { text: "Couldn't write it." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "write a file" });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "timeout" });
    expect(JSON.stringify(sub.requests[1]!.messages)).toContain("Not approved");
    stream.close();
  });

  it("takes a user's message in a subagent's thread to the subagent, as theirs, and tells the parent", async () => {
    const { rt, base, li, logs, parent, sub, path } = await setup();
    parent.reply(background("look around"), { text: "Sent." });
    sub.reply({ text: "Done looking." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "look around" });
    await stream.until(delegation("finished"));
    const childId = started(stream).threadId;
    const childPath = `/api/u/${rt.li.id}/threads/general/${enc(childId)}`;

    const marker = "MARKER-7731 check the attic too";
    sub.reply({ text: "The attic is empty." });
    expect((await li.post(`${childPath}/messages`, { text: marker })).body).toEqual({ queued: false });
    await stream.until((e) => e.type === "notice" && e.status === "user_message");
    await stream.until((e) => e.type === "notice" && e.status === "finished" && e.text.includes("The attic is empty."));
    stream.close();
    const told = JSON.stringify(sub.requests.at(-1)!.messages);
    expect(told).toContain("Li writes to you directly");
    expect(told).toContain(marker);
    expect(told).toContain("Done looking.");

    // Its thread shows who sent what; the parent has the note, linking to it.
    const messages = (await li.get<MessagePage>(`${childPath}/messages`)).body.messages;
    expect(messages.filter((m) => m.role === "user").map((m) => [m.from, (m.parts[0] as { text: string }).text])).toEqual([
      [{ kind: "lyrica" }, "look around"], [{ kind: "user", userId: rt.li.id, name: "Li" }, marker],
    ]);
    const notes = (await li.get<MessagePage>(`${path}/messages`)).body.messages.flatMap((m) => m.parts).filter((p) => p.type === "delegation" && p.status === "user_message");
    expect(notes).toEqual([expect.objectContaining({ threads: [{ pool: "general", id: childId }], text: expect.stringContaining(marker) })]);

    // Only someone who can open the parent may write there.
    const sam = await login(base, "sam", "pw2");
    expect((await sam.post(`/api/u/${rt.sam.id}/threads/general/${enc(childId)}/messages`, { text: "hi" })).status).toBe(404);
    expect((await sam.post(`${childPath}/messages`, { text: "hi" })).status).toBeGreaterThanOrEqual(401);
    expect(sub.requests.map((r) => JSON.stringify(r.messages)).join("")).not.toContain("\"hi\"");

    // No message text reaches the log.
    expect(logs.join("\n")).not.toContain("MARKER-7731");
  });
});
