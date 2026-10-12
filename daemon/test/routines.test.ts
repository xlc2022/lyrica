import { Memory, Models, Users, Workspace } from "@lyrica/core";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import type { Delegation } from "@lyrica/extension";
import { ChildThreads } from "../src/children.ts";
import type { ThreadHost } from "../src/hosted.ts";
import { Routines } from "../src/routines.ts";
import { Wakeups } from "../src/wakeups.ts";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WAKEUP_LIMITS, type Pool, type PoolStore } from "@lyrica/core";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { CallInfo, EndpointInfo, MessagePage, RoutineInfo, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const HOUR = 3_600_000;
const start = new Date("2026-01-01T00:00:00Z");
const at = (hours: number) => new Date(start.getTime() + hours * HOUR);

async function setup(pool: Pool = "general", project = false, concurrency = 2) {
  const rt = await runtime();
  const dm = await daemon(rt, { threads: { concurrency } });
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  let ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const requests: ChatRequest[] = [];
  let answer: () => Reply | Promise<Reply> = () => ({ text: "Checked." });
  model.respond(c => { requests.push(c); return answer(); });
  const u = `/api/u/${rt.ada.id}`;
  const thread = (await ada.post<ThreadSummary>(`${u}/threads`, { pool, title: "Checks", project })).body;
  const path = `${u}/threads/${pool}/${enc(thread.id)}`;
  const own = <T>(fn: (store: PoolStore) => T): T => {
    const view = dm.d.services!.memory.openThreadView(rt.ada.id, pool);
    try { return fn(view.own); } finally { view.close(); }
  };
  const add = (newThread = false, source = thread.id) => own(s => s.addRoutine(source, { kind: "every", hours: 1, from: start.toISOString() }, "Inspect the build queue.", newThread, start.toISOString()));
  const tick = (hours: number) => dm.d.services!.routines.tick(at(hours));
  const idle = async (id = thread.id) => {
    await expect.poll(() => dm.d.services!.host.busy(rt.ada.id, pool, id)).toBe(false);
  };
  const fired = async (count = 1, id = thread.id) => {
    await expect.poll(() => requests.length).toBe(count);
    await idle(id);
  };
  const messages = async (id = thread.id) => (await ada.get<MessagePage>(`${u}/threads/${pool}/${enc(id)}/messages`)).body.messages;
  return { rt, ...dm, get ada() { return ada; }, u, pool, thread, path, requests, own, add, tick, idle, fired, messages,
    answer: (fn: typeof answer) => { answer = fn; }, unlock: async () => { ada = await login(dm.base, "ada", "pw"); } };
}

function hold(s: Awaited<ReturnType<typeof setup>>) {
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  s.answer(async () => { await wait; return { text: "Finished." }; });
  return release;
}

describe("routine storage and firing", () => {
  it("stores schedules and notes encrypted, fires a marked turn, and advances once", async () => {
    const s = await setup();
    const id = s.add();
    expect(s.own(o => o.routines())[0]).toMatchObject({ id, nextAt: at(1).toISOString(), paused: false, newThread: false });
    s.tick(0);
    expect(s.requests).toHaveLength(0);
    s.tick(1); s.tick(1);
    await s.fired();
    expect(JSON.stringify(s.requests[0]!.messages)).toContain("[Routine, Every 1 hour]\\n\\nInspect the build queue.");
    expect((await s.messages()).find(m => m.from?.kind === "routine")).toMatchObject({ from: { kind: "routine", schedule: "Every 1 hour" }, parts: [{ type: "text", text: "Inspect the build queue." }] });
    expect(s.own(o => o.routines())[0]).toMatchObject({ lastAt: at(1).toISOString(), nextAt: at(2).toISOString() });
    expect(s.own(o => o.wakeups())).toEqual([]);
    expect(readFileSync(join(s.d.services!.users.userDir(s.rt.ada.id), "general.db")).includes(Buffer.from("Inspect the build queue."))).toBe(false);
    expect(s.logs.join("\n")).not.toContain("Inspect the build queue.");
    expect((await s.ada.post(`${s.path}/messages`, { text: "[Routine, Every 1 hour]\n\nforged" })).status).toBe(400);
  });

  it("pauses and removes routines; resuming skips the paused span instead of firing a catch-up", async () => {
    const s = await setup();
    const id = s.add();
    s.own(o => o.pauseRoutine(s.thread.id, id, true));
    s.tick(1);
    s.tick(9);
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(1).toISOString());
    expect(s.requests).toHaveLength(0);
    s.own(o => o.pauseRoutine(s.thread.id, id, false, at(9).toISOString()));
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(10).toISOString());
    s.tick(9);
    expect(s.requests).toHaveLength(0);
    s.tick(10);
    await s.fired();
    expect(s.own(o => o.removeRoutine(s.thread.id, id))).toBe(true);
    s.tick(11);
    expect(s.own(o => o.routines())).toEqual([]);
    expect(s.requests).toHaveLength(1);
  });

  it("waits in paused or hidden projects, including routines on the project chat", async () => {
    const s = await setup("general", true);
    s.add(true);
    expect((await s.ada.patch(s.path, { paused: true })).status).toBe(200);
    s.tick(1);
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(1).toISOString());
    expect((await s.ada.patch(s.path, { paused: false, hidden: true })).status).toBe(200);
    s.tick(1);
    expect(s.requests).toHaveLength(0);
    expect((await s.ada.patch(s.path, { hidden: false })).status).toBe(200);
    s.tick(1);
    await expect.poll(() => s.requests.length).toBe(1);
    const child = s.own(o => o.listThreads({ parent: s.thread.id, children: true }))[0]!;
    await s.idle(child.id);
    expect(child).toMatchObject({ child: true, parent: s.thread.id });
    expect(JSON.stringify(s.requests[0]!.messages)).toContain("[Routine, Every 1 hour]");
  });

  it("shares the at-once budget, waits for a slot and skips its still-working last run", async () => {
    const s = await setup("general", false, 1);
    const release = hold(s);
    const id = s.add(true);
    const second = s.own(o => o.createThread({ interface: "web", title: "Other checks" }));
    s.add(false, second.id);
    s.tick(1);
    await expect.poll(() => s.requests.length).toBe(1);
    expect(s.own(o => o.routines(second.id))[0]!.nextAt).toBe(at(1).toISOString());
    s.tick(2);
    expect(s.own(o => o.routines().find(r => r.id === id))!.nextAt).toBe(at(3).toISOString());
    expect(s.requests).toHaveLength(1);
    const created = s.own(o => o.listThreads()).find(t => t.title === "Every 1 hour")!;
    release(); await s.idle(created.id);
    s.answer(() => ({ text: "Checked." }));
    s.tick(2);
    await s.fired(2, second.id);
  });

  it("locked missed runs fire once at unlock with the number due, surviving restart", async () => {
    const s = await setup();
    s.add();
    expect((await s.ada.post(`${s.u}/lock`)).status).toBe(200);
    s.tick(3);
    expect(s.requests).toHaveLength(0);
    await s.stop();
    const again = await daemon(s.rt);
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    await login(again.base, "ada", "pw");
    again.d.services!.routines.tick(at(3));
    await expect.poll(() => s.requests.length).toBe(1);
    await expect.poll(() => again.d.services!.host.busy(s.rt.ada.id, "general", s.thread.id)).toBe(false);
    expect(JSON.stringify(s.requests[0]!.messages)).toContain("3 runs were due; running once.");
    again.d.services!.routines.tick(at(3));
    expect(s.requests).toHaveLength(1);
    const view = again.d.services!.memory.openThreadView(s.rt.ada.id, "general");
    try { expect(view.own.routines()[0]!.nextAt).toBe(at(4).toISOString()); } finally { view.close(); }
  });

  it("enforces the rolling shared cap at firing as well as setting wake-ups", async () => {
    const s = await setup();
    s.add();
    s.own(o => {
      for (let n = 0; n < WAKEUP_LIMITS.perDay - 1; n++) o.fireWakeup(o.addWakeup(s.thread.id, at(0).toISOString(), "", at(0).toISOString()), at(0).toISOString());
    });
    s.tick(1); await s.fired();
    expect(s.own(o => o.wakeupsFired(s.thread.id, at(0).toISOString()))).toHaveLength(24);
    s.tick(2);
    expect(s.requests).toHaveLength(1);
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(3).toISOString());
    s.own(o => o.addWakeup(s.thread.id, at(2).toISOString(), "Check once.", at(1).toISOString()));
    s.d.services!.wakeups.load(s.rt.ada.id);
    s.d.services!.wakeups.tick(at(2));
    expect(s.own(o => o.wakeups())).toHaveLength(1);
    s.d.services!.wakeups.tick(at(25));
    await s.fired(2);
    expect(s.own(o => o.wakeups())).toEqual([]);
  });

  it.each([false, true])("keeps a private-pool run local, new thread: %s", async newThread => {
    const s = await setup("private");
    const cloud = await fakeOpenAI({ label: "cloud", models: [{ id: "cloud-model" }] });
    let cloudCalls = 0;
    cloud.respond(() => { cloudCalls++; return { text: "Cloud." }; });
    const endpoint = await s.ada.post<EndpointInfo>(`${s.u}/endpoints`, { name: "cloud", kind: "cloud", baseUrl: cloud.baseUrl });
    expect(endpoint.status).toBe(200);
    const ep = endpoint.body;
    expect((await s.ada.put(`${s.u}/profiles/custom/chat`, { model: { offeringId: ep.models[0]!.id } })).status).toBe(200);
    s.add(newThread);
    s.tick(1);
    await expect.poll(() => s.requests.length).toBe(1);
    const target = s.own(o => newThread ? o.listThreads().find(t => t.title === "Every 1 hour")! : o.getThread(s.thread.id)!);
    await s.idle(target.id);
    expect(target).toMatchObject({ child: false, parent: undefined });
    expect(cloudCalls).toBe(0);
    expect((await s.ada.get<CallInfo[]>(`${s.u}/models/calls`)).body.filter(c => c.task === "chat").map(c => [c.pool, c.kind])).toEqual([["private", "local"]]);
    const messages = await s.messages(target.id);
    expect(messages[0]!.parts).toEqual([{ type: "text", text: "Inspect the build queue." }]);
  });

  it("forgetting the source removes its routines", async () => {
    const s = await setup();
    s.add();
    s.own(o => o.forgetThread(s.thread.id, "lyrica"));
    s.tick(1);
    expect(s.own(o => o.routines())).toEqual([]);
    expect(s.requests).toHaveLength(0);
  });
});

