import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN_URLS } from "@lyrica/core";
import { profile, withModels } from "../../core/test/helpers.ts";
import { modelRuntimeFor, planCatalog, planError, startPlanSignIn } from "../src/index.ts";

const TOKEN_URLS = { chatgpt: "https://auth.openai.com/api/accounts/oauth/token", grok: "https://auth.x.ai/oauth2/token" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

/** The user with a ChatGPT plan whose sign-in has `expires`, and its first model in their general column. */
async function setup(expires = Date.now() + 3_600_000, kind: "chatgpt" | "grok" = "chatgpt") {
  const m = await withModels();
  m.models.setPlanCatalog(planCatalog);
  const plan = m.models.addPlan(m.ada, { name: kind, plan: kind, credential: { access: "at-1", refresh: "rt-1", expires, clientId: "client-1", scopes: [] } });
  const offerings = await m.models.discover(m.ada, plan.id);
  m.models.setColumnTask(m.ada.id, "general", "chat", { offeringId: offerings.find((o) => o.modelId === "gpt-5")?.id ?? offerings[0]!.id });
  return { ...m, plan, offerings };
}

/** OpenAI's token endpoint, answering each refresh with `status` (and a fresh token when it is 200). */
function tokenEndpoint(status = 200, kind: "chatgpt" | "grok" = "chatgpt") {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== TOKEN_URLS[kind]) return realFetch(input, init);
    calls.push(String(init?.body));
    await new Promise((r) => setTimeout(r, 20));
    if (status !== 200) return new Response('{"error":"invalid_grant"}', { status });
    return Response.json({ access_token: `at-${calls.length + 1}`, refresh_token: `rt-${calls.length + 1}`, scope: "openid chatgpt.tokens.use.direct", expires_in: 3600 });
  }) as typeof fetch;
  return calls;
}

