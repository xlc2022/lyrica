import { describe, expect, it } from "vitest";
import { Memory } from "@lyrica/core";
import { fakeEmbed } from "../../core/test/fake-embed.ts";
import { withModels } from "../../core/test/helpers.ts";
import { Embedder } from "../src/embedder.ts";

describe("the embedder", () => {
  it("embeds each pool's unvectored memories with its own Embeddings model, marks what has no words, and rests when there is nothing or no model", async () => {
    const m = await withModels();
    const { models, ada, users, keyring } = m;
    const memory = new Memory(keyring, users);
    const server = await fakeEmbed();
    const ep = models.addEndpoint(ada, { name: "embed", kind: "local", baseUrl: server.baseUrl });
    const found = await models.discover(ada, ep.id);
    const ref = { offeringId: models.setCapabilities(ada, found[0]!.id, { embedding: true }).id };
    // Only the general column has a model: the private pool stays keyword-only.
    models.setColumnTask(ada.id, "general", "embedding", [ref]);
    const general = memory.openThreadView(ada.id, "general");
    const thread = general.own.createThread({ interface: "cli" });
    const said = general.own.appendEntry(thread.id, { piId: "p1", role: "user", data: { type: "message", message: { role: "user", content: "what should I cook tonight?" } }, text: "what should I cook tonight?" });
    // A tool result is indexed but has no spoken words: it is marked skipped without a call.
    general.own.appendEntry(thread.id, { piId: "p2", role: "toolResult", data: { type: "message" }, text: "bash: ok" });
    const [note] = general.own.addNotes([{ text: "{user} doesn't like cilantro", source: said }], { author: "lyrica", thread: thread.id });
    const priv = memory.openThreadView(ada.id, "private");
    const pt = priv.own.createThread({ interface: "cli" });
    priv.own.addNotes([{ text: "{user} has a quiet diagnosis", source: priv.own.appendEntry(pt.id, { piId: "q1", role: "user", data: { type: "message" }, text: "private" }) }], { author: "lyrica", thread: pt.id });
    const logs: string[] = [];
    const embedder = new Embedder({ users, memory, models, hasKey: (id) => keyring.hasUserKey(id), log: (l) => logs.push(l) });
    await embedder.tick();
    expect(server.heard).toHaveLength(1);
    expect(server.heard[0]!.input.sort()).toEqual(["doesn't like cilantro", "what should I cook tonight?"].map((t) => expect.stringContaining(t)));
    expect(general.own.vectorCount("Qwen3-Embedding-0.6B-Q8_0.gguf")).toEqual({ done: 3, left: 0 });
    expect(general.own.nearest("Qwen3-Embedding-0.6B-Q8_0.gguf", Float32Array.from([1, 0, 0, 0]), 5).map((n) => n.id).sort()).toEqual([note, said].sort());
    expect(general.own.unembedded("Qwen3-Embedding-0.6B-Q8_0.gguf", 5)).toEqual([]);
    // Private memory never went anywhere: no model is set for it, and nothing private was in any request.
    expect(priv.own.vectorCount("Qwen3-Embedding-0.6B-Q8_0.gguf").done).toBe(0);
    expect(JSON.stringify(server.heard)).not.toMatch(/diagnosis/);
    // Resting: a new note waits for the minute to pass; a later tick picks it up.
    general.own.addNotes([{ text: "{user} grows thyme on the balcony", source: said }], { author: "lyrica", thread: thread.id });
    await embedder.tick();
    expect(server.heard).toHaveLength(1);
    await embedder.tick(Date.now() + 61_000);
    expect(server.heard).toHaveLength(2);
    expect(logs).toEqual([]);
    general.close();
    priv.close();
  });
});
