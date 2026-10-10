import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Db } from "../db.ts";
import type { Keyring } from "../keyring.ts";
import { TASKS, type CallContext, type ModelRef, type Pool, type Task } from "../types.ts";
import { Forbidden, type User, type Users } from "../users.ts";
import { addressesOutside, discoverModels, probeUrl, type DiscoveredModel } from "./http.ts";
import { baseName } from "./identity.ts";
import { ENDPOINT_SCHEMA, migrate, MODEL_CHOICE_SCHEMA, REDIRECT_SCHEMA } from "./schema.ts";

export { addressesOutside, discoverModels, probeUrl, type DiscoveredModel } from "./http.ts";
export { baseName } from "./identity.ts";

/** A cloud model was asked for where only local models are allowed. Nothing falls back. */
export class CloudModelForbidden extends Error {}
/** No usable model is set for a task, or the one set no longer exists. */
export class NoModel extends Error {}

/** An endpoint unreachable this long is stale; a model missing this long is gone. */
export const STALE_DAYS = 14;
export const GONE_DAYS = 30;
const DAY = 86_400_000;

export interface Endpoint {
  /** Permanent. */
  id: string;
  /** A label that can change. */
  name: string;
  kind: "cloud" | "local";
  api: "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  shared: boolean;
  /** A local endpoint served over plain HTTP outside this machine and the tailnet. */
  unencrypted: boolean;
  /** When it stopped answering, while it doesn't. */
  downSince?: string;
  /** Unreachable for STALE_DAYS. Fallbacks skip it. */
  stale: boolean;
}

/** What a model can do. Discovered where the endpoint says, else set by hand. */
export interface Capabilities {
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
  embedding?: boolean;
  image?: boolean;
  edit?: boolean;
}
export const CAPABILITIES = ["contextWindow", "tools", "vision", "embedding", "image", "edit"] as const satisfies readonly (keyof Capabilities)[];

/** One model on one endpoint, with a permanent ID. */
export interface Offering extends Capabilities {
  id: string;
  endpointId: string;
  /** The endpoint's own model ID, sent in requests. */
  modelId: string;
  /** Added by hand rather than discovered. */
  manual: boolean;
  /** listed; missing (the endpoint stopped listing it); gone (missing for GONE_DAYS, so fallbacks skip it). */
  status: "listed" | "missing" | "gone";
  missingSince?: string;
}

export type ProfileName = "cloud" | "local";
export type Profiles = Partial<Record<Task, ModelRef>>;

/** Where a user's lists name a model. */
export type Use =
  | { where: "profile"; profile: ProfileName; task: Task }
  | { where: "thread"; pool: Pool; threadId: string; task: Task }
  | { where: "workflow"; name: string };

export interface CleanupItem {
  /** For a stale endpoint, its uses are those of all its models. */
  endpoint: Endpoint;
  offering?: Offering;
  label: string;
  /** Where the asking user's own lists use it. */
  usedIn: Use[];
  /** How many other users' lists name it (shared models only). */
  otherUsers: number;
  /** The same model on another endpoint of the same kind, for Replace with… */
  suggestion?: { offeringId: string; label: string };
}

/** Private and local-only threads may use local endpoints only. */
export const isRestricted = (ctx: Pick<CallContext, "pool" | "localOnly">): boolean => ctx.pool === "private" || ctx.localOnly;
export const profileFor = (ctx: Pick<CallContext, "pool" | "localOnly">): ProfileName => (isRestricted(ctx) ? "local" : "cloud");

export function checkTask(task: string): Task {
  if (!(TASKS as readonly string[]).includes(task)) throw new Error(`unknown task ${task}; tasks are ${TASKS.join(", ")}`);
  return task as Task;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SHARED = "shared.";
const NOTICE = "models_notice";

/** Loopback or the tailnet, by the URL's host alone. */
function nearby(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".ts.net")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 127 || (a === 100 && b >= 64 && b < 128);
  }
  return isIP(h) === 6 && (h === "::1" || /^fd7a:115c:a1e0:/.test(h));
}

async function localWarning(ep: Endpoint): Promise<string | undefined> {
  const host = new URL(ep.baseUrl).hostname;
  try {
    const outside = await addressesOutside(ep.baseUrl);
    if (outside.length) return `${ep.name} is declared local, but ${host} resolves to ${outside.join(", ")}, outside loopback, private and tailnet addresses`;
  } catch {
    return `${ep.name} is declared local, but ${host} doesn't resolve`;
  }
  return undefined;
}

interface EndpointRow { id: string; name: string; kind: "cloud" | "local"; base_url: string; api_key: string | null; down_since: string | null }
interface OfferingRow { id: string; endpoint: string; model: string; found: string; hand: string; manual: number; missing_since: string | null }

const toEndpoint = (r: EndpointRow, shared: boolean, now = Date.now()): Endpoint => {
  const url = new URL(r.base_url);
  return {
    id: r.id, name: r.name, kind: r.kind, api: "openai-compatible", baseUrl: r.base_url, shared,
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    unencrypted: r.kind === "local" && url.protocol === "http:" && !nearby(url.hostname),
    ...(r.down_since ? { downSince: r.down_since } : {}),
    stale: !!r.down_since && now - Date.parse(r.down_since) >= STALE_DAYS * DAY,
  };
};
const toOffering = (r: OfferingRow, now = Date.now()): Offering => {
  const caps: Capabilities = { ...JSON.parse(r.found), ...JSON.parse(r.hand) };
  const gone = !!r.missing_since && now - Date.parse(r.missing_since) >= GONE_DAYS * DAY;
  return {
    id: r.id, endpointId: r.endpoint, modelId: r.model, manual: r.manual === 1,
    ...Object.fromEntries(CAPABILITIES.filter((k) => caps[k] !== undefined).map((k) => [k, caps[k]])),
    status: gone ? "gone" : r.missing_since ? "missing" : "listed",
    ...(r.missing_since ? { missingSince: r.missing_since } : {}),
  };
};
const factsOf = (m: DiscoveredModel): Capabilities => {
  const { modelId: _m, ...caps } = m;
  return Object.fromEntries(Object.entries(caps).filter(([, v]) => v !== undefined));
};

