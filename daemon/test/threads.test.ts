import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { fakeProxmox, TOKEN as PVE_TOKEN } from "../../core/test/fake-proxmox.ts";
import type { CallInfo, EndpointInfo, MachineInfo, MachineProbe, MemoryDetail, MessagePage, PermissionRequest, ThreadEvent, ThreadTombstone, ThreadSettings, ThreadSummary, UploadResponse } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** An unlocked lyricad, Ada logged in, a local model, and one general thread. */
async function setup(opts: Parameters<typeof daemon>[1] = {}, title: string | null = "test thread") {
  const rt = await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", ...(title ? { title } : {}) })).body;
  const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
  return { rt, ...dm, ada, model, thread, path };
}

const KEY = `SHA256:${"A".repeat(43)}`;
const is = (type: ThreadEvent["type"]) => (e: ThreadEvent) => e.type === type;

describe("a conversation", () => {
  it("streams a reply, stores it, and still has it after a restart", async () => {
    const { rt, ada, model, path, stop } = await setup();
    model.reply({ text: "Hello, Ada." });
    await ada.post(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "newer" });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    const sent = await ada.post(`${path}/messages`, { text: "hi there" });
    expect(sent.body).toEqual({ queued: false });
    await stream.until(is("turn_end"));
    const types = stream.events.map((e) => e.event.type);
    expect(types).toEqual(expect.arrayContaining(["hello", "turn_start", "message_start", "text", "usage", "turn_end"]));
    expect(stream.events.filter((e) => e.event.type === "text").map((e) => (e.event as { delta: string }).delta).join("")).toBe("Hello, Ada.");
    stream.close();

    // The thread with recent activity comes first, ahead of a newer, quiet one.
    const list = (await ada.get<ThreadSummary[]>(`/api/u/${rt.ada.id}/threads`)).body;
    expect(list.map((x) => x.title)).toEqual(["test thread", "newer"]);
    expect(list[0]!.updatedAt > list[0]!.createdAt).toBe(true);

    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.map((m) => [m.role, m.parts.find((p) => p.type === "text")])).toEqual([
      ["user", { type: "text", text: "hi there" }],
      ["assistant", { type: "text", text: "Hello, Ada." }],
    ]);

    await stop();
    const again = await daemon(rt);
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada2 = await login(again.base, "ada", "pw");
    const after = (await ada2.get<MessagePage>(`${path}/messages`)).body;
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("stores the user's message while the model hangs, and only once after it finishes", async () => {
    const { ada, model, path } = await setup();
    let finish!: (reply: { text: string }) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    model.reply(() => new Promise<{ text: string }>((resolve) => {
      finish = resolve;
      started();
    }));
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    try {
      expect((await ada.post(`${path}/messages`, { text: "keep this message" })).body).toEqual({ queued: false });
      await called;
      expect(stream.events.some((e) => e.event.type === "turn_end")).toBe(false);
      const before = (await ada.get<MessagePage>(`${path}/messages`)).body;
      expect(before.messages.map((m) => [m.role, m.parts])).toEqual([
        ["user", [{ type: "text", text: "keep this message" }]],
      ]);
      finish({ text: "Done." });
      await stream.until(is("turn_end"));
      const after = (await ada.get<MessagePage>(`${path}/messages`)).body;
      expect(after.messages.filter((m) => m.role === "user")).toEqual(before.messages);
      expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    } finally {
      finish?.({ text: "Done." });
      stream.close();
    }
  });

  it("keeps the user's message through a crash mid-turn, once, and never re-sends it by itself", async () => {
    const { rt, ada, model, path, stop } = await setup();
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    // The model never answers: lyricad stops in the middle of her turn.
    model.reply(() => { started(); return new Promise<{ text: string }>(() => {}); });
    expect((await ada.post(`${path}/messages`, { text: "keep this through a crash" })).body).toEqual({ queued: false });
    await called;
    const asked = model.requests.length;
    await stop();
    const again = await daemon(rt);
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada2 = await login(again.base, "ada", "pw");
    const after = (await ada2.get<MessagePage>(`${path}/messages`)).body;
    // Stopping mid-turn may leave her aborted, empty reply; the person's message is there exactly once.
    expect(after.messages.filter((m) => m.role === "user").map((m) => m.parts)).toEqual([[{ type: "text", text: "keep this through a crash" }]]);
    // No automatic re-send: the person retries it.
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests.length).toBe(asked);
    await again.stop();
  });

  it("titles a thread after the first exchange, with the title model", async () => {
    const { ada, model, path } = await setup({}, null);
    model.reply({ text: "Sure." }, { text: "Planning the garden" });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "let's plan the garden" });
    await stream.until(is("title"));
    expect(stream.events.find((e) => e.event.type === "title")!.event).toEqual({ type: "title", title: "Planning the garden" });
    expect((await ada.get<ThreadSummary>(path)).body.title).toBe("Planning the garden");
    stream.close();
  });

  it("replays missed events to a stream that reconnects with Last-Event-ID", async () => {
    const { ada, model, path } = await setup();
    model.reply({ text: "one" });
    const first = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "first" });
    await first.until(is("turn_end"));
    const turnStart = first.events.find((e) => e.event.type === "turn_start")!;
    first.close();

    // Reconnecting from the turn's start gets the rest of that turn back.
    const again = ada.events(`${path}/events`, turnStart.id);
    await again.until(is("hello"));
    const replayed = again.events.map((e) => e.event.type);
    expect(replayed.slice(0, replayed.indexOf("hello"))).toEqual(first.events.slice(first.events.indexOf(turnStart) + 1).map((e) => e.event.type));
    again.close();

    // An ID from another run of lyricad can't be replayed: the stream says reset.
    const stale = ada.events(`${path}/events`, "deadbeef-3");
    await stale.until(is("hello"));
    expect(stale.events[0]!.event.type).toBe("reset");
    stale.close();
  });

  it("queues a message sent during a turn and runs it next", async () => {
    const { ada, model, path } = await setup({ permissionMs: 5_000 });
    await ada.patch(`${path}/settings`, { mode: "acceptEdits" });
    model.reply({ tools: [{ name: "bash", args: { command: "true" } }] }, { text: "done" }, { text: "second answer" });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "run it" });
    await stream.until(is("permission"));
    // The turn is waiting on a permission: a new message waits as a follow-up.
    expect((await ada.post(`${path}/messages`, { text: "and then this" })).body).toEqual({ queued: true });
    const request = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string };
    await ada.post(`${path}/permissions/${request.requestId}`, { allow: false });
    await stream.until((e) => e.type === "text" && e.delta === "second answer");
    await stream.until(is("turn_end"), stream.events.findIndex((e) => e.event.type === "text" && (e.event as { delta: string }).delta === "second answer"));
    const users = (await ada.get<MessagePage>(`${path}/messages`)).body.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.parts[0])).toEqual([{ type: "text", text: "run it" }, { type: "text", text: "and then this" }]);
    stream.close();
  });
});

