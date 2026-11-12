import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@lyrica/core";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { MessagePage, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** A target whose one command runs until `finish`. */
function slowTarget() {
  let finish!: (output: string, code: number) => void;
  const target = {
    name: "sandbox", cwd: async () => "/workspace", folders: () => [],
    ops: () => ({ bash: { exec: (_c: string, _cwd: string, o: { onData: (d: Buffer) => void }) => new Promise((resolve) => { finish = (out, code) => { o.onData(Buffer.from(out)); resolve({ exitCode: code }); }; }) } }),
  } as unknown as ExecutionTarget;
  return { target, finish: (output: string, code = 0) => finish(output, code) };
}

describe("background commands", () => {
  it("tell the thread when one ends, and wake it once if it is idle, with every job that ended close together", async () => {
    const rt = await runtime();
    const dm = await daemon(rt, { jobWakeMs: 300 });
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const asked: string[] = [];
    const replies: Reply[] = [{ text: "Pulling the images in the background." }, { text: "The images are pulled." }];
    model.respond((c: ChatRequest) => { asked.push(JSON.stringify(c.messages)); return replies.shift() ?? { text: "ok" }; });
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Host" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    let from = stream.events.length;
    await ada.post(`${path}/messages`, { text: "pull the host images" });
    await stream.until((e) => e.type === "turn_end", from);

    const { target, finish } = slowTarget();
    const job = dm.d.services!.workspace.jobs.start({ userId: rt.ada.id, pool: "general", threadId: thread.id }, "box", target, "docker compose pull", "/home/lyrica");
    expect(job.id).toBe("j1");
    const second = slowTarget();
    dm.d.services!.workspace.jobs.start({ userId: rt.ada.id, pool: "general", threadId: thread.id }, "box", second.target, "docker image prune -f", "/home/lyrica");
    from = stream.events.length;
    finish("Pulled llama-server\nPulled host-api\n");
    second.finish("Total reclaimed space: 0B\n");
    await stream.until((e) => e.type === "turn_end", from);
    await new Promise((r) => setTimeout(r, 500));
    // Both ended within the wait: one turn, which reads both notices.
    expect(model.requests).toHaveLength(2);
    expect(asked.at(-1)).toContain("docker image prune -f");

    expect(asked.at(-1)).toMatch(/Background command j1 in box, exited with code 0 after \d+ s: docker compose pull\\nLast output:\\nPulled llama-server\\nPulled host-api/);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    const notice = page.messages.find((m) => m.role === "notice")!;
    expect(notice.parts[0]).toMatchObject({ type: "delegation", status: "job", text: expect.stringContaining("docker compose pull") });
    expect(page.messages.at(-1)!.parts).toEqual([{ type: "text", text: "The images are pulled." }]);
    expect(dm.d.services!.workspace.jobs.list({ userId: rt.ada.id, pool: "general", threadId: thread.id })).toMatchObject([{ id: "j1", state: "exited" }, { id: "j2", state: "exited" }]);
  });
});

describe("a stopped background command", () => {
  it("leaves no notice when she stopped it herself, and lyricad's stop leaves its notice without waking the thread", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    model.respond(() => ({ text: "ok" }));
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Host" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const t = { userId: rt.ada.id, pool: "general", threadId: thread.id };
    const jobs = dm.d.services!.workspace.jobs;
    jobs.start(t, "box", slowTarget().target, "docker compose pull", "/home/lyrica");
    expect(jobs.stop(t, "j1")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests).toHaveLength(0);
    // Her jobs stop told her already: nothing lands in the thread.
    expect((await ada.get<MessagePage>(`${path}/messages`)).body.messages.filter((m) => m.role === "notice")).toEqual([]);
    jobs.start(t, "box", slowTarget().target, "docker compose pull", "/home/lyrica");
    expect(jobs.stop(t, "j2", "the thread was forgotten")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests).toHaveLength(0);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.find((m) => m.role === "notice")!.parts[0]).toMatchObject({ status: "job", text: expect.stringContaining("stopped after") });

    // Lock stops a running job the same way: no turn starts.
    jobs.start(t, "box", slowTarget().target, "make", "/home/lyrica");
    await dm.d.lockUser(rt.ada.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests).toHaveLength(0);
    expect(jobs.list(t)).toEqual([]);
  });
});

