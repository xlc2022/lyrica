import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startOpenRouterSignIn } from "../src/index.ts";

describe("OpenRouter sign-in", () => {
  it("sends a S256 challenge and trades the code and verifier for a key", async () => {
    const s = startOpenRouterSignIn();
    const challenge = new URL(s.url).searchParams.get("code_challenge")!;
    let body: { code: string; code_verifier: string; code_challenge_method: string } | undefined;
    const key = await s.finish(" abc ", (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ key: "sk-or-1" });
    }) as typeof fetch);
    expect(key).toBe("sk-or-1");
    expect(body).toMatchObject({ code: "abc", code_challenge_method: "S256" });
    expect(createHash("sha256").update(body!.code_verifier).digest("base64url")).toBe(challenge);
  });
  it("names only the status when OpenRouter refuses", async () => {
    const s = startOpenRouterSignIn();
    await expect(s.finish("x", (async () => new Response("echo: x", { status: 403 })) as typeof fetch)).rejects.toThrow("OpenRouter refused the sign-in (HTTP 403).");
  });
});
