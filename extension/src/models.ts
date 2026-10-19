import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PlanCredentials, planProvider } from "./plans.ts";
import { acceptedSettings, DEFAULT_CONTEXT, replyCap, isPlan, CloudModelForbidden, isRestricted, payloadFields, type CallContext, type Endpoint, type Models, type Offering, type Pool, type Resolution, type Task } from "@lyrica/core";
import { streamWithInlineThinking } from "./inline-thinking.ts";
import { capToolCalls, objectTools } from "./tool-stream.ts";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Local servers (LM Studio, KoboldCpp, llama-server) take `system` and
// `max_tokens`; they don't all know `developer`, `store` or `max_completion_tokens`.
const LOCAL_COMPAT = { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } as const;

// A model that thinks gets `reasoning_effort` (OpenAI-compatible endpoints) at the thread's level.
// A host model with an on/off thinking switch (one level) thinks through the chat template's switch instead.
// A thread's context limit narrows the window it plans by (compaction, the meter, the reply cap).
const windowOf = (m: Offering, limit?: number) => Math.min(m.contextWindow ?? DEFAULT_CONTEXT, limit ?? Infinity);

function piModel(ep: Endpoint, m: Offering, limit?: number): ProviderModelConfig {
  const contextWindow = windowOf(m, limit);
  const reasoning = !!m.reasoning?.length;
  const toggle = ep.api === "host" && m.reasoning?.length === 1;
  const compat = ep.api === "host" ? { ...LOCAL_COMPAT, ...(toggle ? { thinkingFormat: "qwen-chat-template" as const } : { supportsReasoningEffort: reasoning }) }
    : ep.kind === "local" ? { ...LOCAL_COMPAT, supportsReasoningEffort: reasoning } : undefined;
  return {
    id: m.modelId, name: m.modelId, input: m.vision ? ["text", "image"] : ["text"], cost: FREE, reasoning,
    contextWindow, maxTokens: replyCap(contextWindow),
    ...(compat ? { compat } : {}),
  };
}

/** A reply can start inside a thought when the template opens `<think>` itself: always, or when its switch is on. */
export function startsMidThought(o: Offering | undefined, level: string | undefined): boolean {
  return !!o?.opensThinking && (!o.reasoning?.length || (!!level && level !== "off"));
}

/**
 * A Pi ModelRuntime holding exactly the endpoints this context may use, and
 * nothing else: none of Pi's built-in providers, no auth.json, no models.json,
 * no environment keys. For a private or local-only context that means no cloud
 * model at all, so Pi's compaction and retries have nothing cloud-based to reach.
 * The runtime is sealed: nothing can register another provider into it.
 */