describe("idle threads", () => {
  it("are dropped with their event buffer; a stream that comes back is told to reset", async () => {
    const { ada, model, path } = await setup({ idleMs: 200 });
    model.reply({ text: "hi" });
    const first = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "hello" });
    await first.until(is("turn_end"));
    const last = first.events.at(-1)!.id;
    first.close();
    await new Promise((r) => setTimeout(r, 600));
    const again = ada.events(`${path}/events`, last);
    await again.until(is("hello"));
    expect(again.events[0]!.event.type).toBe("reset");
    again.close();
  });
});

describe("permission prompts", () => {
  it("in an ask mode, bash waits for approval, and deny stops it", async () => {
    const { ada, model, path } = await setup();
    await ada.patch(`${path}/settings`, { mode: "acceptEdits" });
    model.reply({ tools: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "I won't, then." });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "run echo" });
    await stream.until(is("permission"));
    const request = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string; tool: string; args: unknown };
    expect(request).toMatchObject({ tool: "bash", args: { command: "echo hi" } });
    // Waiting: the model hasn't been asked again yet.
    expect(model.requests).toHaveLength(1);
    // A view that opens now sees the waiting request.
    const late = ada.events(`${path}/events`);
    await late.until(is("hello"));
    expect((late.events[0]!.event as { permissions: unknown[] }).permissions).toHaveLength(1);
    late.close();

    await ada.post(`${path}/permissions/${request.requestId}`, { allow: false });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "answered" });
    expect(stream.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ name: "bash", isError: true });
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("Not approved");
    // Answering again is refused: it's no longer waiting.
    expect((await ada.post(`${path}/permissions/${request.requestId}`, { allow: true })).status).toBe(404);
    stream.close();
  });

  it("denies when nobody answers in time", async () => {
    const { ada, model, path } = await setup({ permissionMs: 300 });
    await ada.patch(`${path}/settings`, { mode: "ask" });
    // bash, not write: write checks the encrypted home is mounted before it asks, and a sandbox without FUSE has none.
    model.reply({ tools: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "ok" });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "say hi" });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "timeout" });
    stream.close();
  });

  it("Stop aborts the turn and denies a waiting request", async () => {
    const { ada, model, path } = await setup();
    await ada.patch(`${path}/settings`, { mode: "acceptEdits" });
    model.reply({ tools: [{ name: "bash", args: { command: "sleep 100" } }] });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "go" });
    await stream.until(is("permission"));
    await ada.post(`${path}/stop`);
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "permission_end")!.event).toMatchObject({ allowed: false, reason: "stopped" });
    stream.close();
  });
});

