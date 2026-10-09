import { describe, expect, it } from "vitest";
import { CloudModelForbidden, Forbidden, NoModel } from "../src/index.ts";
import { deadUrl } from "./fake-openai.ts";
import { profile, withModels } from "./helpers.ts";

describe("endpoints", () => {
  it("records discovered models with their context window and tool support", async () => {
    const { models, li } = await withModels();
    expect(models.models(li.id, "openrouter")).toEqual([
      { endpointId: "openrouter", modelId: "deepseek/deepseek-4.1-flash", contextWindow: 128000, tools: true, manual: false },
    ]);
    expect(models.models(li.id, "gpu")).toEqual([{ endpointId: "gpu", modelId: "qwen3.8-27b", contextWindow: 32768, manual: false }]);
    models.addModel(li, "gpu", { modelId: "qwen3.8-flash", contextWindow: 8192, tools: true });
    await models.discover(li, "gpu");
    expect(models.models(li.id, "gpu").map((m) => [m.modelId, m.manual])).toEqual([["qwen3.8-27b", false], ["qwen3.8-flash", true]]);
  });

  it("probe reports up and down", async () => {
    const { models, li } = await withModels();
    expect(await models.probe(li.id, "gpu")).toBe("up");
    models.addEndpoint(li, { name: "off", kind: "local", baseUrl: await deadUrl() });
    expect(await models.probe(li.id, "off")).toBe("down");
  });

  it("shares administrator endpoints with every user, and only administrators change them", async () => {
    const { models, users, li, local } = await withModels();
    const bob = await users.createUser("bob", "pw", profile("Bob"), { admin: false });
    await users.authenticate("bob", "pw");
    models.addEndpoint(li, { name: "lan", kind: "local", baseUrl: local.baseUrl }, { shared: true });
    await models.discover(li, "shared.lan");
    expect(models.endpoints(bob.id).map((e) => e.id)).toEqual(["shared.lan"]);
    models.setProfile(bob.id, "local", "chat", { endpointId: "shared.lan", modelId: "qwen3.8-27b" });
    expect(models.resolveModel("chat", { userId: bob.id, pool: "private", localOnly: true }).endpointId).toBe("shared.lan");
    expect(() => models.addEndpoint(bob, { name: "x", kind: "local", baseUrl: local.baseUrl }, { shared: true })).toThrow(Forbidden);
    expect(() => models.removeEndpoint(bob, "shared.lan")).toThrow(Forbidden);
    // Li's own endpoints stay hers.
    expect(models.endpoints(bob.id).some((e) => e.id === "gpu")).toBe(false);
  });
});

describe("the router", () => {
  it("lets a thread's override beat the profile", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setProfile(li.id, "cloud", "chat", cloudRef);
    expect(models.resolveModel("chat", ctx())).toEqual(cloudRef);
    models.setThreadModel(li.id, "general", "web/t1", "chat", localRef);
    expect(models.resolveModel("chat", models.callContext(li.id, "general", "web/t1"))).toEqual(localRef);
    expect(models.resolveModel("chat", models.callContext(li.id, "general", "web/t2"))).toEqual(cloudRef);
  });

  it("falls back to the chat model within the same profile, except for embeddings", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setProfile(li.id, "cloud", "chat", cloudRef);
    models.setProfile(li.id, "local", "chat", localRef);
    expect(models.resolveModel("compaction", ctx())).toEqual(cloudRef);
    expect(models.resolveModel("subagent.cheap", ctx({ pool: "private", localOnly: true }))).toEqual(localRef);
    expect(() => models.resolveModel("embedding", ctx())).toThrow(NoModel);
  });

  it("never gives a private or local-only thread a cloud model, and never falls back across the line", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setProfile(li.id, "cloud", "chat", cloudRef);
    // No local chat model: a private thread gets an error, not the cloud one.
    expect(() => models.resolveModel("chat", ctx({ pool: "private", localOnly: true }))).toThrow(NoModel);
    // A cloud override in a local-only context throws, even if handed in directly.
    expect(() => models.resolveModel("chat", ctx({ localOnly: true, overrides: { chat: cloudRef } }))).toThrow(CloudModelForbidden);
    expect(() => models.resolveModel("subagent.strong", ctx({ pool: "private", localOnly: true, overrides: { "subagent.strong": cloudRef } }))).toThrow(CloudModelForbidden);
    // Settings refuse cloud models where they can't be used.
    expect(() => models.setProfile(li.id, "local", "chat", cloudRef)).toThrow(CloudModelForbidden);
    expect(() => models.setThreadModel(li.id, "private", "web/p", "chat", cloudRef)).toThrow(CloudModelForbidden);
    models.setLocalOnly(li.id, "general", "web/g", true);
    expect(models.callContext(li.id, "general", "web/g").localOnly).toBe(true);
    expect(() => models.setThreadModel(li.id, "general", "web/g", "chat", cloudRef)).toThrow(CloudModelForbidden);
    expect(() => models.setLocalOnly(li.id, "private", "web/p", false)).toThrow(CloudModelForbidden);
    expect(models.callContext(li.id, "private", "web/p").localOnly).toBe(true);
    // Only local endpoints are offered there at all.
    expect(models.allowed(ctx({ pool: "private", localOnly: true })).map((a) => a.endpoint.id)).toEqual(["gpu"]);
    models.setProfile(li.id, "local", "chat", localRef);
    expect(models.resolveModel("chat", ctx({ pool: "private", localOnly: true }))).toEqual(localRef);
  });

  it("refuses models that aren't recorded on their endpoint", async () => {
    const { models, li } = await withModels();
    expect(() => models.setProfile(li.id, "cloud", "chat", { endpointId: "gpu", modelId: "nope" })).toThrow(NoModel);
    expect(() => models.setProfile(li.id, "cloud", "chat", { endpointId: "nope", modelId: "m" })).toThrow(NoModel);
  });
});
