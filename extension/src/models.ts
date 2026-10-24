import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { estimateTokens, ModelRuntime, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PlanCredentials, planProvider } from "./plans.ts";
import { acceptedSettings, DEFAULT_CONTEXT, replyCap, isPlan, planLimitReset, CloudModelForbidden, isRestricted, payloadFields, type CallContext, type Endpoint, type Models, type Offering, type Pool, type Resolution, type Task } from "@lyrica/core";
import { streamWithInlineThinking } from "./inline-thinking.ts";
import { capToolCalls, objectTools } from "./tool-stream.ts";
import { markOverflow, sharedStream, shareModel } from "./model-share.ts";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Local servers (LM Studio, KoboldCpp, llama-server) take `system` and
// `max_tokens`; they don't all know `developer`, `store` or `max_completion_tokens`.
const LOCAL_COMPAT = { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } as const;

// A model that thinks gets `reasoning_effort` (OpenAI-compatible endpoints) at the thread's level.
// A host or plain llama-server model with an on/off thinking switch (one level) thinks through the chat template's switch instead.
// A thread's context limit narrows the window it plans by (compaction, the meter, the reply cap).
const windowOf = (m: Offering, limit?: number) => Math.min(m.contextWindow ?? DEFAULT_CONTEXT, limit ?? Infinity);
const replyRoom = (ep: Pick<Endpoint, "kind">, m: Offering, contextWindow: number) => replyCap(contextWindow, { local: ep.kind === "local", ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}) });
// A shared local cache keeps room for the reply a request usually gives, not the longest it may.
const SHARE_REPLY = 32_768;

function piModel(ep: Endpoint, m: Offering, limit?: number): ProviderModelConfig {
  const contextWindow = windowOf(m, limit);
  const reasoning = !!m.reasoning?.length;
  const toggle = (ep.api === "host" || !!m.llamaServer) && m.reasoning?.length === 1;
  const compat = ep.api === "host" || toggle ? { ...LOCAL_COMPAT, ...(toggle ? { thinkingFormat: "qwen-chat-template" as const } : { supportsReasoningEffort: reasoning }) }
    : ep.kind === "local" ? { ...LOCAL_COMPAT, supportsReasoningEffort: reasoning } : undefined;
  return {
    id: m.modelId, name: m.modelId, input: m.vision ? ["text", "image"] : ["text"], cost: FREE, reasoning,
    // LM Studio thinks unless asked not to: off is `reasoning_effort: "none"`.
    ...(m.lmStudio && reasoning && !m.alwaysThinks ? { thinkingLevelMap: { off: "none" } } : {}),
    contextWindow, maxTokens: replyRoom(ep, m, contextWindow),
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
      const maxTokens = replyRoom(found.endpoint, now, contextWindow);
      if (model.contextWindow !== contextWindow || model.maxTokens !== maxTokens) Object.assign(model, { contextWindow, maxTokens });
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
      // A reply on the plan's usage limit, from anything on this runtime, makes the router skip the plan until it resets.
      runtime.registerNativeProvider(planProvider({ ...endpoint, api: endpoint.api }, list.map((m) => m.modelId), (message) => models.reportPlanLimit(endpoint.id, planLimitReset(message))));
      continue;
    }
    runtime.registerProvider(endpoint.id, {
      name: `${endpoint.name} (${endpoint.kind})`, baseUrl: endpoint.baseUrl, api: "openai-completions",
      models: list.map((m) => piModel(endpoint, m, ctx.contextLimit)),
      streamSimple: (model, context, options) => {
        // Its own signal, so a runaway reply can stop the request; the caller's still stops it.
        const stop = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
        const offering = list.find((m) => m.modelId === model.id);
        const request = (reasoning = options?.reasoning) => markUnservable(model.id, markOverflow(capToolCalls(streamWithInlineThinking(model as Model<"openai-completions">, objectTools(context), { ...options, reasoning, signal }, startsMidThought(offering, reasoning)), () => stop.abort())));
        // Asked not to think, a model whose provider requires it is asked again at medium, or the nearest level it has.
        const must = offering && !options?.reasoning ? models.mandatoryThinking(offering) : undefined;
        const send = () => must ? thinkWhenRequired(request(), () => request(must), () => models.mustThink(offering!.id)) : request();
        if (endpoint.kind !== "local") return send();
        // A local server's cache is shared by everything it serves at once: wait for room (model-share.ts).
        const need = Math.min(model.contextWindow, requestTokens(context) + Math.min(model.maxTokens, SHARE_REPLY));
        const failed = (reason: "aborted" | "error", message: string) => ({ type: "error" as const, reason, error: {
          role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: message, timestamp: Date.now() } });
        const slots = models.offering(ctx.userId, offerings.get(`${endpoint.id}\u0000${model.id}`)?.offering.id ?? "")?.offering.parallel;
        // This session's runtime marks its calls, so its slot can stay warm between them.
        return sharedStream(shareModel(models, `${endpoint.baseUrl}\u0000${model.id}`, need, model.contextWindow, options?.signal, slots, runtime), send, failed);
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

// OpenRouter's words when a model's provider won't run it without thinking.
const MUST_THINK = /reasoning (is mandatory|.{0,40}cannot be disabled)/i;

/**
 * A request sent with thinking off: when the provider refuses it because the
 * model must think, `refused` is told and the request is sent again (`again`).
 */
export function thinkWhenRequired(first: AssistantMessageEventStream, again: () => AssistantMessageEventStream, refused: () => void): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let answered = false;
    try {
      for await (const event of first) {
        if (!answered && event.type === "error" && MUST_THINK.test(event.error.errorMessage ?? "")) {
          refused();
          for await (const e of again()) out.push(e);
          break;
        }
        answered = true;
        out.push(event);
      }
    } finally {
      out.end();
    }
  })();
  return out;
}

// OpenRouter's 404 when the provider it routed to can't run the model (a
// retired deployment, an account it lacks). Pi retries "Provider returned
// error" as a passing fault; this one won't pass within the turn.
const unservable = (message: string) => /\b404\b/.test(message) && /provider returned error/i.test(message);

/**
 * Says plainly that the model's provider can't serve it, in words Pi doesn't
 * retry, instead of OpenRouter's raw 404.
 */
export function markUnservable(modelId: string, source: AssistantMessageEventStream): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        const message = event.type === "error" ? event.error.errorMessage ?? "" : "";
        if (event.type === "error" && unservable(message)) {
          const provider = /"provider_name"\s*:\s*"([^"]{1,60})"/.exec(message)?.[1];
          out.push({ ...event, error: { ...event.error, errorMessage: `${provider ?? "The provider"} can't serve ${modelId} right now (OpenRouter answered 404). Pick another model, or try again later.` } });
        } else out.push(event);
      }
    } finally {
      out.end();
    }
  })();
  return out;
}