describe("machines", () => {
  it("are added after a test and a confirmed host key, and a suspect command asks until allowed in the thread", async () => {
    const { rt, ada, model, path } = await setup({ permissionMs: 5_000 });
    const u = `/api/u/${rt.ada.id}/machines`;
    // Nothing listens there: the test still gives a key and its setup steps, and nothing is saved.
    const probe = (await ada.post<MachineProbe>(`${u}/probe`, { name: "nas", address: "lyrica@127.0.0.1:1" })).body;
    expect(probe).toMatchObject({ login: false, offNetwork: false });
    expect(probe.setup).toContain("/etc/ssh/authorized_keys/lyrica");
    expect((await ada.get<MachineInfo[]>(u)).body).toEqual([]);
    expect((await ada.post(u, { name: "nas", address: "lyrica@127.0.0.1:1", pool: "general", draft: "nope", hostKey: KEY })).status).toBe(400);
    const added = (await ada.post<MachineInfo>(u, { name: "nas", address: "lyrica@127.0.0.1:1", root: "/srv", pool: "general", draft: probe.draft, hostKey: KEY })).body;
    expect(added).toMatchObject({ name: "nas", address: "lyrica@127.0.0.1:1", pool: "general", limit: "ask", hostKey: KEY });
    expect(added.keyLine).toMatch(/^restrict/);
    expect(added.asUser).toBeUndefined();
    // On the user's own account the setup needs no root, and the row says so.
    const own = (await ada.post<MachineProbe>(`${u}/probe`, { name: "laptop", address: "ada@127.0.0.1:1", asUser: true })).body;
    expect(own.setup).toContain(">> ~/.ssh/authorized_keys");
    expect((await ada.post<MachineInfo>(u, { name: "laptop", address: "ada@127.0.0.1:1", pool: "private", draft: own.draft, hostKey: KEY, asUser: true })).body).toMatchObject({ name: "laptop", asUser: true, limit: "ask" });
    await ada.patch(`${u}/nas`, { limit: "auto" });
    expect((await ada.patch(`${path}/settings`, { machines: ["nas"] })).status).toBe(200);
    expect((await ada.get<ThreadSettings>(`${path}/settings`)).body.machines).toEqual(["nas"]);

    model.reply({ tools: [{ name: "bash", args: { command: "sudo reboot", machine: "nas" } }] }, { text: "it didn't connect" });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "restart it" });
    await stream.until(is("permission"));
    const request = stream.events.find((e) => e.event.type === "permission")!.event as PermissionRequest;
    expect(request).toMatchObject({ tool: "bash", machine: "nas", suspect: true, warning: "This shuts the machine down or restarts it." });
    await ada.post(`${path}/permissions/${request.requestId}`, { allow: true, allowInThread: true });
    await stream.until(is("turn_end"));
    // The same command in the same thread no longer asks; it runs (and fails to connect, with no fallback).
    model.reply({ tools: [{ name: "bash", args: { command: "sudo reboot", machine: "nas" } }] }, { text: "again" });
    const again = ada.events(`${path}/events`);
    await again.until(is("hello"));
    await ada.post(`${path}/messages`, { text: "once more" });
    await again.until(is("turn_end"));
    expect(again.events.some((e) => e.event.type === "permission")).toBe(false);
    expect(again.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ name: "bash", isError: true });
    stream.close();
    again.close();
  });

  it("refuses Allow in this thread for a request that isn't a suspect command", async () => {
    const { ada, model, path } = await setup({ permissionMs: 5_000 });
    await ada.patch(`${path}/settings`, { mode: "acceptEdits" });
    model.reply({ tools: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "ok" });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "go" });
    await stream.until(is("permission"));
    const request = stream.events.find((e) => e.event.type === "permission")!.event as PermissionRequest;
    expect((await ada.post(`${path}/permissions/${request.requestId}`, { allow: true, allowInThread: true })).status).toBe(400);
    await ada.post(`${path}/permissions/${request.requestId}`, { allow: false });
    await stream.until(is("turn_end"));
    stream.close();
  });
});