const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });

/** Real encrypted stores, model contexts and child guards, with an in-memory turn host. */
async function setupStore(pool: Pool = "general", project = false, concurrency = 2) {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const user = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const memory = new Memory(keyring, users);
  const models = new Models(keyring, users);
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  close.push(() => workspace.settings(user.id).close());
  const own = <T>(fn: (s: PoolStore) => T) => {
    const view = memory.openThreadView(user.id, pool);
    try { return fn(view.own); } finally { view.close(); }
  };
  const thread = own(s => s.createThread({ interface: "web", title: "Checks", project }));
  const busy = new Set<string>();
  const sent: { thread: string; text: string; opts: { routine?: string; wakeup?: string } }[] = [];
  const host = {
    busy: (_user: string, _pool: Pool, id: string) => busy.has(id),
    get: (_user: string, _pool: Pool, id: string) => ({ send: async (text: string, opts: { routine?: string; wakeup?: string }) => {
      busy.add(id); sent.push({ thread: id, text, opts }); return { queued: false };
    } }),
    peek: () => undefined,
    changed: () => {},
  } as unknown as ThreadHost;
  let paused = false;
  const children = new ChildThreads({ users, memory, models, workspace, delegation: {} as Delegation, host: () => host, paused: () => paused, limits: { concurrency } });
  const logs: string[] = [];
  const options = { memory, children, host: () => host, log: (line: string) => logs.push(line) };
  const routines = new Routines(options);
  const wakeups = new Wakeups(options);
  routines.load(user.id);
  const add = (newThread = false, source = thread.id) => own(s => s.addRoutine(source, { kind: "every", hours: 1, from: start.toISOString() }, "Inspect the build queue.", newThread, start.toISOString()));
  const tick = async (hours: number) => { routines.tick(at(hours)); await new Promise<void>(r => setImmediate(r)); };
  return { keyring, user, users, memory, models, workspace, children, routines, wakeups, own, thread, busy, sent, logs, add, tick, pause: (value: boolean) => { paused = value; } };
}

