import { describe, expect, it } from "vitest";
import { CloudModelForbidden, NoModel, Offline, VoiceCloudOff, type CallContext } from "../src/index.ts";
import { fakeHost } from "./fake-host.ts";
import { deadUrl } from "./fake-openai.ts";
import { fakeSpeech, wav } from "./fake-speech.ts";
import { profile, withModels } from "./helpers.ts";

const VOICES = [{ id: "af_heart", language: "en" }, { id: "zf_xiaobei", language: "zh" }, { id: "zm_yunxi", language: "zh" }];

/**
 * Li with a cloud speech endpoint ("openai") and a local one ("speech"),
 * each with a Dictation and a Read aloud model set by hand, in the cloud
 * and local profiles.
 */
async function setup() {
  const m = await withModels();
  const { models, li } = m;
  const add = async (name: string, kind: "cloud" | "local") => {
    const server = await fakeSpeech({ label: name });
    const ep = models.addEndpoint(li, { name, kind, baseUrl: server.baseUrl });
    const found = await models.discover(li, ep.id);
    const stt = models.setCapabilities(li, found.find((o) => o.modelId === "whisper-large-v3-turbo")!.id, { transcribe: true });
    const tts = models.setCapabilities(li, found.find((o) => o.modelId === "kokoro")!.id, { speak: { voices: VOICES } });
    return { server, ep, stt: { offeringId: stt.id }, tts: { offeringId: tts.id } };
  };
  const openai = await add("openai", "cloud");
  const speech = await add("speech", "local");
  models.setProfile(li.id, "cloud", "speech.transcribe", [openai.stt]);
  models.setProfile(li.id, "cloud", "speech.speak", [openai.tts]);
  models.setProfile(li.id, "local", "speech.transcribe", [speech.stt]);
  models.setProfile(li.id, "local", "speech.speak", [speech.tts]);
  return { ...m, openai, speech };
}

const read = async (s: ReadableStream<Uint8Array>) => { let n = 0; for await (const c of s as unknown as AsyncIterable<Uint8Array>) n += c.length; return n; };

describe("speech and the cloud boundary", () => {
  it("never sends a private or local-only thread's audio or text to a cloud speech model", async () => {
    const s = await setup();
    // A local profile can't hold one, and a thread list naming one is refused.
    expect(() => s.models.setProfile(s.li.id, "local", "speech.transcribe", [s.openai.stt])).toThrow(CloudModelForbidden);
    expect(() => s.models.setThreadModel(s.li.id, "private", "web/p", "speech.speak", [s.openai.tts])).toThrow(CloudModelForbidden);
    // Even a context that names one directly, with Voice to cloud on.
    for (const ctx of [s.ctx({ pool: "private", localOnly: true }), s.ctx({ localOnly: true })]) {
      const named: CallContext = { ...ctx, voiceCloud: true, overrides: { "speech.transcribe": [s.openai.stt], "speech.speak": [s.openai.tts] } };
      await expect(s.models.transcribe(named, wav(1))).rejects.toThrow(CloudModelForbidden);
      await expect(s.models.speak(named, "Hello there.")).rejects.toThrow(CloudModelForbidden);
      // With the profile's lists, the local models answer.
      expect((await s.models.transcribe({ ...ctx, voiceCloud: true }, wav(1))).resolution.label).toBe("speech/whisper-large-v3-turbo");
      expect(await read((await s.models.speak(ctx, "Hello there.")).audio)).toBe(9600);
    }
    expect(s.openai.server.heard).toEqual([]);
  });

  it("with Voice to cloud off, refuses a cloud transcription before any byte is sent, and a thread's choice beats the default", async () => {
    const s = await setup();
    const general = s.models.callContext(s.li.id, "general", "web/g");
    expect(general.voiceCloud).toBe(false); // off by default
    await expect(s.models.transcribe(general, wav(2))).rejects.toThrow(VoiceCloudOff);
    expect(s.models.speechModel("speech.transcribe", general)).toEqual({ reason: "voiceCloud", problem: "openai/whisper-large-v3-turbo is a cloud model, and Voice to cloud is off" });
    expect(s.openai.server.heard).toEqual([]);

    // Her text read aloud is message text: the router's rules alone.
    await read((await s.models.speak(general, "Hello there.")).audio);
    expect(s.openai.server.heard).toHaveLength(1);

    s.models.setDefaultVoiceCloud(s.li.id, true);
    const on = await s.models.transcribe(s.models.callContext(s.li.id, "general", "web/g"), wav(2), { language: "zh" });
    expect(on).toMatchObject({ text: "hello from the fake", audioSeconds: 2 });
    expect(s.openai.server.heard.at(-1)).toMatchObject({ url: "/v1/audio/transcriptions", model: "whisper-large-v3-turbo", language: "zh", bytes: 64_044 });

    // The thread says off: off, whatever the default.
    s.models.setThreadVoiceCloud(s.li.id, "web/g", false);
    expect(s.models.threadVoiceCloud(s.li.id, "web/g")).toBe(false);
    await expect(s.models.transcribe(s.models.callContext(s.li.id, "general", "web/g"), wav(1))).rejects.toThrow(VoiceCloudOff);
    // A branch of it keeps it off; null follows the default again.
    expect(s.models.inheritContext(s.models.callContext(s.li.id, "general", "web/g"), "web/branch").voiceCloud).toBe(false);
    s.models.setThreadVoiceCloud(s.li.id, "web/g", null);
    expect(s.models.callContext(s.li.id, "general", "web/g").voiceCloud).toBe(true);
    expect(s.openai.server.heard.filter((h) => h.url === "/v1/audio/transcriptions")).toHaveLength(1);
  });
});

