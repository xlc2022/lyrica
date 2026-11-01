import { describe, expect, it } from "vitest";
import { CloudModelForbidden, Offline, queryText, type CallContext } from "../src/index.ts";
import { fakeEmbed, toyVector } from "./fake-embed.ts";
import { withModels } from "./helpers.ts";

/** Ada with a cloud embedding endpoint ("api"), a GPU host ("gpu") and a CPU one ("cpu") serving the same model file. */
async function setup() {
  const m = await withModels();
  const { models, ada } = m;
  const add = async (name: string, kind: "cloud" | "local") => {
    const server = await fakeEmbed({ label: name });
    const ep = models.addEndpoint(ada, { name, kind, baseUrl: server.baseUrl });
    const found = await models.discover(ada, ep.id);
    const o = models.setCapabilities(ada, found[0]!.id, { embedding: true });
    return { server, ep, ref: { offeringId: o.id } };
  };
  const api = await add("api", "cloud");
  const gpu = await add("gpu-embed", "local");
  const cpu = await add("cpu-embed", "local");
  models.setColumnTask(ada.id, "general", "embedding", [gpu.ref, cpu.ref]);
  models.setColumnTask(ada.id, "private", "embedding", [gpu.ref, cpu.ref]);
  return { ...m, api, gpu, cpu };
}

describe("embeddings", () => {
  it("sends texts in OpenAI's shape, wraps a query with the retrieval instruction, and keeps the server's order", async () => {
    const s = await setup();
    const ctx = s.ctx();
    const out = await s.models.embed(ctx, ["a note about trains", "a recipe"]);
    expect(out.model).toBe("Qwen3-Embedding-0.6B-Q8_0.gguf");
    expect(out.vectors.map((v) => [...v])).toEqual([toyVector("a note about trains"), toyVector("a recipe")]);
    expect(s.gpu.server.heard).toEqual([{ model: "Qwen3-Embedding-0.6B-Q8_0.gguf", input: ["a note about trains", "a recipe"] }]);
    await s.models.embed(ctx, ["what should I cook?"], { query: true });
    expect(s.gpu.server.heard[1]!.input).toEqual([queryText("what should I cook?")]);
    expect(queryText("x")).toMatch(/^Instruct: .*\nQuery: x$/);
    expect(s.models.embeddingModel(ctx)).toEqual({ model: "Qwen3-Embedding-0.6B-Q8_0.gguf", local: true });
  });

  it("falls back from a host that is away to the next copy of the model, and reports when none answers", async () => {
    const s = await setup();
    await s.gpu.server.stop();
    const out = await s.models.embed(s.ctx(), ["a recipe"]);
    expect(out.resolution.label).toBe("cpu-embed/Qwen3-Embedding-0.6B-Q8_0.gguf");
    expect(s.cpu.server.heard).toHaveLength(1);
    await s.cpu.server.stop();
    await expect(s.models.embed(s.ctx(), ["a recipe"])).rejects.toThrow(Offline);
  });

  it("never embeds a private or local-only thread's text with a cloud model", async () => {
    const s = await setup();
    expect(() => s.models.setColumnTask(s.ada.id, "private", "embedding", [s.api.ref])).toThrow(CloudModelForbidden);
    for (const ctx of [s.ctx({ pool: "private", localOnly: true }), s.ctx({ localOnly: true })]) {
      const named: CallContext = { ...ctx, overrides: { embedding: [s.api.ref] } };
      await expect(s.models.embed(named, ["a quiet diagnosis"])).rejects.toThrow(CloudModelForbidden);
      expect(s.models.embeddingModel(named)).toBeUndefined();
      expect((await s.models.embed(ctx, ["a quiet diagnosis"])).resolution.endpoint.kind).toBe("local");
    }
    expect(s.api.server.heard).toEqual([]);
  });

  it("has no model when the list is empty", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "general", "embedding", undefined);
    expect(s.models.embeddingModel(s.ctx())).toBeUndefined();
  });
});
