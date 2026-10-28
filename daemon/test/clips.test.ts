// Clips made in the background: her turn ends at once, and the thread hears of the clip, or why there is none.
import { describe, expect, it } from "vitest";
import { ClipJobs, type ClipThread } from "../src/clips.ts";
import type { ClipMade } from "@lyrica/extension";
import { fakeOpenAI, type ChatRequest } from "../../core/test/fake-openai.ts";
import type { MessagePage, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const t: ClipThread = { userId: "ada", pool: "general", threadId: "web/a" };
const video = { type: "video" as const, path: "/workspace/videos/a.mp4", model: "workstation/Clip", width: 1280, height: 704, duration: 5, audio: false };

function jobs() {
  const heard: unknown[][] = [];
  const clips = new ClipJobs({ done: (th, made) => heard.push(["done", th, made]), failed: (th, m, stopped) => heard.push(["failed", th, m, !!stopped]), log: () => {} });
  return { clips, heard };
}
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("clips made in the background", () => {
  it("tells the thread when a clip is made, or why it failed", async () => {
    const { clips, heard } = jobs();
    let finish!: (m: ClipMade) => void;
    clips.start(t, () => new Promise((r) => { finish = r; }));
    clips.start(t, async () => { throw new Error("Video failed with workstation/Clip: out of memory"); });
    expect(clips.count("ada", "general", "web/a")).toBe(2);
    await settled();
    expect(heard).toEqual([["failed", t, "Video failed with workstation/Clip: out of memory", false]]);
    finish({ text: "The clip is ready.", video });
    await settled();
    expect(heard.at(-1)).toEqual(["done", t, { text: "The clip is ready.", video }]);
    expect(clips.count("ada", "general", "web/a")).toBe(0);
  });

  it("stops a user's clips on Lock, aborting the host call, and says they stopped", async () => {
    const { clips, heard } = jobs();
    const signals: AbortSignal[] = [];
    const pending = (signal: AbortSignal) => { signals.push(signal); return new Promise<ClipMade>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); };
    clips.start(t, pending);
    clips.start({ ...t, userId: "sam" }, pending);
    clips.stop("Lyrica locked", "ada");
    await settled();
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    expect(heard).toEqual([["failed", t, "Lyrica locked", true]]);
    expect(clips.count("sam", "general", "web/a")).toBe(1);
  });
});

describe("a clip made in the background, through lyricad", () => {
  it("shows in the thread as hers and wakes the idle thread to say it's ready", async () => {
    const rt = await runtime();
    const dm = await daemon(rt, { jobWakeMs: 300 });
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const asked: string[] = [];
    model.respond((c: ChatRequest) => { asked.push(JSON.stringify(c.messages)); return { text: "Your clip is ready." }; });
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Fox" })).body;
    const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    const from = stream.events.length;
    dm.d.services!.clips.start({ userId: rt.ada.id, pool: "general", threadId: thread.id },
      async () => ({ text: "The clip is ready. Made with Clip on workstation: 5.0 s at 1280×704. Saved /workspace/videos/a.mp4.", video }));
    await stream.until((e) => e.type === "turn_end", from);
    expect(stream.events.slice(from)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "notice", status: "clip", video }) }));
    expect(asked.at(-1)).toContain("Saved /workspace/videos/a.mp4.");
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    expect(page.messages.map((m) => [m.role, m.parts[0]?.type])).toEqual([["assistant", "video"], ["assistant", "text"]]);
  });
});

describe("a forgotten thread's clip", () => {
  it("stops before it is saved, so nothing is written into the forgotten folder", async () => {
    const rt = await runtime();
    const dm = await daemon(rt);
    await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(dm.base, "ada", "pw");
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Fox" })).body;
    const other = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Cat" })).body;
    const signals: AbortSignal[] = [];
    let saved = 0;
    // As the image tool's job does: wait for the host, then save only if not stopped.
    let answer!: () => void;
    const host = new Promise<void>((r) => { answer = r; });
    const make = async (signal: AbortSignal): Promise<ClipMade> => { signals.push(signal); await host; signal.throwIfAborted(); saved++; return { text: "ready", video }; };
    const clips = dm.d.services!.clips;
    clips.start({ userId: rt.ada.id, pool: "general", threadId: thread.id }, make);
    clips.start({ userId: rt.ada.id, pool: "general", threadId: other.id }, make);
    expect((await ada.del(`/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`)).status).toBe(200);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    answer();
    await settled();
    expect(saved).toBe(1);
    expect(clips.count(rt.ada.id, "general", thread.id)).toBe(0);
  });
});
