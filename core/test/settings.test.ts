import { describe, expect, it } from "vitest";
import { acceptedSettings, Forbidden, payloadFields, replyCap } from "../src/index.ts";
import { fakeOpenAI } from "./fake-openai.ts";
import { profile, withModels } from "./helpers.ts";

async function setup() {
  const m = await withModels();
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const server = await fakeOpenAI({ models: [{ id: "qwen3.8-27b", meta: { n_ctx: 32768 } }] });
  const lan = m.models.addEndpoint(m.ada, { name: "lan", kind: "local", baseUrl: server.baseUrl }, { shared: true });
  const [qwen] = await m.models.discover(m.ada, lan.id);
  return { ...m, bob, qwen: qwen! };
}

describe("how a model answers", () => {
  it("caps a reply at a quarter of the context and the model's own limit, at most 131,072 tokens locally or with a known limit, else 32,768", () => {
    const local = { local: true };
    expect([replyCap(1_048_576, local), replyCap(262_144, local), replyCap(32_768, local), replyCap(undefined, local)]).toEqual([131_072, 65_536, 8192, 32_768]);
    expect([replyCap(1_048_576), replyCap(1_048_576, { maxOutput: 524_288 }), replyCap(1_048_576, { maxOutput: 8192 })]).toEqual([32_768, 131_072, 8192]);
  });

  it("reports the sampling a model gives as its own, and a window it assumes when nothing says", async () => {
    const m = await withModels();
    const server = await fakeOpenAI({ models: [
      { id: "vendor/chat", context_length: 200_000, default_parameters: { temperature: 0.6, top_p: 0.95, frequency_penalty: null } },
      { id: "bare" },
      { id: "served-by-vllm", max_model_len: 32_768 },
    ] });
    const ep = m.models.addEndpoint(m.ada, { name: "router", kind: "cloud", baseUrl: server.baseUrl, apiKey: "k" });
    const [bare, vllm, chat] = await m.models.discover(m.ada, ep.id);
    expect(m.models.offeringSettings(m.ada.id, vllm!.id).contextWindow).toEqual({ value: 32_768, source: "discovered" });
    expect(m.models.offeringSettings(m.ada.id, chat!.id)).toMatchObject({ values: {}, defaults: { temperature: 0.6, topP: 0.95 }, contextWindow: { value: 200_000, source: "discovered" } });
    expect(m.models.offeringSettings(m.ada.id, bare!.id)).toMatchObject({ defaults: {}, contextWindow: { value: 131_072, source: "assumed" } });
  });

  it("layers a user's own values over the shared ones, for that user only, with each value's source", async () => {
    const s = await setup();
    s.models.setOfferingSettings(s.ada, s.qwen.id, { temperature: 0.7, topK: 40 }, "shared");
    s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: 0.2, stop: ["END"] });
    expect(s.models.offeringSettings(s.bob.id, s.qwen.id)).toEqual({
      values: { temperature: 0.2, topK: 40, stop: ["END"] },
      sources: { temperature: "yours", topK: "shared", stop: "yours" },
      dropped: [],
      defaults: {},
      contextWindow: { value: 32768, source: "discovered" },
    });
    expect(s.models.offeringSettings(s.ada.id, s.qwen.id).values).toEqual({ temperature: 0.7, topK: 40 });
    // Clearing a value falls back to the shared one.
    s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: null });
    expect(s.models.offeringSettings(s.bob.id, s.qwen.id).sources.temperature).toBe("shared");
  });

  it("lets only administrators set a shared model's values, checks each value, and reports a hand-set context window", async () => {
    const s = await setup();
    expect(() => s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: 1 }, "shared")).toThrow(Forbidden);
    expect(() => s.models.setOfferingSettings(s.ada, s.localRef.offeringId, { temperature: 1 }, "shared")).toThrow(/only a shared model/);
    expect(() => s.models.setOfferingSettings(s.ada, s.qwen.id, { temperature: 9 })).toThrow(/temperature is a number from 0 to 5/);
    expect(() => s.models.setOfferingSettings(s.ada, s.qwen.id, { topK: 1.5 })).toThrow(/whole number/);
    expect(() => s.models.setOfferingSettings(s.ada, s.qwen.id, { warmth: 1 })).toThrow(/isn't a setting/);
    s.models.setCapabilities(s.ada, s.qwen.id, { contextWindow: 16384 });
    expect(s.models.offeringSettings(s.bob.id, s.qwen.id).contextWindow).toEqual({ value: 16384, source: "hand" });
  });

  it("keeps saved values through Reset IDs, for the shared model and a locked user's own", async () => {
    const s = await setup();
    s.models.setOfferingSettings(s.ada, s.qwen.id, { topK: 40 }, "shared");
    s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: 0.2 });
    s.keyring.lockUser(s.bob.id);
    const fresh = s.models.resetIds(s.ada, s.qwen.endpointId);
    const now = s.models.offerings(s.ada.id, fresh)[0]!;
    expect(now.id).not.toBe(s.qwen.id);
    await s.users.authenticate("bob", "pw");
    expect(s.models.offeringSettings(s.bob.id, now.id).values).toEqual({ temperature: 0.2, topK: 40 });
    // And nightly pruning doesn't take them.
    s.models.prune();
    expect(s.models.offeringSettings(s.bob.id, now.id).values).toEqual({ temperature: 0.2, topK: 40 });
  });

  it("prunes the settings of a model that's gone", async () => {
    const s = await setup();
    s.models.setOfferingSettings(s.ada, s.qwen.id, { topK: 40 }, "shared");
    s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: 0.2 });
    s.models.removeOffering(s.ada, s.qwen.id);
    s.models.prune();
    expect(s.keyring.self().prepare("SELECT count(*) AS n FROM offering_settings").get()).toEqual({ n: 0 });
    const db = s.users.openUserDb(s.bob.id);
    expect(db.prepare("SELECT count(*) AS n FROM offering_settings").get()).toEqual({ n: 0 });
    db.close();
  });

  it("sends a cloud API only what it accepts, says what isn't sent, and never asks for a longer reply than fits", async () => {
    const s = await setup();
    const openai = { kind: "cloud" as const, baseUrl: "https://api.openai.com/v1" };
    expect(acceptedSettings({ kind: "cloud", baseUrl: "https://openrouter.ai/api/v1" })).toContain("topK");
    expect(payloadFields({ temperature: 0.5, topK: 40, minP: 0.1, maxTokens: 5000 }, "repetition_penalty", { max_completion_tokens: 2000 }, acceptedSettings(openai)))
      .toEqual({ temperature: 0.5, max_completion_tokens: 2000 });
    const cloud = s.models.offerings(s.ada.id, s.openrouter.id)[0]!;
    s.models.setOfferingSettings(s.ada, cloud.id, { temperature: 0.5, topK: 40, stop: [] });
    expect(s.models.offeringSettings(s.ada.id, cloud.id)).toMatchObject({ values: { temperature: 0.5, topK: 40 }, dropped: ["topK"] });
  });
});
