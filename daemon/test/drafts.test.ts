// Composer drafts survive a reload: one per thread, in the thread's encrypted
// pool database, never in the browser (AGENTS.md, "No plaintext memory").
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { DraftInfo, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

describe("drafts", () => {
  it("keeps the composer's text, clears it when sent, refuses an oversize one, and is the owner's alone", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Garden" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;

    expect((await ada.get<DraftInfo>(`${path}/draft`)).body).toEqual({ text: "" });
    const kept = (await ada.put<DraftInfo>(`${path}/draft`, { text: "what should I plant" })).body;
    expect(kept.text).toBe("what should I plant");
    expect(kept.updatedAt).toBeTruthy();
    expect((await ada.get<DraftInfo>(`${path}/draft`)).body).toEqual(kept);

    // Too long is refused and the kept one stays.
    expect((await ada.put(`${path}/draft`, { text: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    expect((await ada.get<DraftInfo>(`${path}/draft`)).body.text).toBe("what should I plant");
    // Someone else can't read it.
    const sam = await login(dm.base, "sam", "pw2");
    expect((await sam.get(`${path}/draft`)).status).toBe(401);

    // Sending clears it.
    model.reply({ text: "Tulips." });
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text: "what should I plant?" })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
    expect((await ada.get<DraftInfo>(`${path}/draft`)).body).toEqual({ text: "" });

    // Empty text clears it too.
    await ada.put(`${path}/draft`, { text: "next" });
    expect((await ada.put<DraftInfo>(`${path}/draft`, { text: "" })).body).toEqual({ text: "" });
  });
});