describe("a Proxmox machine", () => {
  it("is added with its token, which never shows, and a reboot asks until allowed in that thread and no other", async () => {
    const pve = await fakeProxmox();
    try {
      const { rt, ada, model, path, logs } = await setup({ permissionMs: 5_000 });
      const u = `/api/u/${rt.ada.id}/machines`;
      const probe = (await ada.post<MachineProbe>(`${u}/probe`, { kind: "proxmox", name: "pve", address: pve.address })).body;
      expect(probe).toMatchObject({ fingerprint: pve.fingerprint, login: false });
      expect(probe.draft).toBeUndefined();
      const added = await ada.post<MachineInfo>(u, { kind: "proxmox", name: "pve", address: pve.address, token: PVE_TOKEN, hostKey: pve.fingerprint, pool: "general", limit: "auto" });
      expect(added.body).toMatchObject({ name: "pve", kind: "proxmox", address: pve.address, tokenId: "lyrica@pve!agent", limit: "auto", hostKey: pve.fingerprint });
      await ada.patch(`${path}/settings`, { machines: ["pve"] });
      const other = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "other" })).body;
      const otherPath = `/api/u/${rt.ada.id}/threads/general/${enc(other.id)}`;
      await ada.patch(`${otherPath}/settings`, { machines: ["pve"] });

      const reboot = { tools: [{ name: "proxmox", args: { machine: "pve", action: "reboot", vm: "101" } }] };
      model.reply(reboot, { text: "rebooting" });
      const stream = ada.events(`${path}/events`);
      await ada.post(`${path}/messages`, { text: "reboot web" });
      await stream.until(is("permission"));
      const request = stream.events.find((e) => e.event.type === "permission")!.event as PermissionRequest;
      expect(request).toMatchObject({ tool: "proxmox", machine: "pve", suspect: true, warning: "This restarts the VM: everything running in it stops." });
      expect(request.cwd).toBeUndefined();
      await ada.post(`${path}/permissions/${request.requestId}`, { allow: true, allowInThread: true });
      await stream.until(is("turn_end"));
      expect(pve.requests.map((r) => r.line)).toContain("POST /api2/json/nodes/pve1/qemu/101/status/reboot");

      // The same reboot in the same thread runs without asking.
      model.reply(reboot, { text: "again" });
      const again = ada.events(`${path}/events`);
      await again.until(is("hello"));
      await ada.post(`${path}/messages`, { text: "once more" });
      await again.until(is("turn_end"));
      expect(again.events.some((e) => e.event.type === "permission")).toBe(false);

      // In another thread it still asks.
      model.reply(reboot, { text: "not allowed here" });
      const elsewhere = ada.events(`${otherPath}/events`);
      await elsewhere.until(is("hello"));
      await ada.post(`${otherPath}/messages`, { text: "reboot web" });
      await elsewhere.until(is("permission"));
      const asked = elsewhere.events.find((e) => e.event.type === "permission")!.event as PermissionRequest;
      await ada.post(`${otherPath}/permissions/${asked.requestId}`, { allow: false });
      await elsewhere.until(is("turn_end"));

      // The token's secret is nowhere she, the API or the log can show.
      const secret = PVE_TOKEN.split("=")[1]!;
      const shown = JSON.stringify([
        (await ada.get(u)).body, (await ada.get(`${path}/messages`)).body, (await ada.get(`${otherPath}/messages`)).body,
        stream.events, again.events, elsewhere.events, logs, model.requests,
      ]);
      expect(shown).toContain("Asked pve1 to reboot 101 web");
      expect(shown).not.toContain(secret);
      stream.close();
      again.close();
      elsewhere.close();
    } finally {
      await pve.close();
    }
  });
});

