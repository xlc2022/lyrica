import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { profile, withModels } from "./helpers.ts";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A fake LM Studio: its OpenAI-compatible list, and its own REST API's models, load and unload. */
async function fakeLmStudio(o: { context?: number; max: number; refuseAbove?: number; vision?: boolean }) {
  let loaded: number | undefined = o.context;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.method === "GET" && req.url === "/v1/models") return json(200, { object: "list", data: [{ id: "qwen-flash", object: "model" }] });
      if (req.method === "GET" && req.url === "/api/v1/models") {
        return json(200, { models: [{ type: "llm", key: "qwen-flash", max_context_length: o.max, capabilities: { vision: o.vision ?? false, trained_for_tool_use: true }, loaded_instances: loaded ? [{ id: "qwen-flash", config: { context_length: loaded } }] : [] }] });
      }
      const b = JSON.parse(body || "{}") as { instance_id?: string; model?: string; context_length?: number };
      if (req.method === "POST" && req.url === "/api/v1/models/unload") { calls.push(`unload ${b.instance_id}`); loaded = undefined; return json(200, { instance_id: b.instance_id }); }
      if (req.method === "POST" && req.url === "/api/v1/models/load") {
        calls.push(`load ${b.model} ${b.context_length}`);
        if (o.refuseAbove && b.context_length! > o.refuseAbove) return json(400, { error: { message: "Insufficient memory to load the model." } });
        loaded = b.context_length;
        return json(200, { type: "llm", instance_id: b.model, status: "loaded" });
      }
      res.writeHead(404); res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

describe("LM Studio context", () => {
  it("plans by the loaded context, and loads the model again with a longer one", async () => {
    const studio = await fakeLmStudio({ context: 4096, max: 131072 });
    const s = await withModels();
    const ep = s.models.addEndpoint(s.ada, { name: "studio", kind: "local", baseUrl: studio.baseUrl });
    const [o] = await s.models.discover(s.ada, ep.id);
    expect(s.models.offering(s.ada.id, o!.id)!.offering.contextWindow).toBe(4096);
    expect(await s.models.localContext(s.ada.id, o!.id)).toEqual({ served: 4096, max: 131072 });
    expect(s.models.localCopies(s.ada, s.ctx()).map((c) => c.name)).toContain("qwen-flash");
    // A private or local-only thread has none: the models tool isn't there.
    expect(s.models.localCopies(s.ada, s.ctx({ localOnly: true }))).toEqual([]);

    await s.models.loadLocalContext(s.ada, o!.id, 65536);
    expect(studio.calls).toEqual(["unload qwen-flash", "load qwen-flash 65536"]);
    expect(s.models.offering(s.ada.id, o!.id)!.offering.contextWindow).toBe(65536);
  });

  it("leaves an unloaded model's window to the hand setting, not its maximum", async () => {
    const studio = await fakeLmStudio({ max: 131072 });
    const s = await withModels();
    const ep = s.models.addEndpoint(s.ada, { name: "studio", kind: "local", baseUrl: studio.baseUrl });
    const [o] = await s.models.discover(s.ada, ep.id);
    expect(s.models.offering(s.ada.id, o!.id)!.offering.contextWindow).toBeUndefined();
    expect(await s.models.localContext(s.ada.id, o!.id)).toEqual({ max: 131072 });
  });

  it("takes vision from LM Studio's own API", async () => {
    const s = await withModels();
    const sees = await fakeLmStudio({ max: 131072, vision: true });
    const [o] = await s.models.discover(s.ada, s.models.addEndpoint(s.ada, { name: "studio", kind: "local", baseUrl: sees.baseUrl }).id);
    expect(s.models.offering(s.ada.id, o!.id)!.offering.vision).toBe(true);
    const blind = await fakeLmStudio({ max: 131072 });
    const [b] = await s.models.discover(s.ada, s.models.addEndpoint(s.ada, { name: "studio-2", kind: "local", baseUrl: blind.baseUrl }).id);
    expect(s.models.offering(s.ada.id, b!.id)!.offering.vision).toBe(false);
  });

  it("passes LM Studio's refusal on and loads the model again as it was", async () => {
    const studio = await fakeLmStudio({ context: 8192, max: 131072, refuseAbove: 32768 });
    const s = await withModels();
    const ep = s.models.addEndpoint(s.ada, { name: "studio", kind: "local", baseUrl: studio.baseUrl });
    const [o] = await s.models.discover(s.ada, ep.id);
    await expect(s.models.loadLocalContext(s.ada, o!.id, 131072)).rejects.toThrow("LM Studio answered 400: Insufficient memory to load the model.");
    expect(studio.calls).toEqual(["unload qwen-flash", "load qwen-flash 131072", "load qwen-flash 8192"]);
  });

  it("isn't offered for a local server that isn't LM Studio, and a shared one needs an administrator", async () => {
    const s = await withModels();
    expect(await s.models.localContext(s.ada.id, s.localRef.offeringId)).toBeNull();
    expect(s.models.localCopies(s.ada, s.ctx())).toEqual([]);
    await expect(s.models.loadLocalContext(s.ada, s.localRef.offeringId, 65536)).rejects.toThrow("isn't LM Studio");

    const studio = await fakeLmStudio({ context: 4096, max: 131072 });
    const shared = s.models.addEndpoint(s.ada, { name: "studio", kind: "local", baseUrl: studio.baseUrl }, { shared: true });
    const [o] = await s.models.discover(s.ada, shared.id);
    const sam = await s.users.createUser("sam", "pw", profile("Sam"), { admin: false });
    await s.users.authenticate("sam", "pw");
    expect(s.models.localCopies(sam, s.models.callContext(sam.id, "general", "web/t"))).toEqual([]);
    await expect(s.models.loadLocalContext(sam, o!.id, 65536)).rejects.toThrow("only an administrator");
  });
});

describe("a thread's context limit", () => {
  it("is saved with the thread, cleared with null, and inherited by its children", async () => {
    const s = await withModels();
    s.models.setContextLimit(s.ada.id, "web/a", 16384);
    const parent = s.models.callContext(s.ada.id, "general", "web/a");
    expect(parent.contextLimit).toBe(16384);
    expect(s.models.inheritContext(parent, "web/b").contextLimit).toBe(16384);
    s.models.setContextLimit(s.ada.id, "web/a", null);
    expect(s.models.callContext(s.ada.id, "general", "web/a").contextLimit).toBeUndefined();
    expect(() => s.models.setContextLimit(s.ada.id, "web/a", 100)).toThrow("1024 or more");
  });
});
