import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { MessagePage, ThreadEvent, ThreadSummary } from "../src/api.ts";
import { Offline } from "@lyrica/core";
import { statusOf } from "../src/http.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const is = (type: ThreadEvent["type"]) => (e: ThreadEvent) => e.type === type;

describe("every chat model offline", () => {
  it("keeps lyricad up, holds the message, says what was tried, and sends it once the machine is back", async () => {
    const rt = await runtime();
    const dm = await daemon(rt, { offlineRetryMs: 200 });
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "gpu", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "t" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;

    // The only machine goes off mid-conversation: the turn ends saying no model can be reached, and Pi doesn't keep retrying it.
    await model.stop();
    const started = Date.now();
    expect((await ada.post(`${path}/messages`, { text: "first" })).status).toBe(200);
    await stream.until(is("turn_end"));
    expect(Date.now() - started).toBeLessThan(6_000);
    const offline = stream.events.find((e) => e.event.type === "offline")?.event;
    expect(offline).toEqual({ type: "offline", task: "chat", tried: [{ label: "gpu/qwen3.8-27b", reason: "gpu is down" }] });

    // Now known to be off: the next message isn't sent to it. It waits, and nothing is stored for it.
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text: "second" })).status).toBe(200);
    await stream.until(is("offline"), from);
    const after = stream.events.slice(from).map((e) => e.event);
    expect(after.map((e) => e.type)).not.toContain("turn_start");
    expect(after).toContainEqual({ type: "queue", queued: ["second"] });
    expect((await ada.get(`/api/state`)).status).toBe(200);

    // The machine comes back: the waiting message goes by itself, and is answered.
    const back = await fakeOpenAI({ label: "gpu", models: [{ id: "qwen3.8-27b" }], port: model.port });
    back.reply({ text: "Back now." });
    await stream.until(is("turn_end"), from);
    expect(back.requests.at(-1)!.messages.some((m) => JSON.stringify(m.content).includes("second"))).toBe(true);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.at(-1)!.parts.find((p) => p.type === "text")).toEqual({ type: "text", text: "Back now." });
    stream.close();
  });

  it("keeps a wake that comes while offline as a wake, sends it once the machine is back, and drops it on stop", async () => {
    const rt = await runtime();
    const dm = await daemon(rt, { offlineRetryMs: 200 });
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "gpu", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "t" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    await model.stop();
    await ada.post(`${path}/messages`, { text: "first" });
    await stream.until(is("turn_end"));
    const host = dm.d.services!.host.get(rt.ada.id, "general", thread.id);

    // A wake while offline waits; it is no message of the person's.
    let from = stream.events.length;
    await host.wakeChild("A background command ended.");
    await stream.until(is("offline"), from);
    expect(stream.events.slice(from).map((e) => e.event)).toContainEqual({ type: "queue", queued: [] });
    const back = await fakeOpenAI({ label: "gpu", models: [{ id: "qwen3.8-27b" }], port: model.port });
    back.reply({ text: "Seen." });
    await stream.until(is("turn_end"), from);
    expect(JSON.stringify(back.requests.at(-1)!.messages)).toContain("A background command ended.");
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(JSON.stringify(page.messages.filter((m) => m.role === "user"))).not.toContain("A background command ended.");

    // Held again, then stopped: the wake doesn't go later.
    await back.stop();
    from = stream.events.length;
    await host.wakeChild("Another command ended.");
    await stream.until(is("offline"), from);
    expect((await ada.post(`${path}/stop`)).status).toBe(200);
    const again = await fakeOpenAI({ label: "gpu", models: [{ id: "qwen3.8-27b" }], port: model.port });
    await new Promise((r) => setTimeout(r, 800));
    expect(again.requests.some((r) => JSON.stringify(r.messages).includes("Another command ended."))).toBe(false);
    await again.stop();
    stream.close();
  });

  it("answers an offline title, sleep and HTTP call without crashing", async () => {
    const rt = await runtime();
    const dm = await daemon(rt, { offlineRetryMs: 60_000 });
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "gpu", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    await model.stop();
    // A new thread has no title yet, so its first turn asks the (offline) title model too.
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    await ada.post(`${path}/messages`, { text: "hello?" });
    await stream.until(is("turn_end"));
    await ada.post(`${path}/messages`, { text: "anyone?" });
    await stream.until(is("offline"), stream.events.findIndex((e) => e.event.type === "turn_end") + 1);
    // Sleep is skipped with a plain reason.
    const sleep = await ada.post<{ error: string }>(`/api/u/${rt.ada.id}/sleep/general`, {});
    expect(sleep.status).toBe(409);
    expect(sleep.body.error).toMatch(/can be reached now/);
    // Stop drops the waiting message, and the daemon still answers.
    expect((await ada.post(`${path}/stop`)).status).toBe(200);
    expect((await ada.get(`/api/u/${rt.ada.id}/threads`)).status).toBe(200);
    stream.close();
  });

  it("answers an offline call 502, since 503 sends the web UI to unlock", () => {
    expect(statusOf(new Offline("chat", []))).toBe(502);
  });

  it("answers a system error 500, so its server path isn't sent as a reason", () => {
    expect(statusOf(new Error("expected a name"))).toBe(400);
    expect(statusOf(Object.assign(new Error("ENOENT: no such file or directory, open '/srv/x'"), { errno: -2, code: "ENOENT", syscall: "open" }))).toBe(500);
  });
});