/** Every endpoint and offering one user can see, read once. */
interface Catalog {
  endpoints: Map<string, Endpoint>;
  offerings: Map<string, Offering>;
}

/**
 * Endpoints, offerings, profiles and the router. Shared endpoints live in
 * self.db and change only with an administrator actor; a user's own
 * endpoints, profiles and thread choices live in their user.db, so the user
 * must be unlocked. Opening a user's user.db first applies any redirects
 * they haven't applied yet, so their lists follow replacements and removals
 * made while they were locked.
 */
export class Models {
  private selfReady = false;
  /** Users whose user.db was migrated and indexed since this process started. */
  private readonly ready = new Set<string>();

  constructor(private readonly keyring: Keyring, private readonly users: Users) {}

  // --- Endpoints ---

  addEndpoint(actor: User, input: { name: string; kind: "cloud" | "local"; baseUrl: string; apiKey?: string }, opts: { shared?: boolean } = {}): Endpoint {
    checkName(input.name);
    if (input.kind !== "cloud" && input.kind !== "local") throw new Error("an endpoint is either cloud or local");
    const baseUrl = checkUrl(input.baseUrl);
    const id = randomUUID();
    this.place(actor, !!opts.shared, (db) => {
      if (db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(input.name)) throw new Error(`endpoint ${input.name} already exists`);
      db.prepare("INSERT INTO endpoints (id, name, kind, api, base_url, api_key, created_at) VALUES (?, ?, ?, 'openai-compatible', ?, ?, ?)")
        .run(id, input.name, input.kind, baseUrl, input.apiKey || null, new Date().toISOString());
    });
    return this.endpoint(actor.id, id)!;
  }

  /** Renames an endpoint or changes its URL or key. Its IDs, and its models' IDs, never change. A null key removes it. */
  editEndpoint(actor: User, id: string, change: { name?: string; baseUrl?: string; apiKey?: string | null }): Endpoint {
    if (change.name !== undefined) checkName(change.name);
    const baseUrl = change.baseUrl === undefined ? undefined : checkUrl(change.baseUrl);
    this.write(actor, id, (db) => {
      const current = db.prepare("SELECT * FROM endpoints WHERE id = ?").get(id) as EndpointRow;
      if (change.name !== undefined && change.name !== current.name && db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(change.name)) {
        throw new Error(`endpoint ${change.name} already exists`);
      }
      db.prepare("UPDATE endpoints SET name = ?, base_url = ?, api_key = ? WHERE id = ?").run(
        change.name ?? current.name, baseUrl ?? current.base_url, change.apiKey === undefined ? current.api_key : change.apiKey || null, id);
    });
    return this.endpoint(actor.id, id)!;
  }

  /** Removes an endpoint. Each of its models leaves a tombstone, so lists that named them drop them. */
  removeEndpoint(actor: User, id: string): void {
    this.retire(actor, id, (db) => (db.prepare("SELECT id FROM offerings WHERE endpoint = ?").all(id) as { id: string }[]).map((r) => [r.id, null]), (db) => {
      db.prepare("DELETE FROM endpoints WHERE id = ?").run(id);
    });
  }

  /** The user's own endpoints, then the shared ones. */
  endpoints(userId: string): Endpoint[] {
    return [...this.catalog(userId).endpoints.values()];
  }

  endpoint(userId: string, id: string): Endpoint | undefined {
    return this.catalog(userId).endpoints.get(id);
  }

  /** An endpoint's models. */
  offerings(userId: string, endpointId: string): Offering[] {
    return [...this.catalog(userId).offerings.values()].filter((o) => o.endpointId === endpointId);
  }

  /** An offering and its endpoint, if this user can see it. */
  offering(userId: string, offeringId: string): { endpoint: Endpoint; offering: Offering } | undefined {
    const c = this.catalog(userId);
    const offering = c.offerings.get(offeringId);
    return offering && { endpoint: c.endpoints.get(offering.endpointId)!, offering };
  }

  /**
   * How a model is named to people and to Lyrica: `<endpoint>/<model>`, with
   * shared endpoints as `shared.<name>` so the two never collide.
   */
  label(userId: string, offeringId: string): string | undefined {
    const o = this.offering(userId, offeringId);
    return o && labelOf(o.endpoint, o.offering);
  }

  /** Finds an offering by its ID or its label. */
  find(userId: string, idOrLabel: string): ModelRef | undefined {
    const c = this.catalog(userId);
    if (c.offerings.has(idOrLabel)) return { offeringId: idOrLabel };
    const i = idOrLabel.indexOf("/");
    if (i <= 0) return undefined;
    const ep = this.findEndpoint(userId, idOrLabel.slice(0, i));
    const model = idOrLabel.slice(i + 1);
    const o = ep && [...c.offerings.values()].find((x) => x.endpointId === ep.id && x.modelId === model);
    return o && { offeringId: o.id };
  }

