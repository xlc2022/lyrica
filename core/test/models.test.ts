import { describe, expect, it } from "vitest";
import { addressesOutside, CloudModelForbidden, Forbidden, NoModel } from "../src/index.ts";
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
    expect(await models.probe(li.id, "gpu")).toEqual({ state: "up" });
    models.addEndpoint(li, { name: "off", kind: "local", baseUrl: await deadUrl() });
    expect(await models.probe(li.id, "off")).toEqual({ state: "down" });
  });

  it("warns when a local endpoint is outside Li's network, and only then", async () => {
    for (const url of ["http://localhost:1234/v1", "http://192.168.1.20:1234/v1", "http://10.1.2.3/v1", "http://172.20.0.5/v1",
      "http://100.101.102.103:8080/v1", "http://[fd7a:115c:a1e0::1]:8080/v1", "http://[::1]:8080/v1"]) {
      expect(await addressesOutside(url)).toEqual([]);
    }
    expect(await addressesOutside("http://8.8.8.8/v1")).toEqual(["8.8.8.8"]);
    expect(await addressesOutside("http://[2001:db8::1]/v1")).toEqual(["2001:db8::1"]);
    expect(await addressesOutside("http://172.32.0.1/v1")).toEqual(["172.32.0.1"]);

    const { models, li } = await withModels();
    models.addEndpoint(li, { name: "odd", kind: "local", baseUrl: "http://203.0.113.7:9/v1" });
    expect((await models.probe(li.id, "odd")).warning).toContain("odd is declared local, but 203.0.113.7 resolves to 203.0.113.7");
    models.addEndpoint(li, { name: "router", kind: "cloud", baseUrl: "http://203.0.113.7:9/v1" });
    expect((await models.probe(li.id, "router")).warning).toBeUndefined();
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

  it("gives a child thread its parent's limits and the tier's model", async () => {
    const { models, li, cloudRef, localRef, ctx } = await withModels();
    models.setProfile(li.id, "cloud", "subagent.cheap", localRef);
    models.setProfile(li.id, "cloud", "subagent.strong", cloudRef);
    models.setProfile(li.id, "local", "chat", localRef);
    models.setThreadModel(li.id, "general", "web/p", "title", localRef);
    const parent = models.callContext(li.id, "general", "web/p");

    const cheap = models.childContext(parent, "web/c1", { tier: "cheap" });
    expect(models.resolveModel("chat", cheap)).toEqual(localRef);
    expect(cheap.overrides?.title).toEqual(localRef);
    expect(models.resolveModel("chat", models.childContext(parent, "web/c2", { tier: "strong" }))).toEqual(cloudRef);
    expect(models.resolveModel("chat", models.childContext(parent, "web/c3", { model: cloudRef }))).toEqual(cloudRef);

    // A private parent: only local, by tier or by name, and nothing is written when refused.
    const priv = ctx({ pool: "private", localOnly: true });
    const child = models.childContext(priv, "web/c4", { tier: "strong" });
    expect(child.localOnly).toBe(true);
    expect(models.resolveModel("chat", child)).toEqual(localRef);
    expect(() => models.childContext(priv, "web/c5", { model: cloudRef })).toThrow(CloudModelForbidden);
    expect(() => models.childContext({ ...priv, overrides: { "subagent.cheap": cloudRef } }, "web/c5", { tier: "cheap" })).toThrow(CloudModelForbidden);
    expect(models.callContext(li.id, "private", "web/c5").overrides).toEqual({});

    // A local-only parent's children are local-only.
    models.setLocalOnly(li.id, "general", "web/lo", true);
    const lo = models.childContext(models.callContext(li.id, "general", "web/lo"), "web/c6", { tier: "cheap" });
    expect(lo.localOnly).toBe(true);
    // It uses the local profile, where strong falls back to the local chat model.
    expect(models.resolveModel("chat", models.childContext(models.callContext(li.id, "general", "web/lo"), "web/c7", { tier: "strong" }))).toEqual(localRef);
  });
});