describe("a background command that ends late", () => {
  /** A project's thread, with a job running, and the first model call held until `release`. */
  async function setup(first: Reply) {
    const rt = await runtime();
    const dm = await daemon(rt, { jobWakeMs: 200 });
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const replies: (Reply | (() => Promise<Reply>))[] = [async () => { await held; return first; }];
    model.respond(async () => { const next = replies.shift(); return typeof next === "function" ? next() : next ?? { text: "Done." }; });
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Tests" })).body;
    const view = dm.d.services!.memory.openThreadView(rt.ada.id, "general");
    const project = view.own.createThread({ interface: "web", project: true, title: "Garden" });
    view.close();
    const children = dm.d.services!.children;
    children.adopt(rt.ada.id, "general", thread.id, project.id, undefined);
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const t = { userId: rt.ada.id, pool: "general" as const, threadId: thread.id };
    const job = slowTarget();
    dm.d.services!.workspace.jobs.start(t, "sandbox", job.target, "npm test", "/workspace");
    const notices = async () => (await ada.get<MessagePage>(`${path}/messages`)).body.messages.filter((m) => m.role === "notice");
    const settle = () => new Promise((r) => setTimeout(r, 800));
    return { ada, model, path, children, t, finish: job.finish, release, notices, settle };
  }

  it("leaves its notice in a resolved thread without reopening or waking it", async () => {
    const s = await setup({ text: "Merged." });
    s.release();
    await s.ada.post(`${s.path}/messages`, { text: "merge it" });
    await s.settle();
    await s.children.setResolved(s.t.userId, s.t.pool, s.t.threadId, true);
    s.finish("Tests 1200 passed\n");
    await s.settle();
    expect(s.model.requests).toHaveLength(1);
    expect((await s.notices())[0]!.parts[0]).toMatchObject({ status: "job", text: expect.stringContaining("npm test") });
    expect(s.children.resolved(s.t.userId, s.t.pool, s.t.threadId)).toBe(true);
  });

  it("that ends mid-turn starts no further turn once she resolved the thread, and wakes an open one after the turn", async () => {
    for (const resolve of [true, false]) {
      const s = await setup({ text: "Merged and resolved." });
      await s.ada.post(`${s.path}/messages`, { text: "merge it" });
      await new Promise((r) => setTimeout(r, 200));
      s.finish("Tests 1200 passed\n");
      if (resolve) await s.children.setResolved(s.t.userId, s.t.pool, s.t.threadId, true);
      await new Promise((r) => setTimeout(r, 400));
      s.release();
      await s.settle();
      expect(s.model.requests).toHaveLength(resolve ? 1 : 2);
      expect(await s.notices()).toHaveLength(1);
      if (!resolve) expect(JSON.stringify(s.model.requests[1]!.messages)).toContain("Tests 1200 passed");
    }
  });

  it("read in the turn it ended in wakes nobody afterwards", async () => {
    const s = await setup({ tools: [{ name: "no_such_tool", args: {} }] });
    await s.ada.post(`${s.path}/messages`, { text: "run the tests" });
    await new Promise((r) => setTimeout(r, 200));
    s.finish("Tests 1200 passed\n");
    await new Promise((r) => setTimeout(r, 400));
    s.release();
    await s.settle();
    // The step after the tool call read the notice; the turn ended there.
    expect(s.model.requests).toHaveLength(2);
    expect(JSON.stringify(s.model.requests[1]!.messages)).toContain("Tests 1200 passed");
  });
});