  /** Finds an endpoint by its ID or its label: its name, or `shared.<name>` for a shared one. */
  findEndpoint(userId: string, idOrLabel: string): Endpoint | undefined {
    return this.endpoints(userId).find((e) => e.id === idOrLabel || (e.shared ? SHARED + e.name : e.name) === idOrLabel);
  }

  /** Records a model by hand, for servers whose /v1/models says too little. Returns its offering. */
  addModel(actor: User, endpointId: string, m: { modelId: string } & Capabilities): Offering {
    if (!m.modelId) throw new Error("a model needs its ID");
    const { modelId, ...caps } = m;
    let id = "";
    this.write(actor, endpointId, (db) => {
      const row = db.prepare("SELECT id, hand FROM offerings WHERE endpoint = ? AND model = ?").get(endpointId, modelId) as { id: string; hand: string } | undefined;
      const hand = JSON.stringify(clean({ ...(row ? JSON.parse(row.hand) : {}), ...caps }));
      id = row?.id ?? randomUUID();
      if (row) db.prepare("UPDATE offerings SET hand = ?, missing_since = NULL WHERE id = ?").run(hand, id);
      else db.prepare("INSERT INTO offerings (id, endpoint, model, hand, manual, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(id, endpointId, modelId, hand, new Date().toISOString());
    });
    return this.offering(actor.id, id)!.offering;
  }

  /** Sets capabilities by hand. They win over what discovery reports; undefined leaves one as it is, null clears it. */
  setCapabilities(actor: User, offeringId: string, caps: { [K in keyof Capabilities]?: Capabilities[K] | null }): Offering {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    this.write(actor, o.endpoint.id, (db) => {
      const row = db.prepare("SELECT hand FROM offerings WHERE id = ?").get(offeringId) as { hand: string };
      const hand: Record<string, unknown> = JSON.parse(row.hand);
      for (const k of CAPABILITIES) if (caps[k] === null) delete hand[k]; else if (caps[k] !== undefined) hand[k] = caps[k];
      db.prepare("UPDATE offerings SET hand = ? WHERE id = ?").run(JSON.stringify(hand), offeringId);
    });
    return this.offering(actor.id, offeringId)!.offering;
  }

  /**
   * Re-reads what the endpoint lists. A new model gets an offering; one no
   * longer listed keeps its offering, marked missing; one listed again is
   * no longer missing. IDs never change.
   */
  async discover(actor: User, endpointId: string): Promise<Offering[]> {
    const ep = this.endpoint(actor.id, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    let found: DiscoveredModel[];
    try {
      found = await discoverModels(ep.baseUrl, ep.apiKey);
    } catch (err) {
      this.seen(ep, false, actor.id);
      throw err;
    }
    this.seen(ep, true, actor.id);
    const now = new Date().toISOString();
    this.write(actor, endpointId, (db) => {
      db.transaction(() => {
        const have = new Map((db.prepare("SELECT id, model FROM offerings WHERE endpoint = ?").all(endpointId) as { id: string; model: string }[]).map((r) => [r.model, r.id]));
        for (const m of found) {
          const id = have.get(m.modelId);
          if (id) db.prepare("UPDATE offerings SET found = ?, missing_since = NULL WHERE id = ?").run(JSON.stringify(factsOf(m)), id);
          else db.prepare("INSERT INTO offerings (id, endpoint, model, found, manual, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(randomUUID(), endpointId, m.modelId, JSON.stringify(factsOf(m)), now);
        }
        const listed = new Set(found.map((m) => m.modelId));
        const missing = db.prepare("UPDATE offerings SET missing_since = ? WHERE id = ? AND missing_since IS NULL AND manual = 0");
        for (const [model, id] of have) if (!listed.has(model)) missing.run(now, id);
      })();
    });
    return this.offerings(actor.id, endpointId);
  }

  /**
   * Whether the endpoint answers. For a local endpoint, also a warning when its
   * host resolves outside Li's own network. It only warns: the kind stays as declared.
   */
  async probe(userId: string, endpointId: string): Promise<{ state: "up" | "down"; warning?: string }> {
    const ep = this.endpoint(userId, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    const [state, warning] = await Promise.all([probeUrl(ep.baseUrl, ep.apiKey), ep.kind === "local" ? localWarning(ep) : undefined]);
    this.seen(ep, state === "up", userId);
    return warning ? { state, warning } : { state };
  }

  /** Other offerings of the same model, by name, on endpoints of the same kind: suggested fallbacks and replacements. */
  sameModel(userId: string, offeringId: string): ModelRef[] {
    const c = this.catalog(userId);
    const o = c.offerings.get(offeringId);
    if (!o) return [];
    const kind = c.endpoints.get(o.endpointId)!.kind;
    const name = baseName(o.modelId);
    return [...c.offerings.values()]
      .filter((x) => x.id !== o.id && x.endpointId !== o.endpointId && x.status !== "gone" && c.endpoints.get(x.endpointId)!.kind === kind && !c.endpoints.get(x.endpointId)!.stale && baseName(x.modelId) === name)
      .map((x) => ({ offeringId: x.id }));
  }

  // --- Clean up, redirects and tombstones ---

  /**
   * Stale endpoints and gone models this user can see, with where their own
   * lists use them and how many other users' lists do.
   */
  cleanup(userId: string): CleanupItem[] {
    const c = this.catalog(userId);
    const uses = this.uses(userId);
    const others = (ids: string[]) => {
      const shared = ids.filter((id) => c.endpoints.get(c.offerings.get(id)?.endpointId ?? "")?.shared);
      if (!shared.length) return 0;
      return (this.self().prepare(`SELECT count(DISTINCT user) AS n FROM shared_refs WHERE user != ? AND ref IN (${shared.map(() => "?").join(",")})`)
        .get(userId, ...shared) as { n: number }).n;
    };
    const items: CleanupItem[] = [];
    for (const endpoint of c.endpoints.values()) {
      if (!endpoint.stale) continue;
      const ids = [...c.offerings.values()].filter((o) => o.endpointId === endpoint.id).map((o) => o.id);
      items.push({ endpoint, label: endpoint.shared ? SHARED + endpoint.name : endpoint.name, usedIn: ids.flatMap((id) => uses.get(id) ?? []), otherUsers: others(ids) });
    }
    for (const offering of c.offerings.values()) {
      const endpoint = c.endpoints.get(offering.endpointId)!;
      if (offering.status !== "gone" || endpoint.stale) continue;
      const same = this.sameModel(userId, offering.id)[0];
      items.push({
        endpoint, offering, label: labelOf(endpoint, offering), usedIn: uses.get(offering.id) ?? [], otherUsers: others([offering.id]),
        ...(same ? { suggestion: { offeringId: same.offeringId, label: labelOf(c.endpoints.get(c.offerings.get(same.offeringId)!.endpointId)!, c.offerings.get(same.offeringId)!) } } : {}),
      });
    }
    return items;
  }

  /**
   * Replaces a model everywhere: it is deleted, and a redirect sends every
   * list that named it to the replacement. The replacement must be of the
   * same kind, and for a shared model, shared too.
   */
  replace(actor: User, fromId: string, toId: string): void {
    const from = this.offering(actor.id, fromId);
    const to = this.offering(actor.id, toId);
    if (!from) throw new NoModel(`no model ${fromId}`);
    if (!to) throw new NoModel(`no model ${toId}`);
    if (fromId === toId) throw new Error("a model can't replace itself");
    if (from.endpoint.kind !== to.endpoint.kind) throw new CloudModelForbidden(`a ${from.endpoint.kind} model can only be replaced by another ${from.endpoint.kind} model`);
    if (from.endpoint.shared && !to.endpoint.shared) throw new Error("a shared model can only be replaced by another shared model");
    this.retire(actor, from.endpoint.id, () => [[fromId, toId]], (db) => { db.prepare("DELETE FROM offerings WHERE id = ?").run(fromId); });
  }

  /** Removes a model. A tombstone makes every list that named it drop it. */
  removeOffering(actor: User, offeringId: string): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    this.retire(actor, o.endpoint.id, () => [[offeringId, null]], (db) => { db.prepare("DELETE FROM offerings WHERE id = ?").run(offeringId); });
  }

  /** Gives an endpoint and its models fresh IDs, for a server to be treated as new. Redirects keep every list working. */
  resetIds(actor: User, endpointId: string): string {
    const fresh = randomUUID();
    const map = new Map<string, string>();
    this.retire(actor, endpointId, (db) => {
      for (const r of db.prepare("SELECT id FROM offerings WHERE endpoint = ?").all(endpointId) as { id: string }[]) map.set(r.id, randomUUID());
      return [...map];
    }, (db) => {
      db.pragma("defer_foreign_keys = ON");
      db.prepare("UPDATE endpoints SET id = ?, down_since = NULL WHERE id = ?").run(fresh, endpointId);
      const move = db.prepare("UPDATE offerings SET id = ?, endpoint = ? WHERE id = ?");
      for (const [old, id] of map) move.run(id, fresh, old);
    });
    return fresh;
  }

  /**
   * Merges an endpoint into another that turned out to be the same server.
   * A model both list redirects to the one on `into`; the rest move over
   * with their IDs. `from` is then removed.
   */
  merge(actor: User, fromId: string, intoId: string): void {
    const from = this.endpoint(actor.id, fromId);
    const into = this.endpoint(actor.id, intoId);
    if (!from || !into) throw new Error(`no endpoint ${from ? intoId : fromId}`);
    if (fromId === intoId) throw new Error("an endpoint can't be merged into itself");
    if (from.shared !== into.shared) throw new Error("a shared endpoint can only be merged with another shared endpoint");
    if (from.kind !== into.kind) throw new CloudModelForbidden("a cloud endpoint and a local endpoint can't be merged");
    const moved: string[] = [];
    this.retire(actor, fromId, (db) => {
      const target = new Map((db.prepare("SELECT id, model FROM offerings WHERE endpoint = ?").all(intoId) as { id: string; model: string }[]).map((r) => [r.model, r.id]));
      const pairs: [string, string][] = [];
      for (const r of db.prepare("SELECT id, model FROM offerings WHERE endpoint = ?").all(fromId) as { id: string; model: string }[]) {
        const same = target.get(r.model);
        if (same) pairs.push([r.id, same]); else moved.push(r.id);
      }
      return pairs;
    }, (db) => {
      const move = db.prepare("UPDATE offerings SET endpoint = ? WHERE id = ?");
      for (const id of moved) move.run(intoId, id);
      db.prepare("DELETE FROM endpoints WHERE id = ?").run(fromId);
    });
  }

  /**
   * Housekeeping, run nightly: removes gone models nothing refers to. For a
   * shared model that means no user's lists name it, which needs every user
   * to have been indexed; a user's own gone models go while they are unlocked.
   */
  prune(now = Date.now()): void {
    const self = this.self();
    const gone = (db: Db) => (db.prepare("SELECT * FROM offerings WHERE missing_since IS NOT NULL").all() as OfferingRow[]).filter((r) => toOffering(r, now).status === "gone");
    const allIndexed = this.users.all().every((u) => self.prepare("SELECT 1 FROM shared_refs_indexed WHERE user = ?").get(u.id));
    if (allIndexed) {
      for (const r of gone(self)) if (!self.prepare("SELECT 1 FROM shared_refs WHERE ref = ?").get(r.id)) self.prepare("DELETE FROM offerings WHERE id = ?").run(r.id);
    }
    for (const u of this.users.all()) {
      if (!this.keyring.hasUserKey(u.id)) continue;
      const used = new Set(this.uses(u.id).keys());
      this.withUser(u.id, (db) => { for (const r of gone(db)) if (!used.has(r.id)) db.prepare("DELETE FROM offerings WHERE id = ?").run(r.id); });
    }
  }

  /** The one-time notice about lists rewritten since the user last looked, if any. */
  notice(userId: string): string[] {
    return this.withUser(userId, (db) => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOTICE) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : [];
    });
  }

  dismissNotice(userId: string): void {
    this.withUser(userId, (db) => db.prepare("DELETE FROM settings WHERE key = ?").run(NOTICE));
  }

  // --- Profiles and thread choices ---

  profile(userId: string, name: ProfileName): Profiles {
    const rows = this.withUser(userId, (db) => db.prepare("SELECT task, entry FROM model_profiles WHERE profile = ?").all(name)) as { task: Task; entry: string }[];
    return Object.fromEntries(rows.flatMap((r) => { const first = (JSON.parse(r.entry) as ModelRef[])[0]; return first ? [[r.task, first]] : []; }));
  }

  /** Sets (or with no ref, clears) a profile's model for a task. The local profile takes local models only. */
  setProfile(userId: string, name: ProfileName, task: Task, ref?: ModelRef): void {
    if (ref) this.check(userId, ref, name === "local");
    this.withUser(userId, (db) => {
      if (!ref) db.prepare("DELETE FROM model_profiles WHERE profile = ? AND task = ?").run(name, task);
      else db.prepare("INSERT OR REPLACE INTO model_profiles (profile, task, entry) VALUES (?, ?, ?)").run(name, task, JSON.stringify([{ offeringId: ref.offeringId }]));
      this.index(userId, db);
    });
  }

  /** Sets (or clears) one thread's model for a task. A private or local-only thread takes local models only. */
  setThreadModel(userId: string, pool: Pool, threadId: string, task: Task, ref?: ModelRef): void {
    if (ref) this.check(userId, ref, isRestricted(this.callContext(userId, pool, threadId)));
    this.withUser(userId, (db) => {
      if (!ref) db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ? AND task = ?").run(pool, threadId, task);
      else db.prepare("INSERT OR REPLACE INTO thread_models (pool, thread, task, entry) VALUES (?, ?, ?, ?)").run(pool, threadId, task, JSON.stringify([{ offeringId: ref.offeringId }]));
      this.index(userId, db);
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
      const rows = db.prepare("SELECT task, entry FROM thread_models WHERE pool = ? AND thread = ?").all(pool, threadId) as { task: Task; entry: string }[];
      const localOnly = pool === "private" || !!db.prepare("SELECT 1 FROM local_only_threads WHERE thread = ?").get(threadId);
      return { userId, pool, localOnly, overrides: Object.fromEntries(rows.flatMap((r) => { const first = (JSON.parse(r.entry) as ModelRef[])[0]; return first ? [[r.task, first]] : []; })) };
    });
  }

  /**
   * The CallContext for a child thread, such as a subagent's. It keeps the
   * parent's local-only switch and model choices, and its chat model is the
   * parent's `subagent.<tier>` model, or a named model the parent's context
   * allows. Throws CloudModelForbidden or NoModel before changing anything.
   */
  childContext(parent: CallContext, childThreadId: string, pick: { tier: "cheap" | "strong" } | { model: ModelRef }): CallContext {
    const ref = "tier" in pick ? this.resolveModel(`subagent.${pick.tier}`, parent) : pick.model;
    if ("model" in pick) this.check(parent.userId, ref, isRestricted(parent));
    const { userId, pool } = parent;
    if (parent.localOnly) this.setLocalOnly(userId, pool, childThreadId, true);
    for (const [task, r] of Object.entries(parent.overrides ?? {})) if (task !== "chat") this.setThreadModel(userId, pool, childThreadId, task as Task, r);
    this.setThreadModel(userId, pool, childThreadId, "chat", ref);
    return this.callContext(userId, pool, childThreadId);
  }

  // --- The router ---

  /**
   * The model for a task: the thread's override, else the profile (local for
   * private and local-only threads, cloud otherwise). A task with neither uses
   * the chat model, except `embedding`. Redirects are followed, and a removed
   * model counts as unset; a gone model or a stale endpoint is skipped.
   * Throws CloudModelForbidden for a cloud model in a restricted context;
   * nothing ever falls back across the line.
   */
  resolveModel(task: Task, ctx: CallContext): ModelRef {
    const c = this.catalog(ctx.userId);
    const profile = this.profile(ctx.userId, profileFor(ctx));
    const live = (r: ModelRef | undefined) => {
      const id = r && this.follow(r.offeringId);
      return id ? { offeringId: id } : undefined;
    };
    const pick = (t: Task) => live(ctx.overrides?.[t]) ?? live(profile[t]);
    const ref = pick(task) ?? (task === "embedding" ? undefined : pick("chat"));
    if (!ref) throw new NoModel(`no model is set for ${task} in the ${profileFor(ctx)} profile`);
    const o = c.offerings.get(ref.offeringId);
    if (!o) throw new NoModel(`the model set for ${task} no longer exists`);
    const ep = c.endpoints.get(o.endpointId)!;
    if (isRestricted(ctx) && ep.kind !== "local") throw new CloudModelForbidden(`${labelOf(ep, o)} is a cloud model, and only local models are allowed here`);
    if (o.status === "gone") throw new NoModel(`${labelOf(ep, o)} has been missing from ${ep.name} for ${GONE_DAYS} days`);
    if (ep.stale) throw new NoModel(`${ep.name} hasn't answered for ${STALE_DAYS} days`);
    return ref;
  }

  /** Every endpoint and model a context may use. For a restricted context, local endpoints only. */
  allowed(ctx: CallContext): { endpoint: Endpoint; offerings: Offering[] }[] {
    const c = this.catalog(ctx.userId);
    return [...c.endpoints.values()]
      .filter((e) => !isRestricted(ctx) || e.kind === "local")
      .map((endpoint) => ({ endpoint, offerings: [...c.offerings.values()].filter((o) => o.endpointId === endpoint.id) }));
  }

  private check(userId: string, ref: ModelRef, localOnly: boolean): void {
    const o = this.offering(userId, ref.offeringId);
    if (!o) throw new NoModel(`no model ${ref.offeringId}`);
    if (localOnly && o.endpoint.kind !== "local") throw new CloudModelForbidden(`${labelOf(o.endpoint, o.offering)} is a cloud model, and only local models are allowed here`);
  }

  /** Follows a shared model's redirects. Undefined for a removed one. */
  private follow(id: string): string | undefined {
    const db = this.self();
    for (let hops = 0; hops < 16; hops++) {
      const r = db.prepare("SELECT to_id FROM offering_redirects WHERE from_id = ?").get(id) as { to_id: string | null } | undefined;
      if (!r) return id;
      if (!r.to_id) return undefined;
      id = r.to_id;
    }
    return undefined;
  }

  // --- Storage ---

  private catalog(userId: string): Catalog {
    const now = Date.now();
    const read = (db: Db, shared: boolean) => ({
      endpoints: (db.prepare("SELECT * FROM endpoints ORDER BY name").all() as EndpointRow[]).map((r) => toEndpoint(r, shared, now)),
      offerings: (db.prepare("SELECT * FROM offerings ORDER BY model").all() as OfferingRow[]).map((r) => toOffering(r, now)),
    });
    const own = this.withUser(userId, (db) => read(db, false));
    const shared = read(this.self(), true);
    return {
      endpoints: new Map([...own.endpoints, ...shared.endpoints].map((e) => [e.id, e])),
      offerings: new Map([...own.offerings, ...shared.offerings].map((o) => [o.id, o])),
    };
  }

  /**
   * A call to the endpoint succeeded: it isn't down, so it can't go stale.
   * Stale counts only failures with no success since.
   */
  reportUp(userId: string, endpointId: string): void {
    const sql = "UPDATE endpoints SET down_since = NULL WHERE id = ? AND down_since IS NOT NULL";
    if (this.isShared(endpointId)) this.self().prepare(sql).run(endpointId);
    else this.withUser(userId, (db) => db.prepare(sql).run(endpointId));
  }

  private isShared(endpointId: string): boolean {
    return !!this.self().prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId);
  }

