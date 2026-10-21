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
  /** Its server says the model can't turn thinking off (LM Studio, OpenRouter's `reasoning.mandatory`). */
  alwaysThinks?: boolean;
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
  /** Requests the server runs at once for it (LM Studio's `parallel`), sharing its context cache. */
  servedParallel?: number;
  /** The sampling the model or its provider uses when a request sets none, where the server says (a host's file, OpenRouter's `default_parameters`). */
  defaults?: ModelDefaults;
  /** What it costs, where the server says (OpenRouter's `pricing`). */
  price?: ModelPrice;
  /** The day the server stops offering it (OpenRouter's `expiration_date`). */
  retiresAt?: string;
  /** The longest reply it gives, in tokens (OpenRouter's `top_provider.max_completion_tokens`). */
  maxOutput?: number;
}

/** US dollars per million tokens. `free` when input and output both cost nothing. */
export interface ModelPrice { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; free: boolean }

/**
 * OpenRouter's `pricing` (dollars per token, as strings) per million tokens.
 * Undefined when it isn't there or is negative (a router whose price varies).
 */
export function openRouterPrice(p: unknown): ModelPrice | undefined {
  if (!p || typeof p !== "object") return undefined;
  const per = (k: string) => {
    const v = Number((p as Record<string, unknown>)[k]);
    return Number.isFinite(v) && (p as Record<string, unknown>)[k] !== undefined ? Math.round(v * 1e6 * 1e6) / 1e6 : undefined;
  };
  const input = per("prompt"), output = per("completion");
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined;
  const extra = { reasoning: per("internal_reasoning"), cacheRead: per("input_cache_read"), cacheWrite: per("input_cache_write") };
  return { input, output, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v > 0)), free: input === 0 && output === 0 };
}

/**
 * OpenRouter's `reasoning`: the efforts a model takes, mapped to Lyrica's
 * levels (minimal counts as low, xhigh and max as high), and whether it
 * always thinks (`mandatory`). Undefined when the model doesn't say.
 */
export function openRouterReasoning(r: unknown): { levels: ("low" | "medium" | "high")[]; alwaysThinks: boolean } | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as { mandatory?: unknown; supported_efforts?: unknown };
  if (!Array.isArray(o.supported_efforts)) return o.mandatory === true ? { levels: ["low", "medium", "high"], alwaysThinks: true } : undefined;
  const efforts = new Set(o.supported_efforts.filter((e): e is string => typeof e === "string"));
  const levels = (["low", "medium", "high"] as const).filter((l) => efforts.has(l)
    || (l === "low" && efforts.has("minimal")) || (l === "high" && (efforts.has("xhigh") || efforts.has("max"))));
  if (!levels.length) return undefined;
  return { levels, alwaysThinks: o.mandatory === true };
}

/** Sampling a model reports as its own, under the settings' names. */
export interface ModelDefaults { temperature?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number; frequencyPenalty?: number; presencePenalty?: number }

/** The finite numbers among `read`'s answers for each default, or undefined when there are none. */
export function modelDefaults(read: (key: keyof ModelDefaults) => unknown): ModelDefaults | undefined {
  const out: ModelDefaults = {};
  for (const k of ["temperature", "topP", "topK", "minP", "repeatPenalty", "frequencyPenalty", "presencePenalty"] as const) {
    const v = read(k);
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
const OPENROUTER_DEFAULTS: Record<keyof ModelDefaults, string> = {
  temperature: "temperature", topP: "top_p", topK: "top_k", minP: "min_p", repeatPenalty: "repetition_penalty", frequencyPenalty: "frequency_penalty", presencePenalty: "presence_penalty",
};

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
 * and `architecture` modalities (vision, images), `default_parameters`
 * (the sampling it uses when a request sets none), `reasoning` (its
 * efforts, and whether thinking can be turned off), `pricing`,
 * `expiration_date` and `top_provider.max_completion_tokens`, llama-server's
 * `meta.n_ctx`, LM Studio's `max_context_length`, vLLM's `max_model_len`.
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
    const thinks = openRouterReasoning(m.reasoning);
    const price = openRouterPrice(m.pricing);
    const retires = typeof m.expiration_date === "string" && !Number.isNaN(Date.parse(m.expiration_date)) ? m.expiration_date : undefined;
    const maxOutput = num(m.top_provider?.max_completion_tokens);
    return [{
      modelId: m.id,
      contextWindow: num(m.context_length) ?? num(m.meta?.n_ctx) ?? num(m.max_context_length) ?? num(m.max_model_len),
      tools: params ? params.includes("tools") : undefined,
      reasoning: thinks?.levels ?? (params?.includes("reasoning") || params?.includes("reasoning_effort") ? ["low", "medium", "high"] as ("low" | "medium" | "high")[] : undefined),
      ...(thinks?.alwaysThinks ? { alwaysThinks: true } : {}),
      ...(price ? { price } : {}),
      ...(retires ? { retiresAt: retires } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      vision: input ? input.includes("image") : undefined,
      image: output ? output.includes("image") : undefined,
      defaults: m.default_parameters && typeof m.default_parameters === "object" ? modelDefaults((k) => m.default_parameters[OPENROUTER_DEFAULTS[k]]) : undefined,
    }];
  });
}

// LM Studio's own REST API, beside its OpenAI-compatible one at /v1.
const lmStudioRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * A model LM Studio has, with its loaded instances and the context each was
 * loaded with, whether it reads images, how it thinks, whether it is an
 * embedding model, and whether it was trained for tool use (only a yes
 * counts: LM Studio runs tools for any model through its own format).
 */
export interface LmStudioModel { key: string; maxContext?: number; vision?: boolean; reasoning?: LmStudioReasoning; embedding?: boolean; tools?: boolean; instances: { id: string; context?: number; parallel?: number }[] }

/** The thinking levels LM Studio lists for a model, and whether off is among them. */
export interface LmStudioReasoning { levels: ("low" | "medium" | "high")[]; canTurnOff: boolean }

/**
 * LM Studio's `capabilities.reasoning`: its `allowed_options` (off, on, low,
 * medium, high), where "on" is a switch and counts as medium. Undefined when
 * it doesn't say the model thinks.
 */
function lmStudioReasoning(r: unknown): LmStudioReasoning | undefined {
  const options = r && typeof r === "object" ? (r as { allowed_options?: unknown }).allowed_options : undefined;
  if (!Array.isArray(options)) return undefined;
  const levels = (["low", "medium", "high"] as const).filter((l) => options.includes(l));
  if (!levels.length && !options.includes("on")) return undefined;
  return { levels: levels.length ? levels : ["medium"], canTurnOff: options.includes("off") };
}

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
    ...(typeof m.capabilities?.vision === "boolean" ? { vision: m.capabilities.vision as boolean } : {}),
    ...(lmStudioReasoning(m.capabilities?.reasoning) ? { reasoning: lmStudioReasoning(m.capabilities.reasoning) } : {}),
    ...(m.type === "embedding" ? { embedding: true } : {}),
    ...(m.capabilities?.trained_for_tool_use === true ? { tools: true } : {}),
    instances: (Array.isArray(m.loaded_instances) ? m.loaded_instances : []).filter((i: any) => typeof i?.id === "string")
      .map((i: any) => ({ id: i.id as string, context: num(i.config?.context_length), ...(num(i.config?.parallel) ? { parallel: num(i.config.parallel) } : {}) })),
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