describe("a ChatGPT plan", () => {
  it("is cloud, the user's own, and never in a private or local-only thread's runtime", async () => {
    const s = await setup();
    expect(s.plan).toMatchObject({ kind: "cloud", api: "chatgpt", shared: false, baseUrl: PLAN_URLS.chatgpt });
    expect(s.plan.apiKey).toBeUndefined();
    for (const ctx of [s.ctx({ pool: "private" }), s.ctx({ localOnly: true })]) {
      const runtime = await modelRuntimeFor(s.models, ctx);
      expect(runtime.getProvider(s.plan.id)).toBeUndefined();
    }
    const general = await modelRuntimeFor(s.models, s.ctx());
    expect(general.getModels(s.plan.id).map((m) => m.id).sort()).toEqual(s.offerings.map((o) => o.modelId).sort());

    const bo = await s.users.createUser("bo", "pw", profile("Bo"), { admin: false });
    await s.users.authenticate("bo", "pw");
    expect(s.models.endpoint(bo.id, s.plan.id)).toBeUndefined();
  });

  it("refuses a name an endpoint can't have, before a sign-in is started for it", async () => {
    const s = await setup();
    expect(() => s.models.checkEndpointName("My ChatGPT")).toThrow(/lowercase letters/);
    expect(() => s.models.checkEndpointName("chatgpt-2")).not.toThrow();
  });

  it("has no URL or key to edit, and merges only with another plan", async () => {
    const s = await setup();
    expect(() => s.models.editEndpoint(s.ada, s.plan.id, { baseUrl: "https://example.com/v1" })).toThrow(/signs in with ChatGPT/);
    expect(() => s.models.editEndpoint(s.ada, s.plan.id, { apiKey: "sk-x" })).toThrow(/signs in with ChatGPT/);
    expect(() => s.models.merge(s.ada, s.plan.id, s.openrouter.id)).toThrow(/only with another plan of the same kind/);
  });

  it("refreshes once for concurrent calls and keeps the new sign-in", async () => {
    const s = await setup(Date.now() - 1000);
    const calls = tokenEndpoint();
    const runtime = await modelRuntimeFor(s.models, s.ctx());
    const [a, b] = await Promise.all([runtime.getAuth(s.plan.id), runtime.getAuth(s.plan.id)]);
    expect(calls).toHaveLength(1);
    expect(a?.auth.apiKey).toBe("at-2");
    expect(b?.auth.apiKey).toBe("at-2");
    expect(s.models.planCredential(s.ada.id, s.plan.id)).toMatchObject({ access: "at-2", refresh: "rt-2", clientId: "client-1" });
    // A runtime made later, as after a restart, uses the saved sign-in without refreshing.
    await (await modelRuntimeFor(s.models, s.ctx())).getAuth(s.plan.id);
    expect(calls).toHaveLength(1);
  });

  it("is signed out when OpenAI refuses the refresh, and the router skips it until it signs in again", async () => {
    const s = await setup(Date.now() - 1000);
    tokenEndpoint(400);
    const runtime = await modelRuntimeFor(s.models, s.ctx());
    await expect(runtime.getAuth(s.plan.id)).rejects.toThrow();
    expect(s.models.endpoint(s.ada.id, s.plan.id)?.signedOut).toBe(true);
    expect(s.models.planCredential(s.ada.id, s.plan.id)).toBeUndefined();
    expect(() => s.models.resolve("chat", s.ctx())).toThrow(/chatgpt is signed out/);

    s.models.setPlanCredential(s.ada.id, s.plan.id, { access: "at-9", refresh: "rt-9", expires: Date.now() + 3_600_000 });
    expect(s.models.resolve("chat", s.ctx()).endpoint.id).toBe(s.plan.id);
  });

  it("is skipped for a while once its usage limit is reached, so the next turn falls back", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "general", "chat", [s.offerings[0]!.id, s.cloudRef.offeringId].map((offeringId) => ({ offeringId })));
    s.models.reportPlanLimit(s.plan.id);
    const r = s.models.resolve("chat", s.ctx());
    expect(r.endpoint.id).toBe(s.openrouter.id);
    expect(r.skipped[0]!.reason).toMatch(/reached its plan's limit/);
  });

  it("keeps a network failure from signing it out", async () => {
    const s = await setup(Date.now() - 1000);
    tokenEndpoint(503);
    const runtime = await modelRuntimeFor(s.models, s.ctx());
    await expect(runtime.getAuth(s.plan.id)).rejects.toThrow();
    expect(s.models.endpoint(s.ada.id, s.plan.id)?.signedOut).toBeUndefined();
  });

  it("works the same for a Grok plan, on xAI's provider", async () => {
    const s = await setup(Date.now() - 1000, "grok");
    expect(s.plan).toMatchObject({ api: "grok", kind: "cloud", baseUrl: PLAN_URLS.grok });
    expect(s.offerings.every((o) => o.modelId.startsWith("grok"))).toBe(true);
    const runtime = await modelRuntimeFor(s.models, s.ctx());
    expect(runtime.getModels(s.plan.id).length).toBe(s.offerings.length);
    tokenEndpoint(400, "grok");
    await expect(runtime.getAuth(s.plan.id)).rejects.toThrow();
    expect(s.models.endpoint(s.ada.id, s.plan.id)?.signedOut).toBe(true);
  });
});

describe("a provider's refusal", () => {
  it("is one fixed line naming the provider, never the provider's own text", () => {
    const e = new Error('token request failed (400): {"error":"invalid_grant","echo":"FAKE-refresh-value"}');
    expect(planError(e, "chatgpt", "sign-in").message).toBe("ChatGPT refused the sign-in (HTTP 400).");
    expect(planError(new Error("token refresh failed (HTTP 401)"), "grok", "sign-in refresh").message).toBe("Grok refused the sign-in refresh (HTTP 401).");
    expect(planError(new Error("state mismatch\nmore"), "chatgpt", "sign-in").message).toBe("state mismatch");
  });
});

describe("a ChatGPT sign-in", () => {
  it("lets go of the listener on port 1455 when it is cancelled", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const first = await startPlanSignIn("chatgpt", id);
    first.cancel();
    const second = await startPlanSignIn("chatgpt", id); // "Port 1455 is in use" if the first still held it
    second.cancel();
    expect(second.url).toContain("auth");
  });
});