  /**
   * A saved workflow's models as offering IDs, so renaming an endpoint breaks
   * nothing and the IDs are indexed and rewritten like any list. A name that
   * isn't one of the user's models is refused.
   */
  workflowSpec<T>(userId: string, spec: T): T {
    const name = (v: unknown) => {
      const ref = typeof v === "string" ? this.find(userId, v) : undefined;
      if (!ref) throw new NoModel(`no model ${String(v)}; name it as <endpoint>/<model>`);
      return ref.offeringId;
    };
    const s = JSON.parse(JSON.stringify(spec ?? {})) as { chain?: { model?: string }[]; council?: { models?: string[] } };
    for (const step of s.chain ?? []) if (step.model) step.model = name(step.model);
    if (s.council?.models) s.council.models = s.council.models.map(name);
    return s as T;
  }

  /** Records this user's shared references again, after something outside the router (a saved workflow) changed them. */
  reindex(userId: string): void {
    this.withUser(userId, (db) => this.index(userId, db));
  }

  /** Records whether an endpoint answered, for stale. */
  private seen(ep: Endpoint, up: boolean, userId: string): void {
    const sql = up ? "UPDATE endpoints SET down_since = NULL WHERE id = ?" : "UPDATE endpoints SET down_since = ? WHERE id = ? AND down_since IS NULL";
    const args = up ? [ep.id] : [new Date().toISOString(), ep.id];
    if (ep.shared) this.self().prepare(sql).run(...args);
    else this.withUser(userId, (db) => db.prepare(sql).run(...args));
  }

