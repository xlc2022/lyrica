import { createHash, randomBytes } from "node:crypto";

// Sign in with OpenRouter (docs/models.md, "OpenRouter sign-in"): OpenRouter's
// PKCE flow in its headless mode. The person approves on openrouter.ai, which
// shows a one-time code to paste back; the exchange returns an ordinary API
// key that belongs to them. Nothing here is logged.

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const AUTH_PAGE = "https://openrouter.ai/auth";

export interface OpenRouterSignIn {
  /** OpenRouter's page to open. */
  url: string;
  /** Trades the code the page showed for the person's API key. */
  finish(code: string, fetcher?: typeof fetch): Promise<string>;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Starts a sign-in: a fresh verifier, and the page that carries its challenge. */
export function startOpenRouterSignIn(): OpenRouterSignIn {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url = `${AUTH_PAGE}?${new URLSearchParams({ code_challenge: challenge, code_challenge_method: "S256", key_label: "Lyrica" })}`;
  return {
    url,
    async finish(code, fetcher = fetch) {
      const res = await fetcher(`${OPENROUTER_URL}/auth/keys`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), code_verifier: verifier, code_challenge_method: "S256" }),
      });
      // OpenRouter's own text is never passed on: it may echo what it was sent.
      if (!res.ok) throw new Error(`OpenRouter refused the sign-in (HTTP ${res.status}).`);
      const key = ((await res.json().catch(() => ({}))) as { key?: unknown }).key;
      if (typeof key !== "string" || !key) throw new Error("OpenRouter gave no key.");
      return key;
    },
  };
}