/** About how many tokens a request's transcript takes: Pi's estimate per message, and its tool schemas. */
function requestTokens(context: TranscriptContext): number {
  let n = 0;
  for (const m of context.messages) {
    if (m.role === "system") n += Math.ceil(JSON.stringify(m).length / 4);
    else n += estimateTokens(m as Parameters<typeof estimateTokens>[0]);
  }
  return n;
}

/** The Pi model for a task, resolved through the router. Throws CloudModelForbidden like resolveModel. */
export function piModelFor(runtime: ModelRuntime, models: Models, task: Task, ctx: CallContext, resolution?: Resolution): { ref: { offeringId: string }; model: Model<Api>; resolution: Resolution } {
  const r = resolution ?? models.resolve(task, ctx);
  const model = runtime.getModel(r.endpoint.id, r.offering.modelId);
  if (!model) throw new CloudModelForbidden(`${r.label} is not in this thread's model runtime`);
  return { ref: r.ref, model, resolution: r };
}

/** A turn a model that costs money answered because a free one earlier in its list couldn't: a session entry kept out of her context, shown under the reply. */
export const PAID_FALLBACK = "lyrica-paid-fallback";
/** `cleared`: Pi retried the turn and a model that isn't a paid fallback answered, so the turn has no line. */
export type PaidFallback = { model: string; from: string; reason: string } | { cleared: true };

/**
 * Before a turn: picks the chat model again, passing over any whose machine
 * is away (probed when there is a fallback), switches the session to it,
 * sets the thinking level it can do, and records which model answers and why
 * (and, when a paid model answers in place of a free one, a PAID_FALLBACK entry).
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
    const t = o.models.thinkingFor(r, o.call.thinking, o.call.thinkingUnset);
    o.session.setThinkingLevel(t.level);
    note = t.note;
  }
  o.models.recordCall(o.call.userId, { pool: o.pool, threadId: o.threadId, task, resolution: r, ...(note ? { note } : {}) }, { retry: !!o.retry });
  // A model said to be unable to think may think anyway (its server lists no levels): the first reply with thinking clears the note.
  if (note && !r.offering.reasoning?.length) {
    const offeringId = r.offering.id;
    const stop = o.session.subscribe((e) => {
      if (e.type === "agent_end") stop();
      if (e.type !== "message_end" || e.message.role !== "assistant") return;
      if (!e.message.content.some((c) => c.type === "thinking" && c.thinking.trim())) return;
      o.models.sawThinking(o.call.userId, offeringId, { pool: o.pool, threadId: o.threadId, task });
      stop();
    });
  }
  if (r.paidAfter) o.session.sessionManager.appendCustomEntry(PAID_FALLBACK, { model: r.label, from: r.paidAfter.label, reason: r.paidAfter.reason } satisfies PaidFallback);
  else if (o.retry) o.session.sessionManager.appendCustomEntry(PAID_FALLBACK, { cleared: true } satisfies PaidFallback);
  return r;
}