describe("speech fallbacks", () => {
  it("falls back to the next model of the same kind when one is down, and records which answered", async () => {
    const s = await setup();
    const off = s.models.addEndpoint(s.li, { name: "off", kind: "local", baseUrl: await deadUrl() });
    const dead = { offeringId: s.models.addModel(s.li, off.id, { modelId: "whisper", transcribe: true }).id };
    s.models.setProfile(s.li.id, "local", "speech.transcribe", [dead, s.speech.stt]);
    const ctx = s.ctx({ pool: "private", localOnly: true });
    const out = await s.models.transcribe(ctx, wav(1));
    expect(out.resolution.label).toBe("speech/whisper-large-v3-turbo");
    s.models.recordCall(s.li.id, { pool: "private", threadId: "web/p", task: "speech.transcribe", resolution: out.resolution, audioSeconds: out.audioSeconds! });
    const [call] = s.models.recentCalls(s.li.id);
    expect(call).toMatchObject({ task: "speech.transcribe", label: "speech/whisper-large-v3-turbo", audioSeconds: 1, fallback: "off/whisper was skipped (off is down), so speech/whisper-large-v3-turbo answered" });
    // A call record holds labels, reasons and seconds, never text or audio.
    expect(Object.keys(call!).sort()).toEqual(["at", "audioSeconds", "endpointName", "fallback", "kind", "label", "offeringId", "pool", "task", "threadId"]);
    expect(JSON.stringify(s.models.recentCalls(s.li.id))).not.toMatch(/hello from the fake/);
  });

  it("falls back when a model fails as it is called, and never crosses from cloud to local", async () => {
    const s = await setup();
    const spare = await fakeSpeech({ label: "spare" });
    const ep = s.models.addEndpoint(s.li, { name: "spare", kind: "cloud", baseUrl: spare.baseUrl });
    const found = await s.models.discover(s.li, ep.id);
    const tts = { offeringId: s.models.setCapabilities(s.li, found.find((o) => o.modelId === "kokoro")!.id, { speak: { voices: VOICES } }).id };
    s.models.setProfile(s.li.id, "cloud", "speech.speak", [s.openai.tts, tts]);
    s.openai.server.fail(503);
    const general = s.ctx();
    const spoken = await s.models.speak(general, "Hello there.");
    expect(spoken.resolution.label).toBe("spare/kokoro");
    expect(await read(spoken.audio)).toBe(9600);

    // Every cloud model down: a plain refusal, not the local model and not a crash.
    spare.fail(502);
    s.models.setProfile(s.li.id, "cloud", "speech.speak", [tts]);
    await expect(s.models.speak(general, "Hello again.")).rejects.toThrow(Offline);
    await expect(s.models.speak(general, "Hello again.")).rejects.toThrow(/^no model for speech.speak can be reached now/);
    expect(s.speech.server.heard).toEqual([]);
  });

  it("refuses what a model refuses, plainly, without falling back", async () => {
    const s = await setup();
    s.speech.server.fail(400, { error: { message: "unsupported audio" } });
    const ctx = s.ctx({ pool: "private", localOnly: true });
    await expect(s.models.transcribe(ctx, wav(1))).rejects.toThrow("speech refused the request (400: unsupported audio)");
    expect(s.speech.server.heard).toEqual([]); // the fake refused before recording; nothing else was tried
    expect(s.models.speechModel("speech.transcribe", ctx)).toMatchObject({ label: "speech/whisper-large-v3-turbo" });
    await expect(s.models.transcribe(ctx, Buffer.from("not a wav file at all, just some text"))).rejects.toThrow(/isn't PCM WAV/);
  });

  it("says plainly when no speech model is set, and never follows chat", async () => {
    const s = await setup();
    const bob = await s.users.createUser("bob", "pw", profile("Bob"), { admin: false });
    await s.users.authenticate("bob", "pw");
    s.models.setProfile(bob.id, "local", "chat", [s.localRef].filter(() => false));
    const ctx: CallContext = { userId: bob.id, pool: "private", localOnly: true };
    await expect(s.models.transcribe(ctx, wav(1))).rejects.toThrow(NoModel);
    expect(s.models.speechModel("speech.speak", ctx)).toEqual({ reason: "none", problem: "No Read aloud model is set in the local profile" });
    // A chat model can't be made a speech model.
    expect(() => s.models.setProfile(s.li.id, "local", "speech.transcribe", [s.localRef])).toThrow(/can't do speech.transcribe/);
    expect(() => s.models.setProfile(s.li.id, "local", "speech.speak", { same: "chat" })).toThrow(/same kind of model/);
  });
});

describe("speaking", () => {
  it("uses the voice for the language and the speed, layered shared then yours, and cancelling stops the upstream call", async () => {
    const s = await setup();
    const slow = await fakeSpeech({ gapMs: 2000 });
    const ep = s.models.addEndpoint(s.li, { name: "slow", kind: "local", baseUrl: slow.baseUrl });
    const found = await s.models.discover(s.li, ep.id);
    const tts = { offeringId: s.models.setCapabilities(s.li, found.find((o) => o.modelId === "kokoro")!.id, { speak: { voices: VOICES } }).id };
    s.models.setProfile(s.li.id, "local", "speech.speak", [tts]);
    const ctx = s.ctx({ pool: "private", localOnly: true });

    // No setting: the model's first voice for the language.
    await (await s.models.speak(ctx, "你好。", { language: "zh" })).audio.cancel();
    expect(slow.heard.at(-1)).toMatchObject({ input: "你好。", voice: "zf_xiaobei", format: "pcm" });
    s.models.setOfferingSettings(s.li, tts.offeringId, { voices: { zh: "zm_yunxi" }, speed: 1.25 });
    expect(s.models.offeringSettings(s.li.id, tts.offeringId)).toMatchObject({ values: { voices: { zh: "zm_yunxi" }, speed: 1.25 }, sources: { voices: "yours", speed: "yours" }, dropped: [] });
    const spoken = await s.models.speak(ctx, "你好。", { language: "zh" });
    expect(slow.heard.at(-1)).toMatchObject({ voice: "zm_yunxi", speed: 1.25 });
    // The first chunk arrives; cancelling ends the upstream call before its second.
    const reader = spoken.audio.getReader();
    expect((await reader.read()).value).toHaveLength(4800);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(slow.cut).toBe(2);

    expect(() => s.models.setOfferingSettings(s.li, tts.offeringId, { speed: 9 })).toThrow("speed is a number from 0.25 to 4");
    expect(() => s.models.setOfferingSettings(s.li, tts.offeringId, { voices: { chinese: "x" } })).toThrow(/language tags/);
  });

  it("reads a host's speech models from its discovery, calls them over its pinned connection, and falls back when its speech server is off, leaving chat on the host", async () => {
    const s = await setup();
    const host = await fakeHost({ name: "lyrica-3090", models: [
      { id: "lyrica/huggingface/Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf", kind: "chat", contextLength: 32768 },
      { id: "lyrica/huggingface/openai/whisper-large-v3-turbo", kind: "transcribe" },
      { id: "lyrica/huggingface/onnx-community/Kokoro-82M-v1.0-ONNX", kind: "speak", voices: [...VOICES, { id: "bad", language: "Mandarin" }] },
    ] });
    const ep = await s.models.pairHost(s.li, { name: "3090", addresses: [host.address], code: host.newCode() });
    const found = await s.models.discover(s.li, ep.id);
    const [chat, stt, tts] = ["Qwen3.8", "whisper", "Kokoro"].map((n) => found.find((o) => o.modelId.includes(n))!);
    expect(stt).toMatchObject({ transcribe: true });
    expect(stt!.speak).toBeUndefined();
    expect(tts).toMatchObject({ speak: { voices: VOICES } }); // a malformed voice is left out
    expect(chat!.transcribe).toBeUndefined();
    s.models.setProfile(s.li.id, "local", "chat", [{ offeringId: chat!.id }]);
    s.models.setProfile(s.li.id, "local", "speech.transcribe", [{ offeringId: stt!.id }]);
    s.models.setProfile(s.li.id, "local", "speech.speak", [{ offeringId: tts!.id }, s.speech.tts]);
    const ctx = s.ctx({ pool: "private", localOnly: true });

    expect((await s.models.transcribe(ctx, wav(1))).text).toBe("heard on the host");
    expect(await read((await s.models.speak(ctx, "Hello.")).audio)).toBe(4800);
    expect(host.speech).toEqual(["/v1/audio/transcriptions", "/v1/audio/speech"]);

    // The host's speech server is off: Read aloud falls back to the next voice model, Dictation, with no other, is
    // offline, and chat stays on the host.
    host.speechOff();
    expect((await s.models.speak(ctx, "Hello.")).resolution.label).toBe("speech/kokoro");
    await expect(s.models.transcribe(ctx, wav(1))).rejects.toThrow(Offline);
    expect(s.models.resolve("chat", ctx).endpoint.id).toBe(ep.id);
    // The whole host off: the thread's settings say so before anything is tried.
    await host.stop();
    s.models.reportDown(ep.id);
    expect(s.models.speechModel("speech.transcribe", ctx)).toEqual({ reason: "down", problem: "Dictation can't be reached now" });

    const lib = s.models.textLibrary(s.li.id, { capability: "speak" });
    expect(lib.entries.flatMap((e) => e.copies.map((c) => c.label)).sort()).toEqual(["3090/lyrica/huggingface/onnx-community/Kokoro-82M-v1.0-ONNX", "openai/kokoro", "speech/kokoro"]);
    expect(() => s.models.setCapabilities(s.li, s.speech.tts.offeringId, { speak: { voices: [{ id: "x", language: "Mandarin" }] } })).toThrow(/language is a tag/);
  });
});
