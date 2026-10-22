import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { fakeSpeech, wav } from "../../core/test/fake-speech.ts";
import type { CallInfo, EndpointInfo, MessagePage, Presets, Speech, ThreadSettings, ThreadSummary, Transcription } from "../src/api.ts";
import { Memory, Users } from "@lyrica/core";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { languageOf, messageText, sentences, speakable, titlesIn } from "../src/speech.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const VOICES = [{ id: "af_heart", language: "en" }, { id: "zf_xiaobei", language: "zh" }];

/** Lyricad unlocked, Ada logged in, a local chat model, a local speech endpoint for both speech tasks, and a thread in `pool`. */
async function setup(pool: "general" | "private" = "private", speechOpts: { gapMs?: number } = {}) {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const speech = await fakeSpeech(speechOpts);
  const u = `/api/u/${rt.ada.id}`;
  const ep = (await ada.post<EndpointInfo>(`${u}/endpoints`, { name: "speech", kind: "local", baseUrl: speech.baseUrl })).body;
  const id = (m: string) => ep.models.find((x) => x.modelId === m)!.id;
  const ok = async (r: Promise<{ status: number; body: unknown }>) => { const x = await r; if (x.status !== 200) throw new Error(JSON.stringify(x.body)); };
  await ok(ada.patch(`${u}/offerings/${id("whisper-large-v3-turbo")}`, { transcribe: true }));
  await ok(ada.patch(`${u}/offerings/${id("kokoro")}`, { speak: { voices: VOICES } }));
  for (const p of ["private", "general"]) {
    await ok(ada.put(`${u}/columns/${p}/speech.transcribe`, { model: { offeringId: id("whisper-large-v3-turbo") } }));
    await ok(ada.put(`${u}/columns/${p}/speech.speak`, { model: { offeringId: id("kokoro") } }));
  }
  const thread = (await ada.post<ThreadSummary>(`${u}/threads`, { pool, title: "speech" })).body;
  const path = `${u}/threads/${pool}/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  const turn = async (reply: string, text = "say something") => {
    const ends = stream.events.filter((e) => e.event.type === "turn_end").length;
    model.reply({ text: reply });
    await ada.post(`${path}/messages`, { text });
    await stream.until((e) => e.type === "turn_end" && stream.events.filter((x) => x.event.type === "turn_end").length > ends, 0, 20_000);
  };
  const nOf = async (role: "user" | "assistant") => (await ada.get<MessagePage>(`${path}/messages`)).body.messages.filter((m) => m.role === role).at(-1)!.n;
  const audio = (p: string, signal?: AbortSignal) => fetch(dm.base + p, { headers: { cookie: ada.cookie! }, ...(signal ? { signal } : {}) });
  return { rt, ...dm, ada, u, model, speech, ep, id, thread, path, stream, turn, audio, nOf };
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

describe("thread mentions read aloud", () => {
  it("read as the thread's current title, and a general message never names a private thread", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const o = new Memory(keyring, users).openOwnerView(ada.id);
    const g = o.general.createThread({ interface: "web", title: "Garden" });
    const p = o.private.createThread({ interface: "web", title: "Doctor" });
    const said = (text: string) => [{ type: "text" as const, text }];
    o.general.setTitle(g.id, "Spring garden");
    expect(messageText(said(`See [t:${g.id}] and [e:${g.id}#2].`), titlesIn(o, "general"))).toBe("See Spring garden and Spring garden.");
    expect(messageText(said(`See [private/t:${p.id}] and [t:${p.id}].`), titlesIn(o, "general"))).toBe("See a forgotten thread and a forgotten thread.");
    expect(messageText(said(`See [t:${p.id}] and [general/t:${g.id}].`), titlesIn(o, "private"))).toBe("See Doctor and Spring garden.");
    o.close();
  });
});