describe("modes and switches", () => {
  it("shows a plan as a request any view can answer; approving it switches the mode and she carries on", async () => {
    const { ada, model, path } = await setup({ permissionMs: 5_000 });
    await ada.patch(`${path}/settings`, { mode: "plan" });
    model.reply({ tools: [{ name: "propose_plan", args: { plan: "1. Run the tests" } }] }, { tools: [{ name: "bash", args: { command: "npm test" } }] }, { text: "ok" });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "plan it" });
    await stream.until(is("permission"));
    const offered = (n: number) => model.requests[n]!.tools!.map((t) => t.function.name);
    expect(offered(0)).toContain("propose_plan");
    expect(offered(0)).not.toContain("bash");
    const plan = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string; tool: string; args: unknown };
    expect(plan).toMatchObject({ tool: "propose_plan", args: { plan: "1. Run the tests" } });
    // Approving needs a mode to go ahead in.
    expect((await ada.post(`${path}/permissions/${plan.requestId}`, { allow: true })).status).toBe(400);
    await ada.post(`${path}/permissions/${plan.requestId}`, { allow: true, mode: "acceptEdits" });
    await stream.until(is("settings"));
    expect((await ada.get<ThreadSettings>(`${path}/settings`)).body.mode).toBe("acceptEdits");
    // In the same turn, bash is on offer again, and asks, as Accept edits does.
    await stream.until((e) => e.type === "permission" && e.tool === "bash");
    expect(offered(1)).toContain("bash");
    expect(offered(1)).not.toContain("propose_plan");
    const bash = stream.events.filter((e) => e.event.type === "permission").at(-1)!.event as { requestId: string };
    await ada.post(`${path}/permissions/${bash.requestId}`, { allow: false });
    await stream.until(is("turn_end"));
    stream.close();
  });

  it("starts new threads in the user's default mode, and keeps the switches in the thread's settings", async () => {
    const { rt, ada, path } = await setup();
    expect((await ada.get(`/api/u/${rt.ada.id}/mode`)).body).toEqual({ mode: "auto" });
    expect((await ada.put(`/api/u/${rt.ada.id}/mode`, { mode: "ask" })).body).toEqual({ mode: "ask" });
    expect((await ada.put(`/api/u/${rt.ada.id}/mode`, { mode: "ask-changes" })).status).toBe(400);
    const fresh = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general" })).body;
    expect((await ada.get<ThreadSettings>(`/api/u/${rt.ada.id}/threads/general/${enc(fresh.id)}/settings`)).body.mode).toBe("ask");
    // A thread made before keeps its mode.
    expect((await ada.get<ThreadSettings>(`${path}/settings`)).body).toMatchObject({ mode: "auto", webSearch: true, images: true });
    expect((await ada.patch<ThreadSettings>(`${path}/settings`, { webSearch: false })).body).toMatchObject({ webSearch: false, images: true });
    expect((await ada.patch(`${path}/settings`, { images: "no" })).status).toBe(400);
  });
});

describe("the thread's model", () => {
  it("shows the profile, the thinking levels on offer and which model answered; recent calls hold no prompt text", async () => {
    const { rt, ada, model, path, thread } = await setup();
    model.reply({ text: "A reply about Miso." });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    await ada.post(`${path}/messages`, { text: "tell me about Miso the cat" });
    await stream.until(is("turn_end"));
    stream.close();
    const settings = (await ada.get<ThreadSettings>(`${path}/settings`)).body;
    expect(settings).toMatchObject({ profile: "Custom", preset: null, thinking: "medium", thinkingSet: false, thinkingLevels: ["off"], answered: { label: "gpu/qwen3.8-27b", kind: "local", task: "chat" } });
    const calls = (await ada.get<CallInfo[]>(`/api/u/${rt.ada.id}/models/calls`)).body;
    expect(calls[0]).toMatchObject({ threadId: thread.id, label: "gpu/qwen3.8-27b" });
    expect(JSON.stringify(calls)).not.toMatch(/Miso/);

    expect((await ada.patch<ThreadSettings>(`${path}/settings`, { thinking: "high", preset: "builtin.cloud" })).body).toMatchObject({ thinking: "high", thinkingSet: true, profile: "Cloud", preset: "builtin.cloud" });
    const priv = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "private" })).body;
    const privPath = `/api/u/${rt.ada.id}/threads/private/${enc(priv.id)}/settings`;
    expect((await ada.patch(privPath, { preset: "builtin.cloud" })).status).toBe(400);
    expect((await ada.get<ThreadSettings>(privPath)).body.profile).toBe("Custom");
    // Forgetting the thread takes its call records with it.
    await ada.del(path);
    expect((await ada.get<CallInfo[]>(`/api/u/${rt.ada.id}/models/calls`)).body.filter((c) => c.threadId === thread.id)).toEqual([]);
  });
});

