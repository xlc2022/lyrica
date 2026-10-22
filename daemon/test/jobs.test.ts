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
  it("tell the thread when one ends, and wake it once if it is idle", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
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
    const job = dm.d.services!.workspace.jobs.start({ userId: rt.ada.id, pool: "general", threadId: thread.id }, "danube", target, "docker compose pull", "/home/lyrica");
    expect(job.id).toBe("j1");
    from = stream.events.length;
    finish("Pulled llama-server\nPulled host-api\n");
    await stream.until((e) => e.type === "turn_end", from);

    expect(asked.at(-1)).toMatch(/Background command j1 in danube, exited with code 0 after \d+ s: docker compose pull\\nLast output:\\nPulled llama-server\\nPulled host-api/);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    const notice = page.messages.find((m) => m.role === "notice")!;
    expect(notice.parts[0]).toMatchObject({ type: "delegation", status: "job", text: expect.stringContaining("docker compose pull") });
    expect(page.messages.at(-1)!.parts).toEqual([{ type: "text", text: "The images are pulled." }]);
    expect(dm.d.services!.workspace.jobs.list({ userId: rt.ada.id, pool: "general", threadId: thread.id })).toMatchObject([{ id: "j1", state: "exited" }]);
  });
});

describe("a stopped background command", () => {
  it("leaves its notice without waking the thread", async () => {
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
    jobs.start(t, "danube", slowTarget().target, "docker compose pull", "/home/lyrica");
    expect(jobs.stop(t, "j1", "stopped by her")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests).toHaveLength(0);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.find((m) => m.role === "notice")!.parts[0]).toMatchObject({ status: "job", text: expect.stringContaining("stopped after") });

    // Lock stops a running job the same way: no turn starts.
    jobs.start(t, "danube", slowTarget().target, "make", "/home/lyrica");
    await dm.d.lockUser(rt.ada.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests).toHaveLength(0);
    expect(jobs.list(t)).toEqual([]);
  });
});