describe("routine storage and guards", () => {
  it("fires once, advances, skips a working previous run and shares the at-once budget", async () => {
    const s = await setupStore("general", false, 1);
    const first = s.add(true);
    const other = s.own(o => o.createThread({ interface: "web", title: "Other checks" }));
    s.add(false, other.id);
    await s.tick(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ text: "Inspect the build queue.", opts: { routine: "[Routine, Every 1 hour]\n\n" } });
    expect(s.own(o => o.routines(other.id))[0]!.nextAt).toBe(at(1).toISOString());
    await s.tick(2);
    expect(s.sent).toHaveLength(1);
    expect(s.own(o => o.routines().find(r => r.id === first))!.nextAt).toBe(at(3).toISOString());
    s.busy.clear();
    await s.tick(2);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.thread).toBe(other.id);
    expect(s.sent[1]!.text).toContain("2 runs were due; running once.");
  });

  it("waits for a paused project, a queued thread and a paused routine", async () => {
    const s = await setupStore("general", true);
    s.add(true);
    s.pause(true);
    await s.tick(1);
    expect(s.sent).toEqual([]);
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(1).toISOString());
    s.pause(false);
    await s.tick(1);
    const child = s.sent[0]!.thread;
    expect(s.own(o => o.getThread(child))).toMatchObject({ child: true, parent: s.thread.id });
    s.busy.clear();
    s.own(o => o.removeRoutine(s.thread.id, o.routines()[0]!.id));
    const id = s.add(false, child);
    const db = s.users.openUserDb(s.user.id);
    try { db.prepare("UPDATE child_threads SET queued = 1 WHERE thread = ?").run(child); } finally { db.close(); }
    await s.tick(1);
    expect(s.sent).toHaveLength(1);
    const db2 = s.users.openUserDb(s.user.id);
    try { db2.prepare("UPDATE child_threads SET queued = 0 WHERE thread = ?").run(child); } finally { db2.close(); }
    s.own(o => o.pauseRoutine(child, id, true));
    await s.tick(1);
    expect(s.sent).toHaveLength(1);
    s.own(o => o.pauseRoutine(child, id, false, at(0).toISOString()));
    await s.tick(1);
    expect(s.sent).toHaveLength(2);
    s.own(o => o.forgetThread(child, "lyrica"));
    expect(s.own(o => o.routines())).toEqual([]);
  });

  it("retains locked runs in the encrypted pool and collapses them after unlock or restart", async () => {
    const s = await setupStore();
    s.add();
    s.routines.drop(s.user.id);
    s.keyring.lockUser(s.user.id);
    await s.tick(5);
    expect(s.sent).toEqual([]);
    await s.users.authenticate("ada", "pw");
    const restarted = new Routines({ memory: s.memory, children: s.children, host: () => ({
      busy: () => false,
      get: () => ({ send: async (text: string, opts: { routine?: string }) => { s.sent.push({ thread: s.thread.id, text, opts }); } }),
    } as unknown as ThreadHost), log: line => s.logs.push(line) });
    restarted.load(s.user.id);
    restarted.tick(at(5));
    await new Promise<void>(r => setImmediate(r));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toContain("5 runs were due; running once.");
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(6).toISOString());
    restarted.tick(at(5));
    expect(s.sent).toHaveLength(1);
  });

  it("enforces the shared daily cap in either direction and lets wake-ups wait for the rolling day", async () => {
    const s = await setupStore();
    s.add();
    s.own(o => {
      for (let n = 0; n < 23; n++) o.fireWakeup(o.addWakeup(s.thread.id, start.toISOString(), "", start.toISOString()), start.toISOString());
    });
    await s.tick(1);
    s.busy.clear();
    await s.tick(2);
    expect(s.sent).toHaveLength(1);
    expect(s.own(o => o.routines())[0]!.nextAt).toBe(at(3).toISOString());
    s.own(o => o.addWakeup(s.thread.id, at(2).toISOString(), "Look once.", start.toISOString()));
    s.wakeups.load(s.user.id);
    s.wakeups.tick(at(2));
    expect(s.sent).toHaveLength(1);
    expect(s.own(o => o.wakeups())).toHaveLength(1);
    s.wakeups.tick(at(25));
    await new Promise<void>(r => setImmediate(r));
    expect(s.sent).toHaveLength(2);
    expect(s.own(o => o.wakeups())).toEqual([]);
  });

  it("new private threads inherit a local-only model context and the source workspace", async () => {
    const s = await setupStore("private");
    s.workspace.settings(s.user.id).setThread(s.thread.id, "private", { mode: "plan", internet: false });
    s.add(true);
    await s.tick(1);
    const target = s.sent[0]!.thread;
    expect(s.own(o => o.getThread(target))).toMatchObject({ interface: "web", child: false, parent: undefined });
    expect(s.models.callContext(s.user.id, "private", target)).toMatchObject({ pool: "private", localOnly: true });
    expect(s.workspace.settings(s.user.id).effective(target)).toMatchObject({ mode: "plan", internet: false });
    expect(s.logs).toEqual([]);
  });
});


