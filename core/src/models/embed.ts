// Embeddings: the HTTP of one batch of texts turned into vectors, in OpenAI's
// shape (`/v1/embeddings`). Texts stay in memory: nothing here writes a file
// or logs them.

import { hostError, HostRefused } from "./host.ts";

/** The most texts one request carries. */
export const EMBED_BATCH = 32;

/**
 * How a query is wrapped for a model trained with retrieval instructions
 * (Qwen3-Embedding, Harrier): the stored texts are embedded plain, the query
 * with the task. A model without instruction training reads it as text and
 * still embeds the question.
 */
export const queryText = (text: string): string => `Instruct: Given a message in a conversation, retrieve the memories it is about\nQuery: ${text}`;

export interface EmbedTarget {
  fetch: typeof fetch;
  /** The endpoint's base URL, ending in /v1. */
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  /** For messages: the endpoint's name. */
  name: string;
}

const auth = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

async function failure(res: Response, what: string): Promise<Error> {
  const host = await hostError(res);
  if (host) return new HostRefused(host.code, host.message);
  if (res.status >= 500 || res.status === 429) return new HostRefused("unavailable", `${what} answered ${res.status}`);
  let message = "";
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string };
    message = typeof body.error === "string" ? body.error : String(body.error?.message ?? "");
  } catch { /* no JSON */ }
  return new Error(`${what} refused the request (${res.status}${message ? `: ${message.slice(0, 200)}` : ""})`);
}

/** Sends texts for embedding; one vector per text comes back, in order. */
export async function embedAt(t: EmbedTarget, texts: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (texts.length > EMBED_BATCH) throw new Error(`at most ${EMBED_BATCH} texts per request`);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const res = await t.fetch(`${t.baseUrl}/embeddings`, {
    method: "POST", headers: { ...auth(t.apiKey), "content-type": "application/json" },
    body: JSON.stringify({ model: t.modelId, input: texts, encoding_format: "float" }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!res.ok) throw await failure(res, t.name);
  const body = (await res.json().catch(() => undefined)) as { data?: { index?: number; embedding?: unknown }[] } | undefined;
  if (!Array.isArray(body?.data) || body.data.length !== texts.length) throw new Error(`${t.name} didn't send ${texts.length} embeddings back`);
  const out: Float32Array[] = new Array(texts.length);
  body.data.forEach((d, i) => {
    const at = typeof d.index === "number" ? d.index : i;
    if (!Array.isArray(d.embedding) || !d.embedding.length || !d.embedding.every((x) => typeof x === "number")) throw new Error(`${t.name} sent an embedding that isn't a list of numbers`);
    out[at] = Float32Array.from(d.embedding as number[]);
  });
  if (out.some((v) => !v)) throw new Error(`${t.name} sent embeddings out of order`);
  return out;
}
