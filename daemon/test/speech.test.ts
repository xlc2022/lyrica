import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { fakeSpeech, wav } from "../../core/test/fake-speech.ts";
import type { CallInfo, EndpointInfo, MessagePage, Profiles, Speech, ThreadSettings, ThreadSummary, Transcription } from "../src/api.ts";
import { languageOf, sentences, speakable } from "../src/speech.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const VOICES = [{ id: "af_heart", language: "en" }, { id: "zf_xiaobei", language: "zh" }];

/** Lyricad unlocked, Li logged in, a local chat model, a local speech endpoint for both speech tasks, and a thread in `pool`. */
async function setup(pool: "general" | "private" = "private", speechOpts: { gapMs?: number } = {}) {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(li, rt.li.id, model.baseUrl);
  const speech = await fakeSpeech(speechOpts);
  const u = `/api/u/${rt.li.id}`;
  const ep = (await li.post<EndpointInfo>(`${u}/endpoints`, { name: "speech", kind: "local", baseUrl: speech.baseUrl })).body;
  const id = (m: string) => ep.models.find((x) => x.modelId === m)!.id;
  const ok = async (r: Promise<{ status: number; body: unknown }>) => { const x = await r; if (x.status !== 200) throw new Error(JSON.stringify(x.body)); };
  await ok(li.patch(`${u}/offerings/${id("whisper-large-v3-turbo")}`, { transcribe: true }));
  await ok(li.patch(`${u}/offerings/${id("kokoro")}`, { speak: { voices: VOICES } }));
  for (const p of ["local", "custom"]) {
    await ok(li.put(`${u}/profiles/${p}/speech.transcribe`, { model: { offeringId: id("whisper-large-v3-turbo") } }));
    await ok(li.put(`${u}/profiles/${p}/speech.speak`, { model: { offeringId: id("kokoro") } }));
  }
  const thread = (await li.post<ThreadSummary>(`${u}/threads`, { pool, title: "speech" })).body;
  const path = `${u}/threads/${pool}/${enc(thread.id)}`;
  const stream = li.events(`${path}/events`);
  await stream.ready;
  const turn = async (reply: string, text = "say something") => {
    const ends = stream.events.filter((e) => e.event.type === "turn_end").length;
    model.reply({ text: reply });
    await li.post(`${path}/messages`, { text });
    await stream.until((e) => e.type === "turn_end" && stream.events.filter((x) => x.event.type === "turn_end").length > ends, 0, 20_000);
  };
  const nOf = async (role: "user" | "assistant") => (await li.get<MessagePage>(`${path}/messages`)).body.messages.filter((m) => m.role === role).at(-1)!.n;
  const audio = (p: string, signal?: AbortSignal) => fetch(dm.base + p, { headers: { cookie: li.cookie! }, ...(signal ? { signal } : {}) });
  return { rt, ...dm, li, u, model, speech, ep, id, thread, path, stream, turn, audio, nOf };
}

const REPLY = [
  "# Plan",
  "Here is **the** plan. It has [two steps](https://example.com/x).",
  "",
  "```ts",
  "const secret = 'CODE-MARK';",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| TABLE-MARK | 2 |",
  "",
  "- First, run `npm test`!",
  "然后我们去吃饭。好吗？",
].join("\n");