describe("dictation", () => {
  it("transcribes a clip in a thread and on the welcome page, records the seconds and model only, and writes no file", async () => {
    const s = await setup();
    // A temp dir of its own, so other test files' temp files don't count.
    const tmp = mkdtempSync(join(tmpdir(), "lyrica-speech-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const r = await s.ada.post<Transcription>(`${s.path}/transcribe?language=zh`, wav(3), { "content-type": "audio/wav" });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ text: "hello from the fake", seconds: 3, model: "speech/whisper-large-v3-turbo" });
      expect(s.speech.heard.at(-1)).toMatchObject({ url: "/v1/audio/transcriptions", language: "zh", bytes: 96_044 });
      const threads = (await s.ada.get(`${s.u}/threads`)).body;
      const welcome = await s.ada.post<Transcription>(`${s.u}/transcribe?pool=private`, wav(1), { "content-type": "audio/wav" });
      expect(welcome.status).toBe(200);
      expect(welcome.body.text).toBe("hello from the fake");
      expect((await s.ada.get(`${s.u}/threads`)).body).toEqual(threads);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
      rmSync(tmp, { recursive: true, force: true });
    }

    const calls = (await s.ada.get<CallInfo[]>(`${s.u}/models/calls`)).body.filter((c) => c.task === "speech.transcribe");
    expect(calls.map((c) => c.audioSeconds).sort()).toEqual([1, 3]); // two calls in the same millisecond may come either way
    expect(JSON.stringify(calls)).not.toMatch(/hello from the fake/);
    expect(s.logs.join("\n")).not.toMatch(/hello from the fake/);

    // Not a WAV clip, or too long.
    expect((await s.ada.post(`${s.path}/transcribe`, Buffer.from("plain words"), { "content-type": "audio/wav" })).status).toBe(400);
    expect((await s.ada.post(`${s.path}/transcribe`, Buffer.from("x"), { "content-type": "audio/webm" })).status).toBe(415);
    expect((await s.ada.post(`${s.path}/transcribe`, wav(601), { "content-type": "audio/wav" })).status).toBe(413);
  });

  it("sends a thread's voice to a cloud model only when Dictation picks it there", async () => {
    const s = await setup("general");
    const cloud = await fakeSpeech();
    const ep = (await s.ada.post<EndpointInfo>(`${s.u}/endpoints`, { name: "openai", kind: "cloud", baseUrl: cloud.baseUrl, apiKey: "sk" })).body;
    const stt = ep.models.find((m) => m.modelId === "whisper-large-v3-turbo")!.id;
    await s.ada.patch(`${s.u}/offerings/${stt}`, { transcribe: true });
    await s.ada.put(`${s.u}/columns/general/speech.transcribe`, { model: { offeringId: stt } });

    // The General column names it, but without the thread's pick the Private column's model hears the clip.
    let settings = (await s.ada.get<ThreadSettings>(`${s.path}/settings`)).body;
    expect(settings.models["speech.transcribe"]).toMatchObject({ source: "column", kind: "local" });
    // An optional task nobody set says so in its select, with no problem beside it.
    expect(settings.models["image.upscale"]).toEqual({ source: "none" });
    expect(settings.speech.transcribe).toMatchObject({ available: true, kind: "local" });
    expect((await s.ada.post(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" })).status).toBe(200);
    expect(cloud.heard).toEqual([]);
    expect((await s.ada.get<Speech>(`${s.u}/speech?pool=general`)).body).toMatchObject({ transcribe: { available: true, kind: "local" } });

    // Read aloud while agent writes is a user setting, off by default, that ThreadSettings.speech carries.
    expect(settings.speech.readAloudLive).toBe(false);
    expect((await s.ada.patch<Presets>(`${s.u}/presets`, { readAloudLive: true })).body.readAloudLive).toBe(true);
    expect((await s.ada.get<ThreadSettings>(`${s.path}/settings`)).body.speech.readAloudLive).toBe(true);
    expect((await s.ada.patch(`${s.u}/presets`, { readAloudLive: "yes" })).status).toBe(400);
    // Picked in the thread's Dictation select: the cloud model hears it.
    settings = (await s.ada.patch<ThreadSettings>(`${s.path}/settings`, { models: { "speech.transcribe": { offeringId: stt } } })).body;
    expect(settings.speech.transcribe).toMatchObject({ available: true, kind: "cloud" });
    expect((await s.ada.post(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" })).status).toBe(200);
    expect(cloud.heard).toHaveLength(1);

    // A local-only thread can't keep a cloud pick.
    expect((await s.ada.patch(`${s.path}/settings`, { localOnly: true })).status).toBe(400);
  });

  it("says plainly when every speech model is down, and the daemon carries on", async () => {
    const s = await setup();
    await s.speech.stop();
    const r = await s.ada.post<{ error: string; code: string }>(`${s.path}/transcribe`, wav(1), { "content-type": "audio/wav" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/^no model for Dictation can be reached now/);
    expect(r.body).toMatchObject({ code: "offline", task: "speech.transcribe", tried: [{ label: "speech/whisper-large-v3-turbo" }] });
    const settings = (await s.ada.get<ThreadSettings>(`${s.path}/settings`)).body;
    expect(settings.speech.transcribe).toEqual({ available: false, reason: "down", problem: "Dictation can't be reached now" });
    expect(settings.speech.speak).toMatchObject({ available: false, reason: "down" });
    // Read aloud too, as JSON before any audio.
    await s.turn("Hello there.");
    const read = await s.audio(`${s.path}/messages/${await s.nOf("assistant")}/speech`);
    expect(read.status).toBe(502);
    expect(((await read.json()) as { error: string }).error).toMatch(/^no model for Read aloud can be reached now/);
    // The daemon is fine: chat still works.
    await s.turn("Still here.");
    const page = (await s.ada.get<MessagePage>(`${s.path}/messages`)).body;
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
    const calls = (await s.ada.get<CallInfo[]>(`${s.u}/models/calls`)).body.filter((c) => c.task === "speech.speak");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.audioSeconds).toBe(1.2);
    expect(JSON.stringify(calls)).not.toMatch(/plan|吃饭/);
    // Her context meter still reads the chat call.
    expect((await s.ada.get<ThreadSettings>(`${s.path}/settings`)).body.answered?.task).toBe("chat");

    // Only her messages, and only ones that exist.
    expect((await s.audio(`${s.path}/messages/${await s.nOf("user")}/speech`)).status).toBe(400);
    expect((await s.audio(`${s.path}/messages/99/speech`)).status).toBe(404);
    // Live with nothing being written reads her last message: pressed just as she finished.
    const late = await s.audio(`${s.path}/messages/live/speech`);
    expect(late.status).toBe(200);
    expect((await late.arrayBuffer()).byteLength).toBeGreaterThan(0);
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
    await s.ada.post(`${s.path}/messages`, { text: "talk to me" });
    await s.stream.until((e) => e.type === "text");
    const res = await s.audio(`${s.path}/messages/live/speech`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(s.speech.heard.map((h) => h.input)).toEqual(["First part.", "Second part follows here."]);
  });
});