export async function modelRuntimeFor(models: Models, ctx: CallContext): Promise<ModelRuntime> {
  const allowed = models.allowed(ctx);
  // A plan's sign-in lives in the user's user.db, where Pi's refresh writes it back.
  const plans = new Set(allowed.filter(({ endpoint }) => isPlan(endpoint.api)).map(({ endpoint }) => endpoint.id));
  const runtime = await ModelRuntime.create({ credentials: new PlanCredentials(models, ctx.userId, plans), modelsPath: null, refreshOnCreate: false });
  // Pi 1.1.0 always loads its built-in catalog. Drop it, so the runtime starts empty.
  const internals = runtime as unknown as { defaultBuiltins: Map<string, unknown>; builtins: Map<string, unknown>; rebuildProviders(): void };
  internals.defaultBuiltins.clear();
  internals.builtins.clear();
  internals.rebuildProviders();

  // Each request carries the offering's saved settings (only those set), and a model host's requests its pinned fetch.
  const fetches = new Map(allowed.flatMap(({ endpoint }) => { const f = models.fetchFor(endpoint); return f ? [[endpoint.id, f] as const] : []; }));
  const offerings = new Map(allowed.flatMap(({ endpoint, offerings: list }) => list.map((o) => [`${endpoint.id}\u0000${o.modelId}`, { endpoint, offering: o }] as const)));
  type Prepared = { options: { fetch?: typeof fetch; onPayload?: (payload: unknown, model: Model<Api>) => unknown } };
  const r = runtime as unknown as { prepareRequest(model: Model<Api>, options?: object): Promise<Prepared> };
  const prepare = r.prepareRequest.bind(runtime);
  r.prepareRequest = async (model, options) => {
    const prepared = await prepare(model, options);
    const f = fetches.get(model.provider);
    if (f) prepared.options.fetch = f;
    const found = offerings.get(`${model.provider}\u0000${model.id}`);
    // The window follows the copy as it is now (a context set by hand, or a load at another one), even mid-turn:
    // the session plans by this same model object, so compaction, the meter and the reply cap follow it.
    const now = found && models.offering(ctx.userId, found.offering.id)?.offering;
    if (now) {
      const contextWindow = windowOf(now, ctx.contextLimit);
      if (model.contextWindow !== contextWindow) Object.assign(model, { contextWindow, maxTokens: replyCap(contextWindow) });
    }
    if (found) {
      const values = models.offeringSettings(ctx.userId, found.offering.id).values;
      if (Object.keys(values).length) {
        const before = prepared.options.onPayload;
        const repetition = found.endpoint.kind === "local" && found.endpoint.api !== "host" ? "repeat_penalty" : "repetition_penalty";
        prepared.options.onPayload = async (payload, m) => {
          const params = ((await before?.(payload, m)) ?? payload) as Record<string, unknown>;
          return { ...params, ...payloadFields(values, repetition, params, acceptedSettings(found.endpoint)) };
        };
      }
    }
    return prepared;
  };
  for (const { endpoint, offerings: list } of allowed) {
    if (!list.length) continue;
    if (isPlan(endpoint.api)) {
      runtime.registerNativeProvider(planProvider({ ...endpoint, api: endpoint.api }, list.map((m) => m.modelId)));
      continue;
    }
    runtime.registerProvider(endpoint.id, {
      name: `${endpoint.name} (${endpoint.kind})`, baseUrl: endpoint.baseUrl, api: "openai-completions",
      models: list.map((m) => piModel(endpoint, m, ctx.contextLimit)),
      streamSimple: (model, context, options) => {
        // Its own signal, so a runaway reply can stop the request; the caller's still stops it.
        const stop = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
        const midThought = startsMidThought(list.find((m) => m.modelId === model.id), options?.reasoning);
        return capToolCalls(streamWithInlineThinking(model as Model<"openai-completions">, objectTools(context), { ...options, signal }, midThought), () => stop.abort());
      },
    });
    // A runtime key is used literally; a key in the provider config would be read as `$ENV` or `!command`.
    await runtime.setRuntimeApiKey(endpoint.id, endpoint.apiKey ?? "none");
  }

  const kinds = new Map(allowed.map(({ endpoint }) => [endpoint.id, endpoint.kind]));
  for (const p of runtime.getProviders()) {
    const kind = kinds.get(p.id);
    if (!kind || (isRestricted(ctx) && kind !== "local")) throw new CloudModelForbidden(`the model runtime holds an unexpected provider: ${p.id}`);
  }
  const sealed = () => { throw new Error("Lyrica's model runtime takes no other providers"); };
  Object.assign(runtime, { registerProvider: sealed, registerNativeProvider: sealed, registerVirtualModel: sealed, login: sealed });
  return runtime;
}

/** The Pi model for a task, resolved through the router. Throws CloudModelForbidden like resolveModel. */
export function piModelFor(runtime: ModelRuntime, models: Models, task: Task, ctx: CallContext, resolution?: Resolution): { ref: { offeringId: string }; model: Model<Api>; resolution: Resolution } {
  const r = resolution ?? models.resolve(task, ctx);
  const model = runtime.getModel(r.endpoint.id, r.offering.modelId);
  if (!model) throw new CloudModelForbidden(`${r.label} is not in this thread's model runtime`);
  return { ref: r.ref, model, resolution: r };
}

/**
 * Before a turn: picks the chat model again, passing over any whose machine
 * is away (probed when there is a fallback), switches the session to it,
 * sets the thinking level it can do, and records which model answers and why.
 * With `thinking: false` the session keeps its own level (a subagent role's).
 */
export async function prepareTurn(o: {
  session: AgentSession; runtime: ModelRuntime; models: Models; call: CallContext; pool: Pool; threadId: string; task?: Task; thinking?: boolean;
  /** Pi is retrying within the turn: probe for at most a second (its pause before the retry is two), and rewrite the turn's call record. */
  retry?: boolean;
}): Promise<Resolution> {
  const task = o.task ?? "chat";
  const tokens = o.session.getContextUsage()?.tokens ?? undefined;
  // Tools are asked for only when the thread has them, so a model without tools can still chat.
  const tools = o.session.getActiveToolNames().length > 0;
  const r = await o.models.resolveLive(task, o.call, { ...(tools ? { tools } : {}), ...(tokens ? { tokens } : {}) }, o.retry ? { probeMs: 1000 } : {});
  // A model LM Studio loaded at another context since the endpoint was read plans by that from this turn.
  if (!o.retry) await o.models.refreshServed(o.call.userId, r.ref.offeringId).catch(() => {});
  const { model } = piModelFor(o.runtime, o.models, task, o.call, r);
  const current = o.session.model;
  if (!current || current.provider !== model.provider || current.id !== model.id) await o.session.setModel(model);
  let note: string | undefined;
  if (o.thinking !== false) {
    const t = o.models.thinkingFor(r, o.call.thinking);
    o.session.setThinkingLevel(t.level);
    note = t.note;
  }
  o.models.recordCall(o.call.userId, { pool: o.pool, threadId: o.threadId, task, resolution: r, ...(note ? { note } : {}) }, { retry: !!o.retry });
  return r;
}