describe("making text speakable", () => {
  it("drops code, tables, links and marks, and splits English and Mandarin sentences", () => {
    const text = speakable(REPLY);
    expect(text).not.toMatch(/CODE-MARK|TABLE-MARK|example\.com|\*|#|`/);
    expect(sentences(text)).toEqual(["Plan", "Here is the plan.", "It has two steps.", "First, run npm test!", "然后我们去吃饭。", "好吗？"]);
    expect(languageOf("好吗？")).toBe("zh");
    expect(languageOf("It has two steps.")).toBe("en");
    // A message still being written: the half sentence waits, and an open code block hides what follows.
    expect(sentences("One. Two and", false)).toEqual(["One."]);
    expect(speakable("Look:\n```\nconst x = 1;")).toBe("Look:");
    expect(sentences(`${"word ".repeat(150)}end.`).every((s) => s.length <= 400)).toBe(true);
  });
});

describe("dictation", () => {
  it("transcribes a clip in a thread and on the welcome page, records the seconds and model only, and writes no file", async () => {
    const s = await setup();
    const before = readdirSync(tmpdir()).sort();
    const r = await s.li.post<Transcription>(`${s.path}/transcribe?language=zh`, wav(3), { "content-type": "audio/wav" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: "hello from the fake", seconds: 3, model: "speech/whisper-large-v3-turbo" });
    expect(s.speech.heard.at(-1)).toMatchObject({ url: "/v1/audio/transcriptions", language: "zh", bytes: 96_044 });
    const welcome = await s.li.post<Transcription>(`${s.u}/transcribe?pool=private`, wav(1), { "content-type": "audio/wav" });
    expect(welcome.body.text).toBe("hello from the fake");
    expect(readdirSync(tmpdir()).sort()).toEqual(before);

    const calls = (await s.li.get<CallInfo[]>(`${s.u}/models/calls`)).body.filter((c) => c.task === "speech.transcribe");
    expect(calls.map((c) => c.audioSeconds)).toEqual([1, 3]);
    expect(JSON.stringify(calls)).not.toMatch(/hello from the fake/);
    expect(s.logs.join("\n")).not.toMatch(/hello from the fake/);

    // Not a WAV clip, or too long.
    expect((await s.li.post(`${s.path}/transcribe`, Buffer.from("plain words"), { "content-type": "audio/wav" })).status).toBe(400);
    expect((await s.li.post(`${s.path}/transcribe`, Buffer.from("x"), { "content-type": "audio/webm" })).status).toBe(415);
    expect((await s.li.post(`${s.path}/transcribe`, wav(601), { "content-type": "audio/wav" })).status).toBe(413);
  });

  it("refuses a cloud transcription with Voice to cloud off, before anything is sent, and the thread's switch beats the default", async () => {
    const s = await setup("general");
    const cloud = await fakeSpeech();
    const ep = (await s.li.post<EndpointInfo>(`${s.u}/endpoints`, { name: "openai", kind: "cloud", baseUrl: cloud.baseUrl, apiKey: "sk" })).body;
    const stt = ep.models.find((m) => m.modelId === "whisper-large-v3-turbo")!.id;
    await s.li.patch(`${s.u}/offerings/${stt}`, { transcribe: true });
    await s.li.put(`${s.u}/profiles/cloud/speech.transcribe`, { model: { offeringId: stt } });
    await s.li.patch(`${s.u}/profiles`, { default: "cloud" });

    let settings = (await s.li.get<ThreadSettings>(`${s.path}/settings`)).body;
    expect(settings.voiceCloud).toBeNull();
    expect(settings.speech.transcribe).toEqual({ available: false, reason: "voiceCloud", problem: "openai/whisper-large-v3-turbo is a cloud model, and Voice to cloud is off" });
    const refused = await s.li.post<{ error: string }>(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" });
    expect(refused).toMatchObject({ status: 400, body: { error: "openai/whisper-large-v3-turbo is a cloud model, and Voice to cloud is off, so the clip wasn't sent" } });
    expect(cloud.heard).toEqual([]);

    // On by default, off in this thread: off.
    expect((await s.li.patch<Profiles>(`${s.u}/profiles`, { voiceCloud: true })).body.voiceCloud).toBe(true);
    settings = (await s.li.patch<ThreadSettings>(`${s.path}/settings`, { voiceCloud: false })).body;
    expect(settings).toMatchObject({ voiceCloud: false, speech: { voiceCloud: false, transcribe: { available: false, reason: "voiceCloud" } } });
    expect((await s.li.post(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" })).status).toBe(400);
    expect(cloud.heard).toEqual([]);
    // Following the default again: on.
    await s.li.patch(`${s.path}/settings`, { voiceCloud: null });
    expect((await s.li.post(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" })).status).toBe(200);
    expect(cloud.heard).toHaveLength(1);
    // The welcome page follows the default.
    expect((await s.li.get<Speech>(`${s.u}/speech?pool=general`)).body).toMatchObject({ voiceCloud: true, transcribe: { available: true, kind: "cloud" } });
  });

  it("says plainly when every speech model is down, and the daemon carries on", async () => {
    const s = await setup();
    await s.speech.stop();
    const r = await s.li.post<{ error: string }>(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/^Dictation can't be reached now/);
    const settings = (await s.li.get<ThreadSettings>(`${s.path}/settings`)).body;
    expect(settings.speech.transcribe).toEqual({ available: false, reason: "down", problem: "Dictation can't be reached now" });
    expect(settings.speech.speak).toMatchObject({ available: false, reason: "down" });
    // Read aloud too, as JSON before any audio.
    await s.turn("Hello there.");
    const read = await s.audio(`${s.path}/messages/${await s.nOf("assistant")}/speech`);
    expect(read.status).toBe(502);
    expect(((await read.json()) as { error: string }).error).toMatch(/^Read aloud can't be reached now/);
    // The daemon is fine: chat still works.
    await s.turn("Still here.");
    const page = (await s.li.get<MessagePage>(`${s.path}/messages`)).body;
    expect(page.messages.at(-1)!.parts).toEqual([{ type: "text", text: "Still here." }]);
  });
});

describe("read aloud", () => {
  it("reads her stored message sentence by sentence in each language's voice, skipping code, and records seconds only", async () => {
    const s = await setup();
    await s.turn(REPLY);
    const n = await s.nOf("assistant");
    const res = await s.audio(`${s.path}/messages/${n}/speech`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/pcm;rate=24000;encoding=s16le;channels=1");
    expect((await res.arrayBuffer()).byteLength).toBe(6 * 9600);
    expect(s.speech.heard.map((h) => [h.input, h.voice])).toEqual([
      ["Plan", "af_heart"], ["Here is the plan.", "af_heart"], ["It has two steps.", "af_heart"], ["First, run npm test!", "af_heart"],
      ["然后我们去吃饭。", "zf_xiaobei"], ["好吗？", "zf_xiaobei"],
    ]);
    const calls = (await s.li.get<CallInfo[]>(`${s.u}/models/calls`)).body.filter((c) => c.task === "speech.speak");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.audioSeconds).toBe(1.2);
    expect(JSON.stringify(calls)).not.toMatch(/plan|吃饭/);
    // Her context meter still reads the chat call.
    expect((await s.li.get<ThreadSettings>(`${s.path}/settings`)).body.answered?.task).toBe("chat");

    // Only her messages, and only ones that exist.
    expect((await s.audio(`${s.path}/messages/${await s.nOf("user")}/speech`)).status).toBe(400);
    expect((await s.audio(`${s.path}/messages/99/speech`)).status).toBe(404);
    expect((await s.audio(`${s.path}/messages/live/speech`)).status).toBe(404);
  });

  it("stops the upstream call when the client goes away", async () => {
    const s = await setup("private", { gapMs: 1500 });
    await s.turn("One sentence here. And another one. And a third.");
    const stop = new AbortController();
    const res = await s.audio(`${s.path}/messages/${await s.nOf("assistant")}/speech`, stop.signal);
    const reader = res.body!.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0);
    stop.abort();
    await new Promise((r) => setTimeout(r, 300));
    // The sentence playing, and the one asked ahead, were both cut off; no third was asked for.
    expect(s.speech.heard.length).toBeLessThanOrEqual(2);
    expect(s.speech.cut).toBe(s.speech.heard.length);
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.speech.heard.length).toBeLessThanOrEqual(2);
  });

  it("follows her message while it is still being written, to its end", async () => {
    const s = await setup();
    // A reply that streams slowly: the first word, a pause, then the rest.
    s.model.reply({ text: "First part. Second part follows here.", slowMs: 600 });
    await s.li.post(`${s.path}/messages`, { text: "talk to me" });
    await s.stream.until((e) => e.type === "text");
    const res = await s.audio(`${s.path}/messages/live/speech`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(s.speech.heard.map((h) => h.input)).toEqual(["First part.", "Second part follows here."]);
  });
});