describe("deleting a thread and keeping its memories", () => {
  it("keeps a note that cites it, links it as deleted, and serves a text-free tombstone", async () => {
    const { rt, ada, model, path, thread } = await setup();
    const u = `/api/u/${rt.ada.id}`;
    model.reply({ text: "Hello." });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    await ada.post(`${path}/messages`, { text: "hi" });
    await stream.until(is("turn_end"));
    stream.close();
    const note = (await ada.post<MemoryDetail>(`${u}/memory/general/notes`, { text: "{user} likes tea", links: [`t:${thread.id}`] })).body;
    expect((await ada.get(`${path}/tombstone`)).status).toBe(404);
    expect((await ada.del(path, { keepMemories: true })).status).toBe(200);
    expect((await ada.get(path)).status).toBe(404);
    const detail = (await ada.get<MemoryDetail>(`${u}/memory/general/${enc(note.item.id)}`)).body;
    expect(detail.links[`t:${thread.id}`]).toMatchObject({ kind: "thread", snippet: "", deleted: true });
    expect(detail.links[`t:${thread.id}`]!.title).toBeUndefined();
    const tomb = (await ada.get<ThreadTombstone>(`${path}/tombstone`)).body;
    expect(tomb).toMatchObject({ id: `t:${thread.id}`, memories: [{ id: note.item.id }] });
    expect(JSON.stringify(tomb)).not.toContain("test thread");
  });
});

describe("a machine that goes away", () => {
  it("marks its endpoint down when a turn can't reach it, and sends Pi's retry to the next model in the list", async () => {
    const { rt, ada, model, path } = await setup();
    const u = `/api/u/${rt.ada.id}`;
    const away = await fakeOpenAI({ label: "away", models: [{ id: "big" }] });
    const ep = (await ada.post<EndpointInfo>(`${u}/endpoints`, { name: "blackwell", kind: "local", baseUrl: away.baseUrl })).body;
    const gpu = (await ada.get<EndpointInfo[]>(`${u}/endpoints`)).body.find((e) => e.name === "gpu")!;
    await ada.put(`${u}/columns/general/chat`, { models: [{ offeringId: ep.models[0]!.id }, { offeringId: gpu.models[0]!.id }] });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    const turn = async (text: string) => {
      const ends = stream.events.filter((e) => e.event.type === "turn_end").length;
      await ada.post(`${path}/messages`, { text });
      await stream.until((e) => e.type === "turn_end" && stream.events.filter((x) => x.event.type === "turn_end").length > ends);
    };
    await turn("first");
    expect(away.requests).toHaveLength(1);
    await away.stop();
    // Pi's retry goes to the next model in the list, so this very turn is answered.
    await turn("second");
    expect(model.requests).toHaveLength(1);
    const calls = (await ada.get<CallInfo[]>(`${u}/models/calls`)).body;
    expect(calls[0]).toMatchObject({ label: "gpu/qwen3.8-27b", fallback: expect.stringContaining("blackwell is down") });
    stream.close();
  });
});

