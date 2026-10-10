import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { CallInfo, MessagePage, ThreadEvent, ThreadSettings, ThreadSummary, UploadResponse } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** An unlocked lyricad, Li logged in, a local model, and one general thread. */
async function setup(opts: Parameters<typeof daemon>[1] = {}, title: string | null = "test thread") {
  const rt = await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(li, rt.li.id, model.baseUrl);
  const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", ...(title ? { title } : {}) })).body;
  const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}`;
  return { rt, ...dm, li, model, thread, path };
}

const is = (type: ThreadEvent["type"]) => (e: ThreadEvent) => e.type === type;

describe("a conversation", () => {
  it("streams a reply, stores it, and still has it after a restart", async () => {
    const { rt, li, model, path, stop } = await setup();
    model.reply({ text: "Hello, Li." });
    await li.post(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "newer" });
    const stream = li.events(`${path}/events`);
    await stream.ready;
    const sent = await li.post(`${path}/messages`, { text: "hi there" });
    expect(sent.body).toEqual({ queued: false });
    await stream.until(is("turn_end"));
    const types = stream.events.map((e) => e.event.type);
    expect(types).toEqual(expect.arrayContaining(["hello", "turn_start", "message_start", "text", "usage", "turn_end"]));
    expect(stream.events.filter((e) => e.event.type === "text").map((e) => (e.event as { delta: string }).delta).join("")).toBe("Hello, Li.");
    stream.close();

    // The thread with recent activity comes first, ahead of a newer, quiet one.
    const list = (await li.get<ThreadSummary[]>(`/api/u/${rt.li.id}/threads`)).body;
    expect(list.map((x) => x.title)).toEqual(["test thread", "newer"]);
    expect(list[0]!.updatedAt > list[0]!.createdAt).toBe(true);

    const page = (await li.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.map((m) => [m.role, m.parts.find((p) => p.type === "text")])).toEqual([
      ["user", { type: "text", text: "hi there" }],
      ["assistant", { type: "text", text: "Hello, Li." }],
    ]);

    await stop();
    const again = await daemon(rt);
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    const li2 = await login(again.base, "li", "pw");
    const after = (await li2.get<MessagePage>(`${path}/messages`)).body;
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("titles a thread after the first exchange, with the title model", async () => {
    const { li, model, path } = await setup({}, null);
    model.reply({ text: "Sure." }, { text: "Planning the garden" });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "let's plan the garden" });
    await stream.until(is("title"));
    expect(stream.events.find((e) => e.event.type === "title")!.event).toEqual({ type: "title", title: "Planning the garden" });
    expect((await li.get<ThreadSummary>(path)).body.title).toBe("Planning the garden");
    stream.close();
  });

  it("replays missed events to a stream that reconnects with Last-Event-ID", async () => {
    const { li, model, path } = await setup();
    model.reply({ text: "one" });
    const first = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "first" });
    await first.until(is("turn_end"));
    const turnStart = first.events.find((e) => e.event.type === "turn_start")!;
    first.close();

    // Reconnecting from the turn's start gets the rest of that turn back.
    const again = li.events(`${path}/events`, turnStart.id);
    await again.until(is("hello"));
    const replayed = again.events.map((e) => e.event.type);
    expect(replayed.slice(0, replayed.indexOf("hello"))).toEqual(first.events.slice(first.events.indexOf(turnStart) + 1).map((e) => e.event.type));
    again.close();

    // An ID from another run of lyricad can't be replayed: the stream says reset.
    const stale = li.events(`${path}/events`, "deadbeef-3");
    await stale.until(is("hello"));
    expect(stale.events[0]!.event.type).toBe("reset");
    stale.close();
  });

  it("queues a message sent during a turn and runs it next", async () => {
    const { li, model, path } = await setup({ permissionMs: 5_000 });
    await li.patch(`${path}/settings`, { mode: "ask-commands" });
    model.reply({ tools: [{ name: "bash", args: { command: "true" } }] }, { text: "done" }, { text: "second answer" });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "run it" });
    await stream.until(is("permission"));
    // The turn is waiting on a permission: a new message waits as a follow-up.
    expect((await li.post(`${path}/messages`, { text: "and then this" })).body).toEqual({ queued: true });
    const request = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string };
    await li.post(`${path}/permissions/${request.requestId}`, { allow: false });
    await stream.until((e) => e.type === "text" && e.delta === "second answer");
    await stream.until(is("turn_end"), stream.events.findIndex((e) => e.event.type === "text" && (e.event as { delta: string }).delta === "second answer"));
    const users = (await li.get<MessagePage>(`${path}/messages`)).body.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.parts[0])).toEqual([{ type: "text", text: "run it" }, { type: "text", text: "and then this" }]);
    stream.close();
  });
});

describe("idle threads", () => {
  it("are dropped with their event buffer; a stream that comes back is told to reset", async () => {
    const { li, model, path } = await setup({ idleMs: 200 });
    model.reply({ text: "hi" });
    const first = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "hello" });
    await first.until(is("turn_end"));
    const last = first.events.at(-1)!.id;
    first.close();
    await new Promise((r) => setTimeout(r, 600));
    const again = li.events(`${path}/events`, last);
    await again.until(is("hello"));
    expect(again.events[0]!.event.type).toBe("reset");
    again.close();
  });
});

describe("permission prompts", () => {
  it("in an ask mode, bash waits for approval, and deny stops it", async () => {
    const { li, model, path } = await setup();
    await li.patch(`${path}/settings`, { mode: "ask-commands" });
    model.reply({ tools: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "I won't, then." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "run echo" });
    await stream.until(is("permission"));
    const request = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string; tool: string; args: unknown };
    expect(request).toMatchObject({ tool: "bash", args: { command: "echo hi" } });
    // Waiting: the model hasn't been asked again yet.
    expect(model.requests).toHaveLength(1);
    // A view that opens now sees the waiting request.
    const late = li.events(`${path}/events`);
    await late.until(is("hello"));
    expect((late.events[0]!.event as { permissions: unknown[] }).permissions).toHaveLength(1);
    late.close();

    await li.post(`${path}/permissions/${request.requestId}`, { allow: false });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "answered" });
    expect(stream.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ name: "bash", isError: true });
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("Not approved");
    // Answering again is refused: it's no longer waiting.
    expect((await li.post(`${path}/permissions/${request.requestId}`, { allow: true })).status).toBe(404);
    stream.close();
  });

  it("denies when nobody answers in time", async () => {
    const { li, model, path } = await setup({ permissionMs: 300 });
    await li.patch(`${path}/settings`, { mode: "ask-changes" });
    model.reply({ tools: [{ name: "write", args: { path: "/workspace/a.txt", content: "x" } }] }, { text: "ok" });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "write a file" });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "timeout" });
    stream.close();
  });

  it("Stop aborts the turn and denies a waiting request", async () => {
    const { li, model, path } = await setup();
    await li.patch(`${path}/settings`, { mode: "ask-commands" });
    model.reply({ tools: [{ name: "bash", args: { command: "sleep 100" } }] });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "go" });
    await stream.until(is("permission"));
    await li.post(`${path}/stop`);
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "stopped" });
    stream.close();
  });
});

describe("the thread's model", () => {
  it("shows the profile, the thinking levels on offer and which model answered; recent calls hold no prompt text", async () => {
    const { rt, li, model, path, thread } = await setup();
    model.reply({ text: "A reply about Miso." });
    const stream = li.events(`${path}/events`);
    await stream.ready;
    await li.post(`${path}/messages`, { text: "tell me about Miso the cat" });
    await stream.until(is("turn_end"));
    stream.close();
    const settings = (await li.get<ThreadSettings>(`${path}/settings`)).body;
    expect(settings).toMatchObject({ profile: "custom", profileChoice: null, thinking: "off", thinkingLevels: ["off"], answered: { label: "gpu/qwen3.8-27b", kind: "local", task: "chat" } });
    const calls = (await li.get<CallInfo[]>(`/api/u/${rt.li.id}/models/calls`)).body;
    expect(calls[0]).toMatchObject({ threadId: thread.id, label: "gpu/qwen3.8-27b" });
    expect(JSON.stringify(calls)).not.toMatch(/Miso/);

    expect((await li.patch<ThreadSettings>(`${path}/settings`, { thinking: "high", profile: "cloud" })).body).toMatchObject({ thinking: "high", profile: "cloud", profileChoice: "cloud" });
    const priv = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "private" })).body;
    const privPath = `/api/u/${rt.li.id}/threads/private/${enc(priv.id)}/settings`;
    expect((await li.patch(privPath, { profile: "custom" })).status).toBe(400);
    expect((await li.get<ThreadSettings>(privPath)).body.profile).toBe("local");
    // Forgetting the thread takes its call records with it.
    await li.del(path);
    expect((await li.get<CallInfo[]>(`/api/u/${rt.li.id}/models/calls`)).body.filter((c) => c.threadId === thread.id)).toEqual([]);
  });
});

describe("errors and logs", () => {
  it("reports a refused model in plain words, on the stream and in the response", async () => {
    const { li, path, rt } = await setup();
    await li.put(`/api/u/${rt.li.id}/profiles/custom/chat`, { model: null });
    const stream = li.events(`${path}/events`);
    await stream.ready;
    const sent = await li.post<{ error: string }>(`${path}/messages`, { text: "hello?" });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/no model is set for chat/i);
    await stream.until(is("error"));
    stream.close();
  });

  it("logs method, route, status and timing, and never message text", async () => {
    const { li, model, path, logs, rt } = await setup();
    const marker = "MARKER-7f3a9c";
    model.reply({ text: `reply ${marker}` });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: `please say ${marker}` });
    await stream.until(is("turn_end"));
    stream.close();
    await li.get(`${path}/messages`);
    await li.get(`/api/u/${rt.li.id}/memory/search?q=${marker}`);
    expect(logs.some((l) => /^POST \/api\/u\/:userId\/threads\/:pool\/:threadId\/messages 200 \d+ms$/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain(marker);
    expect(logs.join("\n")).not.toContain("hello");
  });
});

const has = (cmd: string) => { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };
const homeRunnable = process.getuid?.() !== 0 && has("bwrap") && has("gocryptfs") && has("fusermount3");

describe.skipIf(!homeRunnable)("uploads", () => {
  it("saves a file into uploads/, where her read can open it", async () => {
    const { li, model, path } = await setup();
    const up = await li.call<UploadResponse>("POST", `${path}/uploads?name=notes.txt`, Buffer.from("seed list: tomatoes"), { "content-type": "application/octet-stream" });
    expect(up.body).toEqual({ path: "/workspace/uploads/notes.txt" });
    model.reply({ tools: [{ name: "read", args: { path: up.body.path } }] }, { text: "Tomatoes." });
    const stream = li.events(`${path}/events`);
    await li.post(`${path}/messages`, { text: "what did I upload?" });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ name: "read", isError: false, result: expect.stringContaining("tomatoes") });
    stream.close();
    // Names are cleaned, not refused, and a name already taken gets a suffix instead of overwriting.
    const up2 = async (name: string) =>
      (await li.call<UploadResponse>("POST", `${path}/uploads?name=${enc(name)}`, Buffer.from("x"), { "content-type": "application/octet-stream" })).body.path;
    expect(await up2("notes.txt")).toBe("/workspace/uploads/notes-2.txt");
    expect(await up2("Li's résumé.pdf")).toBe("/workspace/uploads/Li's résumé.pdf");
    expect(await up2("../../etc/passwd")).toBe("/workspace/uploads/passwd");
  });
});