  private self(): Db {
    const db = this.keyring.self();
    if (!this.selfReady) {
      db.exec(ENDPOINT_SCHEMA + REDIRECT_SCHEMA);
      migrate(db, {
        legacy: (pairs) => { for (const p of pairs) db.prepare("INSERT OR IGNORE INTO legacy_refs (endpoint, model, offering) VALUES (?, ?, ?)").run(p.endpoint, p.model, p.offering); },
      });
      this.selfReady = true;
    }
    return db;
  }

  private withUser<T>(userId: string, fn: (db: Db) => T): T {
    const self = this.self();
    const db = this.users.openUserDb(userId);
    try {
      if (!this.ready.has(userId)) {
        db.exec(ENDPOINT_SCHEMA);
        const dropped = migrate(db, {
          shared: (endpoint, model) => (self.prepare("SELECT offering FROM legacy_refs WHERE endpoint = ? AND model = ?").get(endpoint, model) as { offering: string } | undefined)?.offering,
        });
        db.exec(MODEL_CHOICE_SCHEMA);
        if (dropped.length) addNotice(db, [`Models that no longer existed were taken out of your lists: ${dropped.join(", ")}.`]);
      }
      this.sync(userId, db, self);
      if (!this.ready.has(userId)) { this.index(userId, db); this.ready.add(userId); }
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** Applies the shared redirects this user hasn't applied yet, then drops redirects nobody still needs. */
  private sync(userId: string, db: Db, self: Db): void {
    const pending = self.prepare("SELECT r.from_id, r.label FROM redirect_pending p JOIN offering_redirects r ON r.from_id = p.from_id WHERE p.user = ?")
      .all(userId) as { from_id: string; label: string }[];
    if (!pending.length) return;
    const map = new Map(pending.map((r) => [r.from_id, this.follow(r.from_id) ?? null]));
    const labels = new Map(pending.map((r) => [r.from_id, r.label]));
    // The rewrite and its notice together; if anything stops before the pending rows go, the rewrite runs again and changes nothing.
    db.transaction(() => {
      const lines = rewrite(db, map, (id) => labels.get(id) ?? id, (id) => this.labelIn(self, id));
      if (lines.length) addNotice(db, lines);
    })();
    const done = self.prepare("DELETE FROM redirect_pending WHERE from_id = ? AND user = ?");
    const unused = self.prepare("DELETE FROM offering_redirects WHERE from_id = ? AND NOT EXISTS (SELECT 1 FROM redirect_pending WHERE from_id = ?)");
    self.transaction(() => { for (const r of pending) { done.run(r.from_id, userId); unused.run(r.from_id, r.from_id); } })();
    this.index(userId, db);
  }

  /** Records which shared models this user's lists name: shared offerings and redirected IDs only. */
  private index(userId: string, db: Db): void {
    const self = this.self();
    const shared = new Set((self.prepare("SELECT id FROM offerings UNION SELECT from_id FROM offering_redirects").all() as { id: string }[]).map((r) => r.id));
    const refs = [...collectRefs(db).keys()].filter((id) => shared.has(id));
    self.transaction(() => {
      self.prepare("DELETE FROM shared_refs WHERE user = ?").run(userId);
      const add = self.prepare("INSERT OR IGNORE INTO shared_refs (user, ref) VALUES (?, ?)");
      for (const r of refs) add.run(userId, r);
      self.prepare("INSERT OR IGNORE INTO shared_refs_indexed (user) VALUES (?)").run(userId);
    })();
  }

  /** Where this user's own lists use each offering. */
  private uses(userId: string): Map<string, Use[]> {
    return this.withUser(userId, (db) => collectRefs(db));
  }

  private labelIn(db: Db, offeringId: string): string | undefined {
    const r = db.prepare("SELECT e.name, o.model FROM offerings o JOIN endpoints e ON e.id = o.endpoint WHERE o.id = ?").get(offeringId) as { name: string; model: string } | undefined;
    return r && `${SHARED}${r.name}/${r.model}`;
  }

  /**
   * Retires offerings on one endpoint: `pairs` lists each from → to (null
   * for removed), then `change` runs in the same transaction. A personal
   * endpoint's owner rewrites their lists at once; a shared endpoint's
   * redirects wait for each user, who rewrites theirs at their next open.
   */
  private retire(actor: User, endpointId: string, pairs: (db: Db) => [string, string | null][], change: (db: Db) => void): void {
    const shared = !!this.self().prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId);
    if (shared) {
      if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints");
      const self = this.self();
      const users = this.users.all();
      self.transaction(() => {
        const list = pairs(self);
        const now = new Date().toISOString();
        for (const [from, to] of list) {
          // Earlier redirects to `from` now point straight at its target, so chains stay one hop long and can't loop.
          self.prepare("UPDATE offering_redirects SET to_id = ? WHERE to_id = ?").run(to, from);
          self.prepare("INSERT OR REPLACE INTO offering_redirects (from_id, to_id, label, created_at) VALUES (?, ?, ?, ?)").run(from, to, this.labelIn(self, from) ?? from, now);
          for (const u of users) self.prepare("INSERT OR IGNORE INTO redirect_pending (from_id, user) VALUES (?, ?)").run(from, u.id);
        }
        change(self);
      })();
      return;
    }
    this.withUser(actor.id, (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) throw new Error(`no endpoint ${endpointId}`);
      db.transaction(() => {
        const list = pairs(db);
        const label = (id: string) => { const r = db.prepare("SELECT e.name, o.model FROM offerings o JOIN endpoints e ON e.id = o.endpoint WHERE o.id = ?").get(id) as { name: string; model: string } | undefined; return r ? `${r.name}/${r.model}` : id; };
        const labels = new Map(list.map(([from]) => [from, label(from)]));
        change(db);
        const toLabel = (id: string) => (db.prepare("SELECT 1 FROM offerings WHERE id = ?").get(id) ? label(id) : this.labelIn(this.self(), id));
        rewrite(db, new Map(list), (id) => labels.get(id) ?? id, toLabel);
      })();
      this.index(actor.id, db);
    });
  }