describe("a machine that dies mid-reply", () => {
  it("falls back for the rest of the turn and the next, and records one call per turn", async () => {
    const { rt, ada, model, path } = await setup();
    const u = `/api/u/${rt.ada.id}`;
    // A server that starts its answer, then its machine goes: the socket resets mid-stream and nothing listens after.
    let chats = 0;
    const dying = createServer((req, res) => {
      if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ object: "list", data: [{ id: "big" }] })); }
      chats++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (content: string) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "big", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
        chunk("Once ");
        chunk("upon ");
        setTimeout(() => { dying.close(); res.socket?.resetAndDestroy(); }, 50);
      });
    });
    await new Promise<void>((r) => dying.listen(0, "127.0.0.1", r));
    const ep = (await ada.post<EndpointInfo>(`${u}/endpoints`, { name: "blackwell", kind: "local", baseUrl: `http://127.0.0.1:${(dying.address() as { port: number }).port}/v1` })).body;
    const gpu = (await ada.get<EndpointInfo[]>(`${u}/endpoints`)).body.find((e) => e.name === "gpu")!;
    await ada.put(`${u}/columns/general/chat`, { models: [{ offeringId: ep.models[0]!.id }, { offeringId: gpu.models[0]!.id }] });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    const turn = async (text: string) => {
      const ends = stream.events.filter((e) => e.event.type === "turn_end").length;
      await ada.post(`${path}/messages`, { text });
      await stream.until((e) => e.type === "turn_end" && stream.events.filter((x) => x.event.type === "turn_end").length > ends, 0, 20_000);
    };
    const t = Date.now();
    await turn("tell me a story");
    // Pi's first retry, two seconds on, already goes to the next model.
    expect(Date.now() - t).toBeLessThan(4000);
    expect(chats).toBe(1);
    expect(model.requests).toHaveLength(1);
    await turn("and another");
    expect(chats).toBe(1);
    expect(model.requests).toHaveLength(2);
    const calls = (await ada.get<CallInfo[]>(`${u}/models/calls`)).body.filter((c) => c.task === "chat");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ label: "gpu/qwen3.8-27b", fallback: expect.stringContaining("blackwell is down") });
    stream.close();
  }, 30_000);
});

describe("errors and logs", () => {
  it("reports a refused model in plain words, on the stream and in the response", async () => {
    const { ada, path, rt } = await setup();
    await ada.put(`/api/u/${rt.ada.id}/columns/general/chat`, { model: null });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    const sent = await ada.post<{ error: string }>(`${path}/messages`, { text: "hello?" });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/no model is set for Main conversation/i);
    await stream.until(is("error"));
    stream.close();
  });

  it("logs method, route, status and timing, and never message text", async () => {
    const { ada, model, path, logs, rt } = await setup();
    const marker = "MARKER-7f3a9c";
    model.reply({ text: `reply ${marker}` });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: `please say ${marker}` });
    await stream.until(is("turn_end"));
    stream.close();
    await ada.get(`${path}/messages`);
    await ada.get(`/api/u/${rt.ada.id}/memory/search?q=${marker}`);
    expect(logs.some((l) => /^POST \/api\/u\/:userId\/threads\/:pool\/:threadId\/messages 200 \d+ms$/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain(marker);
    expect(logs.join("\n")).not.toContain("hello");
  });
});

const has = (cmd: string) => { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };
const homeRunnable = process.getuid?.() !== 0 && has("bwrap") && has("gocryptfs") && has("fusermount3") && existsSync("/dev/fuse");

describe.skipIf(!homeRunnable)("uploads", () => {
  it("saves a file into uploads/, where her read can open it", async () => {
    const { ada, model, path } = await setup();
    const up = await ada.call<UploadResponse>("POST", `${path}/uploads?name=notes.txt`, Buffer.from("seed list: tomatoes"), { "content-type": "application/octet-stream" });
    expect(up.body).toEqual({ path: "/workspace/uploads/notes.txt" });
    model.reply({ tools: [{ name: "read", args: { path: up.body.path } }] }, { text: "Tomatoes." });
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: "what did I upload?" });
    await stream.until(is("turn_end"));
    expect(stream.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ name: "read", isError: false, result: expect.stringContaining("tomatoes") });
    stream.close();
    // Names are cleaned, not refused, and a name already taken gets a suffix instead of overwriting.
    const up2 = async (name: string) =>
      (await ada.call<UploadResponse>("POST", `${path}/uploads?name=${enc(name)}`, Buffer.from("x"), { "content-type": "application/octet-stream" })).body.path;
    expect(await up2("notes.txt")).toBe("/workspace/uploads/notes-2.txt");
    expect(await up2("Ada's résumé.pdf")).toBe("/workspace/uploads/Ada's résumé.pdf");
    expect(await up2("../../etc/passwd")).toBe("/workspace/uploads/passwd");
  });
});
