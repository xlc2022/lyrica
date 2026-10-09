import type { Db } from "../db.ts";
import type { Keyring } from "../keyring.ts";
import { TASKS, type CallContext, type ModelRef, type Pool, type Task } from "../types.ts";
import { Forbidden, type User, type Users } from "../users.ts";
import { discoverModels, probeUrl } from "./http.ts";
import { ENDPOINT_SCHEMA, MODEL_CHOICE_SCHEMA } from "./schema.ts";

export { discoverModels, probeUrl, type DiscoveredModel } from "./http.ts";

/** A cloud model was asked for where only local models are allowed. Nothing falls back. */
export class CloudModelForbidden extends Error {}
/** No usable model is set for a task, or the one set no longer exists. */
export class NoModel extends Error {}

export interface Endpoint {
  /** Its name for a user's own endpoint; `shared.<name>` for a shared one. */
  id: string;
  name: string;
  kind: "cloud" | "local";
  api: "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  shared: boolean;
}

export interface EndpointModel {
  endpointId: string;
  modelId: string;
  contextWindow?: number;
  tools?: boolean;
  manual: boolean;
}

export type ProfileName = "cloud" | "local";
export type Profiles = Partial<Record<Task, ModelRef>>;

/** Private and local-only threads may use local endpoints only. */
export const isRestricted = (ctx: Pick<CallContext, "pool" | "localOnly">): boolean => ctx.pool === "private" || ctx.localOnly;
export const profileFor = (ctx: Pick<CallContext, "pool" | "localOnly">): ProfileName => (isRestricted(ctx) ? "local" : "cloud");
export const refString = (r: ModelRef) => `${r.endpointId}/${r.modelId}`;

/** Parses `endpoint/model`. Model IDs may themselves contain slashes. */
export function parseRef(s: string): ModelRef {
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) throw new Error(`expected <endpoint>/<model>, got ${s}`);
  return { endpointId: s.slice(0, i), modelId: s.slice(i + 1) };
}

export function checkTask(task: string): Task {
  if (!(TASKS as readonly string[]).includes(task)) throw new Error(`unknown task ${task}; tasks are ${TASKS.join(", ")}`);
  return task as Task;
}

const SHARED = "shared.";

interface EndpointRow { id: string; name: string; kind: "cloud" | "local"; base_url: string; api_key: string | null }
interface ModelRow { endpoint: string; model: string; context_window: number | null; tools: number | null; manual: number }

const toEndpoint = (r: EndpointRow): Endpoint => ({
  id: r.id, name: r.name, kind: r.kind, api: "openai-compatible", baseUrl: r.base_url,
  ...(r.api_key ? { apiKey: r.api_key } : {}), shared: r.id.startsWith(SHARED),
});
const toModel = (r: ModelRow): EndpointModel => ({
  endpointId: r.endpoint, modelId: r.model, manual: r.manual === 1,
  ...(r.context_window ? { contextWindow: r.context_window } : {}),
  ...(r.tools === null ? {} : { tools: r.tools === 1 }),
});

/**
 * Endpoints, profiles and the router. Shared endpoints live in self.db and
 * change only with an administrator actor; a user's own endpoints, profiles and
 * thread choices live in their user.db, so the user must be unlocked.
 */
export class Models {
  private selfReady = false;

  constructor(private readonly keyring: Keyring, private readonly users: Users) {}

  // --- Endpoints ---