  /** Shared endpoints change only with an administrator; own endpoints, only as their user. */
  private write(actor: User, endpointId: string, fn: (db: Db) => void): void {
    if (this.self().prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) {
      if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints");
      return fn(this.self());
    }
    this.withUser(actor.id, (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) throw new Error(`no endpoint ${endpointId}`);
      fn(db);
    });
  }

  private place(actor: User, shared: boolean, fn: (db: Db) => void): void {
    if (!shared) return this.withUser(actor.id, fn);
    if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints");
    fn(this.self());
  }
}

const labelOf = (ep: Endpoint, o: Offering) => `${ep.shared ? SHARED : ""}${ep.name}/${o.modelId}`;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error("endpoint names use lowercase letters, digits and '-'");
}

function checkUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the base URL must be http or https");
  return baseUrl.replace(/\/+$/, "");
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function addNotice(db: Db, lines: string[]): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOTICE) as { value: string } | undefined;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(NOTICE, JSON.stringify([...(row ? JSON.parse(row.value) : []), ...lines]));
}

const hasTable = (db: Db, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Every offering ID a user's lists name, with where. Saved workflows may name models by offering ID. */
function collectRefs(db: Db): Map<string, Use[]> {
  const out = new Map<string, Use[]>();
  const add = (id: string, use: Use) => out.set(id, [...(out.get(id) ?? []), use]);
  for (const r of db.prepare("SELECT profile, task, entry FROM model_profiles").all() as { profile: ProfileName; task: Task; entry: string }[]) {
    for (const ref of JSON.parse(r.entry) as ModelRef[]) add(ref.offeringId, { where: "profile", profile: r.profile, task: r.task });
  }
  for (const r of db.prepare("SELECT pool, thread, task, entry FROM thread_models").all() as { pool: Pool; thread: string; task: Task; entry: string }[]) {
    for (const ref of JSON.parse(r.entry) as ModelRef[]) add(ref.offeringId, { where: "thread", pool: r.pool, threadId: r.thread, task: r.task });
  }
  if (hasTable(db, "delegate_workflows")) {
    for (const r of db.prepare("SELECT name, spec FROM delegate_workflows").all() as { name: string; spec: string }[]) {
      for (const id of new Set(r.spec.match(UUID_G) ?? [])) add(id, { where: "workflow", name: r.name });
    }
  }
  return out;
}

/**
 * Rewrites a user's lists through `map` (from → to, or null for removed):
 * profiles, thread choices and saved workflows. A list left empty is
 * cleared. Returns the lines for the user's notice.
 */
function rewrite(db: Db, map: Map<string, string | null>, oldLabel: (id: string) => string, newLabel: (id: string) => string | undefined): string[] {
  const places = new Map<string, Set<string>>();
  const threads = new Map<string, Set<string>>();
  const note = (into: Map<string, Set<string>>, from: string, where: string) => into.set(from, (into.get(from) ?? new Set()).add(where));
  /** The list through `map`: undefined if untouched, null if left empty. */
  const mapList = (entry: string, touched: (from: string) => void): string | null | undefined => {
    const list = JSON.parse(entry) as ModelRef[];
    if (!list.some((r) => map.has(r.offeringId))) return undefined;
    const next: ModelRef[] = [];
    for (const r of list) {
      let to: string | null = r.offeringId;
      if (map.has(r.offeringId)) { touched(r.offeringId); to = map.get(r.offeringId)!; }
      if (to && !next.some((n) => n.offeringId === to)) next.push({ offeringId: to });
    }
    return next.length ? JSON.stringify(next) : null;
  };
  for (const r of db.prepare("SELECT profile, task, entry FROM model_profiles").all() as { profile: string; task: string; entry: string }[]) {
    const next = mapList(r.entry, (from) => note(places, from, `the ${r.profile} profile's ${r.task}`));
    if (next === null) db.prepare("DELETE FROM model_profiles WHERE profile = ? AND task = ?").run(r.profile, r.task);
    else if (next) db.prepare("UPDATE model_profiles SET entry = ? WHERE profile = ? AND task = ?").run(next, r.profile, r.task);
  }
  for (const r of db.prepare("SELECT pool, thread, task, entry FROM thread_models").all() as { pool: string; thread: string; task: string; entry: string }[]) {
    const next = mapList(r.entry, (from) => note(threads, from, `${r.pool}/${r.thread}`));
    if (next === null) db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ? AND task = ?").run(r.pool, r.thread, r.task);
    else if (next) db.prepare("UPDATE thread_models SET entry = ? WHERE pool = ? AND thread = ? AND task = ?").run(next, r.pool, r.thread, r.task);
  }
  if (hasTable(db, "delegate_workflows")) {
    for (const r of db.prepare("SELECT name, spec FROM delegate_workflows").all() as { name: string; spec: string }[]) {
      const ids = (r.spec.match(UUID_G) ?? []).filter((id) => map.has(id));
      if (!ids.length) continue;
      for (const id of ids) note(places, id, `the workflow ${r.name}`);
      db.prepare("UPDATE delegate_workflows SET spec = ? WHERE name = ?").run(JSON.stringify(rewriteSpec(JSON.parse(r.spec), map)), r.name);
    }
  }
  const lines: string[] = [];
  for (const [from, to] of map) {
    const where = [...(places.get(from) ?? [])];
    const n = threads.get(from)?.size ?? 0;
    if (n) where.push(n === 1 ? "one thread" : `${n} threads`);
    if (!where.length) continue;
    lines.push(`${oldLabel(from)} ${to ? `was replaced by ${newLabel(to) ?? "another model"}` : "was removed"} in ${where.join(", ")}.`);
  }
  return lines;
}

/** A workflow's model names through `map`: a removed model is dropped, so its step uses its tier. */
function rewriteSpec(spec: unknown, map: Map<string, string | null>): unknown {
  const swap = (v: string) => (map.has(v) ? map.get(v) : v);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== null && x !== undefined);
    if (!v || typeof v !== "object") return typeof v === "string" && UUID.test(v) ? swap(v) : v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]).filter(([, x]) => x !== null && x !== undefined));
  };
  return walk(spec);
}
