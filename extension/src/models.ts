import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CloudModelForbidden, isRestricted, type CallContext, type Endpoint, type EndpointModel, type ModelRef, type Models, type Task } from "@lyrica/core";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT = 32_768;

// Local servers (LM Studio, KoboldCpp, llama-server) take `system` and
// `max_tokens`; they don't all know `developer`, `store` or `max_completion_tokens`.
const LOCAL_COMPAT = { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } as const;

function piModel(ep: Endpoint, m: EndpointModel): ProviderModelConfig {
  const contextWindow = m.contextWindow ?? DEFAULT_CONTEXT;
  return {
    id: m.modelId, name: m.modelId, input: ["text"], cost: FREE, reasoning: false,
    contextWindow, maxTokens: Math.min(8192, Math.floor(contextWindow / 4)),
    ...(ep.kind === "local" ? { compat: LOCAL_COMPAT } : {}),
  };
}

/**
 * A Pi ModelRuntime holding exactly the endpoints this context may use, and
 * nothing else: none of Pi's built-in providers, no auth.json, no models.json,
 * no environment keys. For a private or local-only context that means no cloud
 * model at all, so Pi's compaction and retries have nothing cloud-based to reach.
 * The runtime is sealed: nothing can register another provider into it.
 */
export async function modelRuntimeFor(models: Models, ctx: CallContext): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  // Pi 1.1.0 always loads its built-in catalog. Drop it, so the runtime starts empty.
  const internals = runtime as unknown as { defaultBuiltins: Map<string, unknown>; builtins: Map<string, unknown>; rebuildProviders(): void };
  internals.defaultBuiltins.clear();
  internals.builtins.clear();
  internals.rebuildProviders();

  const allowed = models.allowed(ctx);
  for (const { endpoint, models: list } of allowed) {
    if (!list.length) continue;
    runtime.registerProvider(endpoint.id, {
      name: `${endpoint.name} (${endpoint.kind})`, baseUrl: endpoint.baseUrl, api: "openai-completions",
      models: list.map((m) => piModel(endpoint, m)),
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
export function piModelFor(runtime: ModelRuntime, models: Models, task: Task, ctx: CallContext): { ref: ModelRef; model: Model<Api> } {
  const ref = models.resolveModel(task, ctx);
  const model = runtime.getModel(ref.endpointId, ref.modelId);
  if (!model) throw new CloudModelForbidden(`${ref.endpointId}/${ref.modelId} is not in this thread's model runtime`);
  return { ref, model };
}
