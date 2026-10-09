// The only HTTP Lyrica itself does to an endpoint: listing its models. Model
// calls go through Pi's own OpenAI-compatible client.

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Li's own network: loopback, private ranges, and the Tailscale tailnet.
const OWN_NETWORK = new BlockList();
for (const [net, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]] as const) OWN_NETWORK.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::1", 128], ["fd00::", 8], ["fd7a:115c:a1e0::", 48]] as const) OWN_NETWORK.addSubnet(net, bits, "ipv6");

/**
 * The addresses a base URL's host resolves to that are outside Li's own
 * network (loopback, RFC 1918, fd00::/8, or the tailnet). `*.ts.net` names
 * resolve through the host's normal resolver.
 */
export async function addressesOutside(baseUrl: string): Promise<string[]> {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  return addresses.filter((a) => !OWN_NETWORK.check(a, isIP(a) === 6 ? "ipv6" : "ipv4"));
}

export interface DiscoveredModel { modelId: string; contextWindow?: number; tools?: boolean }

const headers = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

async function getModels(baseUrl: string, apiKey: string | undefined, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`${baseUrl}/models`, { headers: headers(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${baseUrl}/models answered ${res.status}`);
  return res.json();
}

/** "up" when GET /models answers 2xx within the timeout. */
export async function probeUrl(baseUrl: string, apiKey: string | undefined, timeoutMs = 5000): Promise<"up" | "down"> {
  try {
    await getModels(baseUrl, apiKey, timeoutMs);
    return "up";
  } catch {
    return "down";
  }
}

/**
 * Reads GET /models. Context windows and tool support are recorded only when
 * the server says: OpenRouter's `context_length` and `supported_parameters`,
 * llama-server's `meta.n_ctx`, LM Studio's `max_context_length`.
 */
export async function discoverModels(baseUrl: string, apiKey: string | undefined, timeoutMs = 10_000): Promise<DiscoveredModel[]> {
  const body = (await getModels(baseUrl, apiKey, timeoutMs)) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new Error(`${baseUrl}/models did not return a model list`);
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined);
  return body.data.flatMap((m: Record<string, any>) => {
    if (typeof m?.id !== "string" || !m.id) return [];
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined;
    return [{
      modelId: m.id,
      contextWindow: num(m.context_length) ?? num(m.meta?.n_ctx) ?? num(m.max_context_length),
      tools: params ? params.includes("tools") : undefined,
    }];
  });
}