describe("routine HTTP routes", () => {
  it("lists own threads across pools without notes, and confines pause/resume/remove to the named thread", async () => {
    const s = await setup("private");
    const id = s.add();
    const general = s.d.services!.memory.openThreadView(s.rt.ada.id, "general");
    let other: string;
    try {
      other = general.own.createThread({ interface: "web", title: "Morning" }).id;
      general.own.addRoutine(other, { kind: "daily", time: "08:00" }, "A different synthetic note.");
    } finally { general.close(); }
    const all = (await s.ada.get<RoutineInfo[]>(`${s.u}/routines`)).body;
    expect(all).toHaveLength(2);
    expect(all.find(r => r.pool === "private")).toEqual({ id, pool: "private", threadId: s.thread.id, threadTitle: "Checks", schedule: "Every 1 hour", nextAt: at(1).toISOString(), paused: false });
    expect(JSON.stringify(all)).not.toMatch(/note|Inspect the build queue|different synthetic/);
    expect((await s.ada.get<ThreadSettings>(`${s.path}/settings`)).body.routines).toEqual([all.find(r => r.pool === "private")]);
    const path = `${s.path}/routines/${id}`;
    expect((await s.ada.patch<RoutineInfo[]>(path, { paused: true })).body[0]!.paused).toBe(true);
    expect((await s.ada.patch<RoutineInfo[]>(path, { paused: false })).body[0]!.paused).toBe(false);
    expect((await s.ada.patch(path, { paused: "yes" })).status).toBe(400);
    const otherThread = s.own(o => o.createThread({ interface: "web", title: "Other" }).id);
    const wrong = `${s.u}/threads/private/${enc(otherThread)}/routines/${id}`;
    expect((await s.ada.patch(wrong, { paused: true })).status).toBe(404);
    expect((await s.ada.del(wrong)).status).toBe(404);
    expect((await s.ada.del<RoutineInfo[]>(path)).body).toEqual([]);
    expect((await s.ada.del(path)).status).toBe(404);
    expect((await s.ada.get<RoutineInfo[]>(`${s.u}/routines`)).body).toHaveLength(1);
  });

  it("never exposes or changes another user's private routines, even while that user is unlocked", async () => {
    const s = await setup("private");
    const id = s.add();
    const sam = await login(s.base, "sam", "pw2");
    expect((await sam.get<RoutineInfo[]>(`/api/u/${s.rt.sam.id}/routines`)).body).toEqual([]);
    expect((await sam.get(`${s.u}/routines`)).status).toBe(401);
    expect((await sam.get(`${s.path}/routines`)).status).toBe(401);
    expect((await sam.patch(`${s.path}/routines/${id}`, { paused: true })).status).toBe(401);
    expect((await sam.del(`${s.path}/routines/${id}`)).status).toBe(401);
    const foreign = `/api/u/${s.rt.sam.id}/threads/private/${enc(s.thread.id)}/routines`;
    expect((await sam.get(foreign)).status).toBe(404);
    expect((await sam.patch(`${foreign}/${id}`, { paused: true })).status).toBe(404);
    expect((await sam.del(`${foreign}/${id}`)).status).toBe(404);
    expect(s.own(o => o.routines())[0]!.paused).toBe(false);
    expect((await browser(s.base).get(`${s.u}/routines`)).status).toBe(401);
  });
});
