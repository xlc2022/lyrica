// The only HTTP Lyrica itself does to an endpoint: listing its models. Model
// calls go through Pi's own OpenAI-compatible client.

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
