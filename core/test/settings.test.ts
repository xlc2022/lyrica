import { describe, expect, it } from "vitest";
import { Forbidden } from "../src/index.ts";
import { fakeOpenAI } from "./fake-openai.ts";
import { profile, withModels } from "./helpers.ts";

async function setup() {
  const m = await withModels();
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const server = await fakeOpenAI({ models: [{ id: "qwen3.8-27b", meta: { n_ctx: 32768 } }] });
  const lan = m.models.addEndpoint(m.li, { name: "lan", kind: "local", baseUrl: server.baseUrl }, { shared: true });
  const [qwen] = await m.models.discover(m.li, lan.id);
  return { ...m, bob, qwen: qwen! };
}

describe("how a model answers", () => {
  it("layers a user's own values over the shared ones, for that user only, with each value's source", async () => {
    const s = await setup();
    s.models.setOfferingSettings(s.li, s.qwen.id, { temperature: 0.7, topK: 40 }, "shared");
    s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: 0.2, stop: ["END"] });
    expect(s.models.offeringSettings(s.bob.id, s.qwen.id)).toEqual({
      values: { temperature: 0.2, topK: 40, stop: ["END"] },
      sources: { temperature: "yours", topK: "shared", stop: "yours" },
      contextWindow: { value: 32768, source: "discovered" },
    });
    expect(s.models.offeringSettings(s.li.id, s.qwen.id).values).toEqual({ temperature: 0.7, topK: 40 });
    // Clearing a value falls back to the shared one.
    s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: null });
    expect(s.models.offeringSettings(s.bob.id, s.qwen.id).sources.temperature).toBe("shared");
  });

  it("lets only administrators set a shared model's values, checks each value, and reports a hand-set context window", async () => {
    const s = await setup();
    expect(() => s.models.setOfferingSettings(s.bob, s.qwen.id, { temperature: 1 }, "shared")).toThrow(Forbidden);
    expect(() => s.models.setOfferingSettings(s.li, s.localRef.offeringId, { temperature: 1 }, "shared")).toThrow(/only a shared model/);
    expect(() => s.models.setOfferingSettings(s.li, s.qwen.id, { temperature: 9 })).toThrow(/temperature is a number from 0 to 5/);
    expect(() => s.models.setOfferingSettings(s.li, s.qwen.id, { topK: 1.5 })).toThrow(/whole number/);
    expect(() => s.models.setOfferingSettings(s.li, s.qwen.id, { warmth: 1 })).toThrow(/isn't a setting/);
    s.models.setCapabilities(s.li, s.qwen.id, { contextWindow: 16384 });
    expect(s.models.offeringSettings(s.bob.id, s.qwen.id).contextWindow).toEqual({ value: 16384, source: "hand" });
  });
});
