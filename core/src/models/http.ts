// The only HTTP Lyrica itself does to an endpoint: listing its models, and on
// LM Studio loading one with a context length. Model calls go through Pi's own
// OpenAI-compatible client.

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// the operator's own network: loopback, private ranges, and the Tailscale tailnet.
const OWN_NETWORK = new BlockList();
for (const [net, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]] as const) OWN_NETWORK.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::1", 128], ["fd00::", 8], ["fd7a:115c:a1e0::", 48]] as const) OWN_NETWORK.addSubnet(net, bits, "ipv6");

/** Whether an address is in the operator's own network: loopback, RFC 1918, fd00::/8, or the tailnet. */
export const inOwnNetwork = (address: string): boolean => OWN_NETWORK.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

/**
 * The addresses a base URL's host resolves to that are outside the operator's own
 * network (loopback, RFC 1918, fd00::/8, or the tailnet). `*.ts.net` names
 * resolve through the host's normal resolver.
 */
export async function addressesOutside(baseUrl: string): Promise<string[]> {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  return addresses.filter((a) => !inOwnNetwork(a));
}

export interface DiscoveredModel {
  modelId: string; contextWindow?: number; tools?: boolean; vision?: boolean; image?: boolean; embedding?: boolean;
  edit?: boolean; upscale?: boolean;
  transcribe?: boolean; speak?: { voices: { id: string; language: string }[] };
  reasoning?: ("low" | "medium" | "high")[];
  /** A host's chat template writes `<think>` itself (host/API.md "Models"). */
  opensThinking?: boolean;
  /** The file's SHA-256, where a host reports it: the same file on two hosts is the same model. */
  digest?: string;
  /** What a host read from the file or its model card, for the library. */
  identity?: ModelIdentity;
  /** The host downloaded it itself (only those can be deleted). */
  downloaded?: boolean;
  size?: number;
  /** An image model, by its name: a confirmed recipe, or a ChatGPT plan's image tool. */
  recipe?: string;
  /** A host recipe's create tiers; absent means both. */
  useFor?: "fast" | "quality" | "both";
  /** The context window a host serves the model with, which wins over one set by hand. */
  servedContext?: number;
  /** LM Studio listed it on its own API, so its context can be changed by loading it again. */
  lmStudio?: boolean;
}

/** A model's identity as a host reads it: GGUF metadata and the hub's model card. */
export interface ModelIdentity {
  basename?: string | null;
  sizeLabel?: string | null;
  finetune?: string | null;
  baseModels?: { name?: string; organization?: string; repoUrl?: string }[] | null;
  card?: { baseModel?: string[]; baseModelRelation?: string | null } | null;
}

const headers = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

async function getModels(baseUrl: string, apiKey: string | undefined, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(`${baseUrl}/models`, { headers: headers(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${baseUrl}/models answered ${res.status}`);
  return res.json();
}

/** "up" when GET /models answers 2xx within the timeout. */
export async function probeUrl(baseUrl: string, apiKey: string | undefined, timeoutMs = 5000, fetchImpl?: typeof fetch): Promise<"up" | "down"> {
  try {
    await getModels(baseUrl, apiKey, timeoutMs, fetchImpl);
    return "up";
  } catch {
    return "down";
  }
}

/**
 * Reads GET /models. Capabilities are recorded only when the server says:
 * OpenRouter's `context_length`, `supported_parameters` (tools, reasoning)
 * and `architecture` modalities (vision, images), llama-server's
 * `meta.n_ctx`, LM Studio's `max_context_length`.
 */
export async function discoverModels(baseUrl: string, apiKey: string | undefined, timeoutMs = 10_000): Promise<DiscoveredModel[]> {
  const body = (await getModels(baseUrl, apiKey, timeoutMs)) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new Error(`${baseUrl}/models did not return a model list`);
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined);
  return body.data.flatMap((m: Record<string, any>) => {
    if (typeof m?.id !== "string" || !m.id) return [];
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined;
    const input = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : undefined;
    const output = Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : undefined;
    return [{
      modelId: m.id,
      contextWindow: num(m.context_length) ?? num(m.meta?.n_ctx) ?? num(m.max_context_length),
      tools: params ? params.includes("tools") : undefined,
      reasoning: params?.includes("reasoning") || params?.includes("reasoning_effort") ? ["low", "medium", "high"] as ("low" | "medium" | "high")[] : undefined,
      vision: input ? input.includes("image") : undefined,
      image: output ? output.includes("image") : undefined,
    }];
  });
}

// LM Studio's own REST API, beside its OpenAI-compatible one at /v1.
const lmStudioRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

/** A model LM Studio has, with its loaded instances and the context each was loaded with. */
export interface LmStudioModel { key: string; maxContext?: number; instances: { id: string; context?: number }[] }

/** LM Studio's models (GET /api/v1/models), or null when the server doesn't answer like LM Studio. */
export async function lmStudioModels(baseUrl: string, apiKey: string | undefined, timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<LmStudioModel[] | null> {
  let body: { models?: unknown };
  try {
    const res = await fetchImpl(`${lmStudioRoot(baseUrl)}/api/v1/models`, { headers: headers(apiKey), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    body = (await res.json()) as { models?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(body?.models)) return null;
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined);
  return body.models.flatMap((m: Record<string, any>) => typeof m?.key !== "string" ? [] : [{
    key: m.key, maxContext: num(m.max_context_length),
    instances: (Array.isArray(m.loaded_instances) ? m.loaded_instances : []).filter((i: any) => typeof i?.id === "string")
      .map((i: any) => ({ id: i.id as string, context: num(i.config?.context_length) })),
  }]);
}

/** The LM Studio model an OpenAI-compatible model ID names: its key, or one of its loaded instances. */
export const lmStudioModel = (models: LmStudioModel[], modelId: string) => models.find((m) => m.key === modelId || m.instances.some((i) => i.id === modelId));

/**
 * Loads a model in LM Studio with a context length, after unloading its
 * instances. If LM Studio refuses (it checks the fit itself), the model is
 * loaded again as it was and the refusal is thrown with LM Studio's words.
 */
export async function lmStudioLoad(baseUrl: string, apiKey: string | undefined, model: LmStudioModel, contextLength: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${lmStudioRoot(baseUrl)}${path}`, {
      method: "POST", headers: { ...headers(apiKey), "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
    });
    if (res.ok) return;
    const e = (await res.json().catch(() => null)) as { error?: string | { message?: string } } | null;
    const said = typeof e?.error === "string" ? e.error : e?.error?.message;
    throw new Error(`LM Studio answered ${res.status}${said ? `: ${said}` : ""}`);
  };
  for (const i of model.instances) await post("/api/v1/models/unload", { instance_id: i.id });
  try {
    await post("/api/v1/models/load", { model: model.key, context_length: contextLength });
  } catch (err) {
    const was = model.instances[0]?.context;
    if (was) await post("/api/v1/models/load", { model: model.key, context_length: was }).catch(() => {});
    throw err;
  }
}

