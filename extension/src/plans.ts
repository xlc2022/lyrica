import { InMemoryCredentialStore, type Api, type ProviderAuthInteraction, type AuthOperationOptions, type Credential, type CredentialInfo, type CredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { DiscoveredModel, Endpoint, Models, PlanCredential, PlanKind } from "@lyrica/core";

// Subscription plans (docs/models.md, "Subscription plans"): Pi's sign-in and
// provider for ChatGPT (Sign in with ChatGPT) and Grok (xAI's device code),
// with the sign-in kept in the user's user.db.

/** Pi's provider for each plan. */
const PROVIDERS: Record<PlanKind, () => Provider> = { chatgpt: openaiProvider, grok: xaiProvider };

/** The models a plan offers, as Pi's catalogue lists them, for discovery. */
export function planCatalog(kind: PlanKind): DiscoveredModel[] {
  return PROVIDERS[kind]().getModels().map((m) => ({
    modelId: m.id, contextWindow: m.contextWindow, tools: true, vision: m.input.includes("image"),
    ...(m.reasoning ? { reasoning: ["low", "medium", "high"] as ("low" | "medium" | "high")[] } : {}),
  }));
}

/** Pi's provider for the plan under its endpoint ID, offering only the plan's listed models, signing in only with the plan. */
export function planProvider(ep: Endpoint & { api: PlanKind }, modelIds: string[]): Provider {
  const base = PROVIDERS[ep.api]();
  const wanted = new Set(modelIds);
  const models = base.getModels().filter((m) => wanted.has(m.id)).map((m) => ({ ...m, provider: ep.id }) as Model<Api>);
  return {
    ...base, id: ep.id, name: `${ep.name} (cloud)`, auth: { oauth: base.auth.oauth! },
    getModels: () => models, getAllModels: () => models, filterModels: undefined, filterAllModels: undefined, refreshModels: undefined,
  };
}

/** OpenAI or xAI refused the refresh token: the sign-in is over, not just unreachable. */
const refused = (e: unknown) => /token request failed \((400|401)\)|token refresh failed \(HTTP (400|401)\)/.test(e instanceof Error ? e.message : String(e));

/** One refresh at a time per plan, across every runtime in this process. */
const chains = new Map<string, Promise<unknown>>();
function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

/**
 * Pi's credential store for one user's runtime: a plan's sign-in is read from
 * and written back to their user.db, so Pi's refresh survives a restart;
 * everything else stays in memory, as before. A refresh OpenAI refuses signs
 * the plan out, and the router skips it until it signs in again.
 */
export class PlanCredentials implements CredentialStore {
  private readonly memory = new InMemoryCredentialStore();
  constructor(private readonly models: Models, private readonly userId: string, private readonly plans: ReadonlySet<string>) {}

  private stored(id: string): Credential | undefined {
    const c = this.models.planCredential(this.userId, id);
    return c && { ...c, type: "oauth" };
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.plans.has(id) ? this.stored(id) : this.memory.read(id, options);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const plans = [...this.plans].filter((id) => this.stored(id)).map((providerId) => ({ providerId, type: "oauth" as const }));
    return [...plans, ...await this.memory.list(options)];
  }

  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (!this.plans.has(id)) return this.memory.modify(id, fn, options);
    return serially(`${this.userId}\u0000${id}`, async () => {
      const current = this.stored(id);
      let next: Credential | undefined;
      try {
        next = await fn(current);
      } catch (e) {
        if (refused(e)) this.models.setPlanCredential(this.userId, id, null);
        throw e;
      }
      if (next && next !== current) {
        if (next.type !== "oauth") throw new Error("a plan signs in with its provider, not an API key");
        this.models.setPlanCredential(this.userId, id, next as PlanCredential);
      }
      return next ?? current;
    });
  }

  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    if (!this.plans.has(id)) return this.memory.delete(id, options);
    await serially(`${this.userId}\u0000${id}`, async () => this.models.setPlanCredential(this.userId, id, null));
  }
}

/**
 * A sign-in under way. ChatGPT: open `url`, approve, and hand `finish` the
 * address the browser was sent to. Grok: open `url`, enter `code` if asked,
 * approve, and call `finish`, which waits for xAI to confirm.
 */
export interface PlanSignIn {
  url: string;
  code?: string;
  finish(redirectUrl?: string): Promise<PlanCredential>;
  cancel(): void;
}

/**
 * Starts a plan's sign-in for a headless server. ChatGPT: Pi listens on
 * 127.0.0.1:1455 for OpenAI's redirect, which only a browser on this machine
 * reaches; from any other device the person copies the address the browser
 * couldn't open, and `finish` hands it to Pi, which checks it and exchanges
 * the code. Grok: xAI's device code, which Pi polls for until it's approved
 * or expires. Nothing here is logged.
 */
export async function startPlanSignIn(kind: PlanKind, installationId: string): Promise<PlanSignIn> {
  const abort = new AbortController();
  let pasted!: (value: string) => void;
  const paste = new Promise<string>((resolve) => { pasted = resolve; });
  let shown!: (v: { url: string; code?: string }) => void;
  const show = new Promise<{ url: string; code?: string }>((resolve) => { shown = resolve; });
  const interaction: ProviderAuthInteraction = {
    signal: abort.signal,
    notify: (e) => {
      if (e.type === "auth_url") shown({ url: e.url });
      if (e.type === "device_code") shown({ url: e.verificationUri, code: e.userCode });
    },
    prompt: async (p) => {
      if (p.type !== "manual_code") throw new Error("the sign-in asked for something Lyrica doesn't answer");
      return paste;
    },
  };
  const login = PROVIDERS[kind]().auth.oauth!.login(interaction, { getDeviceId: () => installationId, agentName: "Lyrica" });
  login.catch(() => {});
  const first = await Promise.race([show, login.then(() => { throw new Error("the sign-in gave no address to open"); })]);
  return {
    ...first,
    async finish(redirectUrl) {
      if (kind === "chatgpt") pasted((redirectUrl ?? "").trim());
      const { type: _t, ...credential } = await login as Credential & PlanCredential;
      return credential as PlanCredential;
    },
    cancel: () => abort.abort(),
  };
}