  addEndpoint(actor: User, input: { name: string; kind: "cloud" | "local"; baseUrl: string; apiKey?: string }, opts: { shared?: boolean } = {}): Endpoint {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.name)) throw new Error("endpoint names use lowercase letters, digits and '-'");
    if (input.kind !== "cloud" && input.kind !== "local") throw new Error("an endpoint is either cloud or local");
    const url = new URL(input.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the base URL must be http or https");
    const id = opts.shared ? SHARED + input.name : input.name;
    this.write(actor, id, (db) => {
      if (db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(id)) throw new Error(`endpoint ${id} already exists`);
      db.prepare("INSERT INTO endpoints (id, name, kind, api, base_url, api_key, created_at) VALUES (?, ?, ?, 'openai-compatible', ?, ?, ?)")
        .run(id, input.name, input.kind, input.baseUrl.replace(/\/+$/, ""), input.apiKey || null, new Date().toISOString());
    });
    return this.endpoint(actor.id, id)!;
  }

  removeEndpoint(actor: User, id: string): void {
    this.write(actor, id, (db) => {
      if (db.prepare("DELETE FROM endpoints WHERE id = ?").run(id).changes === 0) throw new Error(`no endpoint ${id}`);
    });
  }

  /** The user's own endpoints, then the shared ones. */
  endpoints(userId: string): Endpoint[] {
    const sql = "SELECT * FROM endpoints ORDER BY name";
    const own = this.withUser(userId, (db) => db.prepare(sql).all() as EndpointRow[]);
    return [...own, ...(this.self().prepare(sql).all() as EndpointRow[])].map(toEndpoint);
  }

  endpoint(userId: string, id: string): Endpoint | undefined {
    const sql = "SELECT * FROM endpoints WHERE id = ?";
    const row = id.startsWith(SHARED)
      ? this.self().prepare(sql).get(id)
      : this.withUser(userId, (db) => db.prepare(sql).get(id));
    return row ? toEndpoint(row as EndpointRow) : undefined;
  }

  models(userId: string, endpointId: string): EndpointModel[] {
    const sql = "SELECT * FROM endpoint_models WHERE endpoint = ? ORDER BY model";
    const rows = endpointId.startsWith(SHARED)
      ? this.self().prepare(sql).all(endpointId)
      : this.withUser(userId, (db) => db.prepare(sql).all(endpointId));
    return (rows as ModelRow[]).map(toModel);
  }

  /** Records a model by hand, for servers whose /v1/models says too little. */
  addModel(actor: User, endpointId: string, m: { modelId: string; contextWindow?: number; tools?: boolean }): void {
    this.write(actor, endpointId, (db) => {
      this.need(db, endpointId);
      db.prepare("INSERT OR REPLACE INTO endpoint_models (endpoint, model, context_window, tools, manual) VALUES (?, ?, ?, ?, 1)")
        .run(endpointId, m.modelId, m.contextWindow ?? null, m.tools === undefined ? null : m.tools ? 1 : 0);
    });
  }

  /** Replaces the endpoint's discovered models with what /v1/models lists now. Manual entries stay. */
  async discover(actor: User, endpointId: string): Promise<EndpointModel[]> {
    const ep = this.endpoint(actor.id, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    const found = await discoverModels(ep.baseUrl, ep.apiKey);
    this.write(actor, endpointId, (db) => {
      db.transaction(() => {
        db.prepare("DELETE FROM endpoint_models WHERE endpoint = ? AND manual = 0").run(endpointId);
        const insert = db.prepare("INSERT OR IGNORE INTO endpoint_models (endpoint, model, context_window, tools, manual) VALUES (?, ?, ?, ?, 0)");
        for (const m of found) insert.run(endpointId, m.modelId, m.contextWindow ?? null, m.tools === undefined ? null : m.tools ? 1 : 0);
      })();
    });
    return this.models(actor.id, endpointId);
  }

  async probe(userId: string, endpointId: string): Promise<"up" | "down"> {
    const ep = this.endpoint(userId, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    return probeUrl(ep.baseUrl, ep.apiKey);
  }

  // --- Profiles and thread choices ---

  profile(userId: string, name: ProfileName): Profiles {
    const rows = this.withUser(userId, (db) =>
      db.prepare("SELECT task, endpoint, model FROM model_profiles WHERE profile = ?").all(name)) as { task: Task; endpoint: string; model: string }[];
    return Object.fromEntries(rows.map((r) => [r.task, { endpointId: r.endpoint, modelId: r.model }]));
  }

  /** Sets (or with no ref, clears) a profile's model for a task. The local profile takes local models only. */
  setProfile(userId: string, name: ProfileName, task: Task, ref?: ModelRef): void {
    if (ref) this.check(userId, ref, name === "local");
    this.withUser(userId, (db) => {
      if (!ref) db.prepare("DELETE FROM model_profiles WHERE profile = ? AND task = ?").run(name, task);
      else db.prepare("INSERT OR REPLACE INTO model_profiles (profile, task, endpoint, model) VALUES (?, ?, ?, ?)").run(name, task, ref.endpointId, ref.modelId);
    });
  }

  /** Sets (or clears) one thread's model for a task. A private or local-only thread takes local models only. */
  setThreadModel(userId: string, pool: Pool, threadId: string, task: Task, ref?: ModelRef): void {
    if (ref) this.check(userId, ref, isRestricted(this.callContext(userId, pool, threadId)));
    this.withUser(userId, (db) => {
      if (!ref) db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ? AND task = ?").run(pool, threadId, task);
      else db.prepare("INSERT OR REPLACE INTO thread_models (pool, thread, task, endpoint, model) VALUES (?, ?, ?, ?, ?)").run(pool, threadId, task, ref.endpointId, ref.modelId);
    });
  }

  /** Switches a general thread to local-only, or back. Private threads are always local-only. */
  setLocalOnly(userId: string, pool: Pool, threadId: string, on: boolean): void {
    if (pool === "private" && !on) throw new CloudModelForbidden("a private thread is always local-only");
    if (pool === "private") return;
    this.withUser(userId, (db) => {
      if (on) db.prepare("INSERT OR IGNORE INTO local_only_threads (thread) VALUES (?)").run(threadId);
      else db.prepare("DELETE FROM local_only_threads WHERE thread = ?").run(threadId);
    });
  }

  /** The thread's CallContext: its local-only switch and model overrides. */
  callContext(userId: string, pool: Pool, threadId: string): CallContext {
    return this.withUser(userId, (db) => {
      const rows = db.prepare("SELECT task, endpoint, model FROM thread_models WHERE pool = ? AND thread = ?").all(pool, threadId) as { task: Task; endpoint: string; model: string }[];
      const localOnly = pool === "private" || !!db.prepare("SELECT 1 FROM local_only_threads WHERE thread = ?").get(threadId);
      return { userId, pool, localOnly, overrides: Object.fromEntries(rows.map((r) => [r.task, { endpointId: r.endpoint, modelId: r.model }])) };
    });
  }

  /** Copies a thread's choices to a child thread (a subagent). A child of a local-only thread is local-only. */
  inheritModels(userId: string, pool: Pool, parentId: string, childId: string): void {
    const parent = this.callContext(userId, pool, parentId);
    if (parent.localOnly) this.setLocalOnly(userId, pool, childId, true);
    for (const [task, ref] of Object.entries(parent.overrides ?? {})) this.setThreadModel(userId, pool, childId, task as Task, ref);
  }

  // --- The router ---

  /**
   * The model for a task: the thread's override, else the profile (local for
   * private and local-only threads, cloud otherwise). A task with neither uses
   * the chat model, except `embedding`. Throws CloudModelForbidden for a cloud
   * model in a restricted context; nothing ever falls back across the line.
   */
  resolveModel(task: Task, ctx: CallContext): ModelRef {
    const profile = this.profile(ctx.userId, profileFor(ctx));
    const pick = (t: Task) => ctx.overrides?.[t] ?? profile[t];
    const ref = pick(task) ?? (task === "embedding" ? undefined : pick("chat"));
    if (!ref) throw new NoModel(`no model is set for ${task} in the ${profileFor(ctx)} profile`);
    this.check(ctx.userId, ref, isRestricted(ctx));
    return ref;
  }

  /** Every endpoint and model a context may use. For a restricted context, local endpoints only. */
  allowed(ctx: CallContext): { endpoint: Endpoint; models: EndpointModel[] }[] {
    return this.endpoints(ctx.userId)
      .filter((e) => !isRestricted(ctx) || e.kind === "local")
      .map((endpoint) => ({ endpoint, models: this.models(ctx.userId, endpoint.id) }));
  }

  private check(userId: string, ref: ModelRef, localOnly: boolean): void {
    const ep = this.endpoint(userId, ref.endpointId);
    if (!ep) throw new NoModel(`no endpoint ${ref.endpointId}`);
    if (localOnly && ep.kind !== "local") throw new CloudModelForbidden(`${refString(ref)} is a cloud model, and only local models are allowed here`);
    if (!this.models(userId, ep.id).some((m) => m.modelId === ref.modelId)) throw new NoModel(`${ref.endpointId} has no model ${ref.modelId}`);
  }

  // --- Storage ---

  private self(): Db {
    const db = this.keyring.self();
    if (!this.selfReady) { db.exec(ENDPOINT_SCHEMA); this.selfReady = true; }
    return db;
  }

  private withUser<T>(userId: string, fn: (db: Db) => T): T {
    const db = this.users.openUserDb(userId);
    try {
      db.exec(ENDPOINT_SCHEMA + MODEL_CHOICE_SCHEMA);
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** Shared endpoints change only with an administrator; own endpoints, only as their user. */
  private write(actor: User, endpointId: string, fn: (db: Db) => void): void {
    if (!endpointId.startsWith(SHARED)) return this.withUser(actor.id, fn);
    if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints");
    fn(this.self());
  }

  private need(db: Db, endpointId: string): void {
    if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) throw new Error(`no endpoint ${endpointId}`);
  }
}
