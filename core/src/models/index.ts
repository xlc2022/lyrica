import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Db } from "../db.ts";
import type { Keyring } from "../keyring.ts";
import { TASKS, THINKING_LEVELS, type CallContext, type ModelRef, type Pool, type Task, type ThinkingLevel } from "../types.ts";
import { Forbidden, type User, type Users } from "../users.ts";
import { addressesOutside, discoverModels, probeUrl, type DiscoveredModel, type ModelIdentity } from "./http.ts";
import { hostError, hostFetch, hostOrigin, lyricaIdentity, pair } from "./host.ts";
import { baseName } from "./identity.ts";
import { copyIdentity } from "./library.ts";
import { ANSWER_SETTINGS, checkSettings, type AnswerSettings, type SettingSource } from "./settings.ts";
import { collectRefs, isList, mapMembers, refId, rewrite, type Entry, type ProfileName, type Use } from "./refs.ts";
import { ENDPOINT_SCHEMA, migrate, MODEL_CHOICE_SCHEMA, REDIRECT_SCHEMA } from "./schema.ts";

export { addressesOutside, discoverModels, probeUrl, type DiscoveredModel, type ModelIdentity } from "./http.ts";
export { baseName } from "./identity.ts";
export { ANSWER_SETTINGS, payloadFields, type AnswerSettings, type SettingSource } from "./settings.ts";
export { fingerprint, HostIdentityChanged, hostOrigin, normaliseCode, PairingFailed, pairingProofs } from "./host.ts";
export { refId, type Entry, type ProfileName, type Use } from "./refs.ts";

/** A cloud model was asked for where only local models are allowed. Nothing falls back. */
export class CloudModelForbidden extends Error {}
/** No usable model is set for a task, or the one set no longer exists. */
export class NoModel extends Error {}
/** A model host refused a call, with its error code and plain message. */
export class HostRefused extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** An endpoint unreachable this long is stale; a model missing this long is gone. */
export const STALE_DAYS = 14;
export const GONE_DAYS = 30;
const DAY = 86_400_000;
/** How long a probe or a failed call counts for in the health cache. */
export const HEALTH_MS = 30_000;
/** How long the router waits for a probe before trying the next model. */
const PROBE_MS = 2_000;
/** Recent calls kept per user. */
const CALLS_KEPT = 500;

export interface Endpoint {
  /** Permanent. */
  id: string;
  /** A label that can change. */
  name: string;
  kind: "cloud" | "local";
  /** A plain OpenAI-compatible server, or a paired model host. */
  api: "openai-compatible" | "host";
  /** For a host, its first address's `/v1`. */
  baseUrl: string;
  apiKey?: string;
  shared: boolean;
  /** A host's addresses, tried in order. */
  addresses?: string[];
  /** A host's pinned key fingerprint. */
  fingerprint?: string;
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
  /** The thinking levels it offers, besides off. */
  reasoning?: Exclude<ThinkingLevel, "off">[];
}
export const CAPABILITIES = ["contextWindow", "tools", "vision", "embedding", "image", "edit", "reasoning"] as const satisfies readonly (keyof Capabilities)[];

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
  /** The file's SHA-256, where a host reports it. */
  digest?: string;
  /** What a host read from the file or its model card. */
  identity?: ModelIdentity;
  /** The host downloaded it itself, so it can be deleted. */
  downloaded?: boolean;
  size?: number;
  /** An image model on a host: a confirmed recipe's name. */
  recipe?: string;
  /** "Not this model": kept out of the entry its name would put it in. */
  separate?: boolean;
}

/** Offerings from different endpoints declared the same model, in preferred order. */
export interface Group {
  id: string;
  name: string;
  shared: boolean;
  /** Offering IDs, in order. */
  members: string[];
}

export type Profiles = Partial<Record<Task, Entry>>;
export type Hub = "huggingface" | "modelscope";

/** One model in the text library, with its copies on every endpoint. */
export interface LibraryEntry {
  key: string;
  name: string;
  /** For a finetune, merge or adapter (or a copy flagged as maybe one): the model it derives from. */
  base?: { key: string; name: string };
  starred: boolean;
  groups: string[];
  copies: {
    offeringId: string; label: string;
    /** The file under the models folder, or the endpoint's model ID. */
    rawName: string;
    endpointId: string; endpointName: string; kind: "cloud" | "local"; shared: boolean;
    status: Offering["status"];
    /** Lyrica downloaded it, so it can be deleted. */
    downloaded: boolean;
    capabilities: Capabilities;
    groups: string[];
    flagged?: string;
    size?: number;
  }[];
}

/** Host management paths passed through (host/API.md). */
const MANAGE = [/^\/host\/v1\/models\/(load|unload|pin)$/, /^\/host\/v1\/gpus(\/\d+)?$/, /^\/host\/v1\/placements(\/[^/?#]+)?$/, /^\/host\/v1\/scan$/, /^\/host\/v1\/usage$/];

export interface CleanupItem {
  /** For a stale endpoint, its uses are those of all its models. */
  endpoint?: Endpoint;
  offering?: Offering;
  /** A group left with no members. */
  group?: Group;
  label: string;
  /** Where the asking user's own lists (and shared groups) use it. */
  usedIn: Use[];
  /** How many other users' lists name it (shared only). */
  otherUsers: number;
  /** The same model on another endpoint of the same kind, for Replace with… */
  suggestion?: { offeringId: string; label: string };
}

/** What a call needs from a model: tools, and room for the conversation. */
export interface Need { tools?: boolean; tokens?: number }

/** The model chosen for a call, and why earlier ones in the list were passed over. */
export interface Resolution {
  ref: { offeringId: string };
  endpoint: Endpoint;
  offering: Offering;
  label: string;
  profile: ProfileName;
  source: "thread" | "profile";
  /** Earlier models in the list that were skipped, with the reason. */
  skipped: { label: string; reason: string }[];
  /** Models after this one in the list that could still be tried. */
  remaining: number;
}

export interface CallRecord {
  at: string;
  pool: Pool;
  threadId: string;
  task: Task;
  offeringId: string;
  /** Kept with the ID, so history reads correctly after the model is gone. */
  label: string;
  endpointName: string;
  kind: "cloud" | "local";
  /** Why the first model in the list didn't answer, when it didn't. */
  fallback?: string;
  /** Such as a model that couldn't think at the level asked for. */
  note?: string;
}

/** Private and local-only threads may use local endpoints only. */
export const isRestricted = (ctx: Pick<CallContext, "pool" | "localOnly">): boolean => ctx.pool === "private" || ctx.localOnly;
/** Local for private and local-only threads, whatever else is set; otherwise the thread's (cloud by default). */
export const profileFor = (ctx: Pick<CallContext, "pool" | "localOnly" | "profile">): ProfileName => (isRestricted(ctx) ? "local" : ctx.profile ?? "cloud");

export function checkTask(task: string): Task {
  if (!(TASKS as readonly string[]).includes(task)) throw new Error(`unknown task ${task}; tasks are ${TASKS.join(", ")}`);
  return task as Task;
}

/** What a task needs: text models, embeddings, or images. `same` stays within one. */
const capability = (t: Task) => (t === "embedding" ? "embedding" : t === "image.create" ? "image" : t === "image.edit" ? "edit" : "text");
/** Tasks with no list of their own follow chat, except these. */
const OWN_LIST_ONLY: readonly Task[] = ["embedding", "image.create", "image.edit"];
/** A new profile starts with these following other tasks. */
const NEW_PROFILE: Partial<Record<Task, { same: Task }>> = {
  title: { same: "subagent.cheap" }, compaction: { same: "subagent.cheap" },
  "sleep.consolidate": { same: "subagent.strong" }, "sleep.dream": { same: "subagent.strong" }, "sleep.wake": { same: "subagent.strong" },
};

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
  const urls = ep.api === "host" ? (ep.addresses ?? []).map(hostOrigin) : [ep.baseUrl];
  const warnings: string[] = [];
  for (const url of urls) {
    const host = new URL(url).hostname;
    try {
      const outside = await addressesOutside(url);
      if (outside.length) warnings.push(`${host} resolves to ${outside.join(", ")}`);
    } catch {
      warnings.push(`${host} doesn't resolve`);
    }
  }
  return warnings.length ? `${ep.name} is declared local, but ${warnings.join(", and ")}, outside loopback, private and tailnet addresses` : undefined;
}

interface EndpointRow { id: string; name: string; kind: "cloud" | "local"; api: string; base_url: string; api_key: string | null; down_since: string | null; addresses: string | null; pin: string | null }
interface OfferingRow { id: string; endpoint: string; model: string; found: string; hand: string; manual: number; missing_since: string | null }
interface GroupRow { id: string; name: string; members: string }

const toEndpoint = (r: EndpointRow, shared: boolean, now = Date.now()): Endpoint => {
  const url = new URL(r.base_url);
  return {
    id: r.id, name: r.name, kind: r.kind, api: r.api === "host" ? "host" : "openai-compatible", baseUrl: r.base_url, shared,
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    ...(r.api === "host" ? { addresses: JSON.parse(r.addresses ?? "[]") as string[], fingerprint: r.pin ?? "" } : {}),
    unencrypted: r.kind === "local" && url.protocol === "http:" && !nearby(url.hostname),
    ...(r.down_since ? { downSince: r.down_since } : {}),
    stale: !!r.down_since && now - Date.parse(r.down_since) >= STALE_DAYS * DAY,
  };
};
const toOffering = (r: OfferingRow, now = Date.now()): Offering => {
  const caps: Capabilities & { digest?: string; identity?: ModelIdentity; downloaded?: boolean; size?: number; recipe?: string; separate?: boolean } = { ...JSON.parse(r.found), ...JSON.parse(r.hand) };
  const gone = !!r.missing_since && now - Date.parse(r.missing_since) >= GONE_DAYS * DAY;
  return {
    id: r.id, endpointId: r.endpoint, modelId: r.model, manual: r.manual === 1,
    ...Object.fromEntries(CAPABILITIES.filter((k) => caps[k] !== undefined).map((k) => [k, caps[k]])),
    status: gone ? "gone" : r.missing_since ? "missing" : "listed",
    ...(r.missing_since ? { missingSince: r.missing_since } : {}),
    ...(typeof caps.digest === "string" ? { digest: caps.digest } : {}),
    ...(caps.identity ? { identity: caps.identity } : {}),
    ...(caps.downloaded !== undefined ? { downloaded: caps.downloaded } : {}),
    ...(caps.size ? { size: caps.size } : {}),
    ...(caps.recipe ? { recipe: caps.recipe } : {}),
    ...(caps.separate ? { separate: true } : {}),
  };
};
const toGroup = (r: GroupRow, shared: boolean): Group => ({ id: r.id, name: r.name, shared, members: JSON.parse(r.members) });
const factsOf = (m: DiscoveredModel): Capabilities => {
  const { modelId: _m, ...caps } = m;
  return Object.fromEntries(Object.entries(caps).filter(([, v]) => v !== undefined));
};

/** Every endpoint, offering and group one user can see, read once. */
interface Catalog {
  endpoints: Map<string, Endpoint>;
  offerings: Map<string, Offering>;
  groups: Map<string, Group>;
}

/**
 * Endpoints, offerings, groups, profiles and the router. Shared endpoints
 * and groups live in self.db and change only with an administrator actor; a
 * user's own endpoints, groups, profiles and thread choices live in their
 * user.db, so the user must be unlocked. Opening a user's user.db first
 * applies any redirects they haven't applied yet, so their lists follow
 * replacements and removals made while they were locked.
 */
export class Models {
  private selfReady = false;
  /** Users whose user.db was migrated and indexed since this process started. */
  private readonly ready = new Set<string>();
  /** Endpoint ID → whether it answered lately, from probes and calls. */
  private readonly health = new Map<string, { up: boolean; at: number }>();
  /** Each host's pinned fetch, by endpoint, key and addresses. */
  private readonly fetches = new Map<string, typeof fetch>();
  /** Finished downloads already read as offerings, by host and download ID. */
  private readonly discovered = new Set<string>();

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
    if ((change.baseUrl !== undefined || change.apiKey !== undefined) && this.endpoint(actor.id, id)?.api === "host") throw new Error("a model host has addresses and a pinned key, not a URL or an API key");
    const baseUrl = change.baseUrl === undefined ? undefined : checkUrl(change.baseUrl);
    this.write(actor, id, (db) => {
      const current = db.prepare("SELECT * FROM endpoints WHERE id = ?").get(id) as EndpointRow;
      if (change.name !== undefined && change.name !== current.name && db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(change.name)) {
        throw new Error(`endpoint ${change.name} already exists`);
      }
      db.prepare("UPDATE endpoints SET name = ?, base_url = ?, api_key = ? WHERE id = ?").run(
        change.name ?? current.name, baseUrl ?? current.base_url, change.apiKey === undefined ? current.api_key : change.apiKey || null, id);
    });
    this.health.delete(id);
    return this.endpoint(actor.id, id)!;
  }

  /** Removes an endpoint. Each of its models leaves a tombstone, so lists that named them drop them. */
  removeEndpoint(actor: User, id: string): void {
    this.retire(actor, this.isShared(id), (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(id)) throw new Error(`no endpoint ${id}`);
      return (db.prepare("SELECT id FROM offerings WHERE endpoint = ?").all(id) as { id: string }[]).map((r) => [r.id, null]);
    }, (db) => { db.prepare("DELETE FROM endpoints WHERE id = ?").run(id); });
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
   * shared endpoints as `shared.<name>` so the two never collide. A group is
   * named by its name.
   */
  label(userId: string, id: string): string | undefined {
    const c = this.catalog(userId);
    const o = c.offerings.get(id);
    if (o) return labelOf(c.endpoints.get(o.endpointId)!, o);
    const g = c.groups.get(id);
    return g && `${g.shared ? SHARED : ""}${g.name}`;
  }

  /** Finds an offering by its ID or its label, or a group by its ID. */
  find(userId: string, idOrLabel: string): ModelRef | undefined {
    const c = this.catalog(userId);
    if (c.offerings.has(idOrLabel)) return { offeringId: idOrLabel };
    if (c.groups.has(idOrLabel)) return { groupId: idOrLabel };
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
    if (caps.reasoning?.some((l) => !THINKING_LEVELS.includes(l) || (l as string) === "off")) throw new Error("reasoning levels are low, medium and high");
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
      found = ep.api === "host" ? await this.hostModels(ep) : await discoverModels(ep.baseUrl, ep.apiKey);
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
  async probe(userId: string, endpointId: string, timeoutMs?: number): Promise<{ state: "up" | "down"; warning?: string }> {
    const ep = this.endpoint(userId, endpointId);
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    const [state, warning] = await Promise.all([
      ep.api === "host" ? this.hostUp(ep, timeoutMs) : probeUrl(ep.baseUrl, ep.apiKey, timeoutMs),
      ep.kind === "local" ? localWarning(ep) : undefined,
    ]);
    this.seen(ep, state === "up", userId);
    return warning ? { state, warning } : { state };
  }

  // --- The text model library ---

  /**
   * The text library: one entry per model with its copies on every endpoint,
   * the groups they're in, and whether the user starred it. Search matches
   * names and raw names; filters by kind, endpoint, capability, groups only.
   * Starred entries come first. Image recipes are in the image library.
   */
  textLibrary(userId: string, q: { search?: string; kind?: "cloud" | "local"; endpointId?: string; capability?: "tools" | "vision" | "embedding" | "image"; groupsOnly?: boolean; offset?: number; limit?: number } = {}): { total: number; entries: LibraryEntry[] } {
    const c = this.catalog(userId);
    const starred = this.withUser(userId, (db) => new Set((db.prepare("SELECT offering FROM starred_offerings").all() as { offering: string }[]).map((r) => r.offering)));
    const inGroups = new Map<string, string[]>();
    for (const g of c.groups.values()) for (const m of g.members) inGroups.set(m, [...(inGroups.get(m) ?? []), g.id]);
    const entries = new Map<string, LibraryEntry>();
    for (const o of c.offerings.values()) {
      if (o.recipe) continue;
      const ep = c.endpoints.get(o.endpointId)!;
      const id = copyIdentity(o);
      const e = entries.get(id.key) ?? { key: id.key, name: id.name, ...(id.base ? { base: id.base } : {}), starred: false, copies: [], groups: [] };
      e.copies.push({
        offeringId: o.id, label: labelOf(ep, o), rawName: o.modelId, endpointId: ep.id, endpointName: ep.name, kind: ep.kind, shared: ep.shared,
        status: o.status, downloaded: !!o.downloaded, capabilities: Object.fromEntries(CAPABILITIES.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Capabilities,
        groups: inGroups.get(o.id) ?? [], ...(id.flagged ? { flagged: id.flagged } : {}), ...(o.size ? { size: o.size } : {}),
      });
      for (const g of inGroups.get(o.id) ?? []) if (!e.groups.includes(g)) e.groups.push(g);
      if (starred.has(o.id)) e.starred = true;
      entries.set(id.key, e);
    }
    const needle = q.search?.toLowerCase().trim();
    const list = [...entries.values()].filter((e) => {
      if (needle && !e.name.includes(needle) && !e.copies.some((x) => x.rawName.toLowerCase().includes(needle) || x.label.toLowerCase().includes(needle))) return false;
      if (q.kind && !e.copies.some((x) => x.kind === q.kind)) return false;
      if (q.endpointId && !e.copies.some((x) => x.endpointId === q.endpointId)) return false;
      if (q.capability && !e.copies.some((x) => x.capabilities[q.capability!])) return false;
      if (q.groupsOnly && !e.groups.length) return false;
      return true;
    }).sort((a, b) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name));
    const offset = Math.max(0, q.offset ?? 0);
    return { total: list.length, entries: list.slice(offset, offset + Math.min(200, Math.max(1, q.limit ?? 50))) };
  }

  /** Stars (or unstars) a model for this user; pickers show starred models first. */
  star(userId: string, offeringId: string, on: boolean): void {
    if (!this.offering(userId, offeringId)) throw new NoModel(`no model ${offeringId}`);
    this.withUser(userId, (db) => {
      if (on) db.prepare("INSERT OR IGNORE INTO starred_offerings (offering) VALUES (?)").run(offeringId);
      else db.prepare("DELETE FROM starred_offerings WHERE offering = ?").run(offeringId);
    });
  }

  /**
   * "Not this model": moves a copy to an entry of its own (or back, with
   * false). An administrator decides for a shared endpoint, its owner for a
   * personal one.
   */
  notThisModel(actor: User, offeringId: string, separate = true): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    this.write(actor, o.endpoint.id, (db) => {
      const row = db.prepare("SELECT hand FROM offerings WHERE id = ?").get(offeringId) as { hand: string };
      const hand = JSON.parse(row.hand) as Record<string, unknown>;
      if (separate) hand.separate = true; else delete hand.separate;
      db.prepare("UPDATE offerings SET hand = ? WHERE id = ?").run(JSON.stringify(hand), offeringId);
    });
  }

  // --- Hub tokens ---

  /** The hub tokens this user can use, as the last four characters only: their own, and a shared one an administrator saved. */
  hubTokens(userId: string): { hub: Hub; shared: boolean; last4: string }[] {
    const read = (db: Db, shared: boolean) => (db.prepare("SELECT hub, token FROM hub_tokens ORDER BY hub").all() as { hub: Hub; token: string }[])
      .map((r) => ({ hub: r.hub, shared, last4: r.token.slice(-4) }));
    return [...this.withUser(userId, (db) => read(db, false)), ...read(this.self(), true)];
  }

  /** Saves or replaces a token for Hugging Face or ModelScope: the user's own, or (administrators) one shared with every user. */
  setHubToken(actor: User, hub: Hub, token: string, opts: { shared?: boolean } = {}): void {
    if (hub !== "huggingface" && hub !== "modelscope") throw new Error("tokens are for huggingface or modelscope");
    const t = String(token ?? "").trim();
    if (t.length < 8 || /\s/.test(t)) throw new Error("that doesn't look like an access token");
    this.place(actor, !!opts.shared, (db) => db.prepare("INSERT OR REPLACE INTO hub_tokens (hub, token) VALUES (?, ?)").run(hub, t));
  }

  removeHubToken(actor: User, hub: Hub, opts: { shared?: boolean } = {}): void {
    this.place(actor, !!opts.shared, (db) => db.prepare("DELETE FROM hub_tokens WHERE hub = ?").run(hub));
  }

  /** The token sent with a request to `hub`: the user's own, else the shared one. Never returned by the API. */
  private tokenFor(userId: string, hub: string): string | undefined {
    const sql = "SELECT token FROM hub_tokens WHERE hub = ?";
    return (this.withUser(userId, (db) => db.prepare(sql).get(hub)) as { token: string } | undefined)?.token
      ?? (this.self().prepare(sql).get(hub) as { token: string } | undefined)?.token;
  }

  // --- Downloads, deleting, and the image library, through a host's management API ---

  /** A repository's files on a host: which are there already and which are too big for its free space. */
  async hubFiles(actor: User, hostId: string, q: { source: Hub; repo: string; revision?: string }): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    const params = new URLSearchParams({ source: q.source, repo: q.repo, ...(q.revision ? { revision: q.revision } : {}) });
    return this.hostCall(ep, "GET", `/host/v1/hub/files?${params}`, undefined, this.hubHeader(actor.id, q.source));
  }

  /** Starts downloads on a host (host/API.md): files from a repository, or one https link. */
  async startDownload(actor: User, hostId: string, body: { source: Hub; repo: string; revision?: string; files: string[] } | { source: "url"; url: string; sha256?: string }): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    return this.hostCall(ep, "POST", "/host/v1/downloads", body, body.source === "url" ? undefined : this.hubHeader(actor.id, body.source));
  }

  /**
   * A host's downloads. A download that finished since the last look is read
   * as a new offering at once, and the group suggestions pick it up.
   */
  async downloads(actor: User, hostId: string): Promise<{ downloads: { id: string; state: string }[] }> {
    const ep = this.manageable(actor, hostId);
    const list = (await this.hostCall(ep, "GET", "/host/v1/downloads")) as { downloads?: { id: string; state: string }[] } | { id: string; state: string }[];
    const downloads = Array.isArray(list) ? list : list.downloads ?? [];
    const fresh = downloads.filter((d) => d.state === "done" && !this.discovered.has(`${hostId}/${d.id}`));
    if (fresh.length) {
      await this.discover(actor, hostId);
      for (const d of fresh) this.discovered.add(`${hostId}/${d.id}`);
    }
    return { downloads };
  }

  /** Cancels an unfinished download (its partial file goes), or clears a finished one from the list. */
  async cancelDownload(actor: User, hostId: string, downloadId: string): Promise<unknown> {
    return this.hostCall(this.manageable(actor, hostId), "DELETE", `/host/v1/downloads/${encodeURIComponent(downloadId)}`);
  }

  /**
   * Deletes a copy Lyrica downloaded, from its host. Without `confirm`, it
   * only says where the copy is used. Only files in the host's download
   * record go; anything else (a shared models folder) is refused. The
   * offering leaves a tombstone, so every list skips it.
   */
  async deleteCopy(actor: User, offeringId: string, opts: { confirm?: boolean } = {}): Promise<{ usedIn: Use[]; deleted?: string[] }> {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    const ep = this.manageable(actor, o.endpoint.id);
    const usedIn = [...(this.uses(actor.id).get(offeringId) ?? []), ...(collectRefs(this.self()).get(offeringId) ?? [])];
    if (!opts.confirm) return { usedIn };
    const record = (await this.hostCall(ep, "GET", "/host/v1/files")) as { path: string }[] | { files?: { path: string }[] };
    const files = (Array.isArray(record) ? record : record.files ?? []).map((f) => f.path)
      .filter((p) => p === o.offering.modelId || p.startsWith(`${o.offering.modelId}/`));
    if (!files.length) throw new HostRefused("refused", "Only files Lyrica downloaded can be deleted.");
    for (const path of files) await this.hostCall(ep, "DELETE", `/host/v1/files?${new URLSearchParams({ path })}`);
    this.removeOffering(actor, offeringId);
    return { usedIn, deleted: files };
  }

  /** A host's image library: its recipes (with proposals and missing parts) and its parts by role. */
  async imageLibrary(userId: string, hostId: string): Promise<{ recipes: unknown[]; parts: Record<string, unknown[]> }> {
    const ep = this.needHost(userId, hostId);
    const recipes = (await this.hostCall(ep, "GET", "/host/v1/recipes")) as unknown[];
    const parts = (await this.hostCall(ep, "GET", "/host/v1/parts")) as { role?: string }[];
    const byRole: Record<string, unknown[]> = {};
    for (const p of parts) (byRole[p.role ?? "unknown"] ??= []).push(p);
    return { recipes, parts: byRole };
  }

  /**
   * Changes a host's image library: confirm or ignore a proposal, download
   * its missing parts, change it (swap a part within its role and slot, add
   * or remove a LoRA, defaults, rename), copy it, or delete it, which keeps
   * every part another recipe uses. A shared host needs an administrator.
   * Confirmed recipes become image offerings at once.
   */
  async recipe(actor: User, hostId: string, recipeId: string, action: { do: "confirm" | "ignore" | "download-parts" | "delete" } | { do: "change"; change: Record<string, unknown> } | { do: "copy"; name: string }): Promise<unknown> {
    const ep = this.manageable(actor, hostId);
    const path = `/host/v1/recipes/${encodeURIComponent(recipeId)}`;
    const result = action.do === "delete" ? await this.hostCall(ep, "DELETE", path)
      : action.do === "change" ? await this.hostCall(ep, "PATCH", path, action.change)
        : action.do === "copy" ? await this.hostCall(ep, "POST", `${path}/copy`, { name: action.name })
          : await this.hostCall(ep, "POST", `${path}/${action.do}`);
    // A recipe deleted here leaves a tombstone, like a deleted copy, so lists skip it at once.
    const gone = action.do === "delete" ? this.offerings(actor.id, hostId).find((o) => o.modelId === `recipe/${recipeId}`) : undefined;
    if (gone) this.removeOffering(actor, gone.id);
    await this.discover(actor, hostId).catch(() => {});
    return result;
  }

  /**
   * Host management passed through as the host defines it: loading,
   * unloading and pinning models, GPU settings and placements, scanning.
   * Only these paths; a shared host needs an administrator.
   */
  async manageHost(actor: User, hostId: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    if (!MANAGE.some((re) => re.test(path))) throw new Error(`${path} isn't host management Lyrica passes on`);
    return this.hostCall(this.manageable(actor, hostId), method, path, body);
  }

  /** A host's dashboard, opened directly (it has its own password away from the machine). */
  hostDashboard(userId: string, hostId: string): string {
    return `${hostOrigin(this.needHost(userId, hostId).addresses![0]!)}/`;
  }

  /** A host the actor may manage: any they can see, but a shared one only as an administrator. */
  private manageable(actor: User, hostId: string): Endpoint {
    const ep = this.needHost(actor.id, hostId);
    if (ep.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can manage a shared model host");
    return ep;
  }

  private hubHeader(userId: string, hub: string): Record<string, string> | undefined {
    const token = this.tokenFor(userId, hub);
    return token ? { "x-hub-token": token } : undefined;
  }

  // --- How it answers ---

  /**
   * An offering's settings for one user, with where each comes from: the
   * shared offering's values (self.db), then the user's own (user.db), which
   * win. Unset values are absent and never sent. Also its context window and
   * where that comes from.
   */
  offeringSettings(userId: string, offeringId: string): {
    values: AnswerSettings; sources: Partial<Record<keyof AnswerSettings, SettingSource>>;
    contextWindow?: { value: number; source: "hand" | "discovered" };
  } {
    const o = this.offering(userId, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    const read = (db: Db) => {
      const row = db.prepare("SELECT settings FROM offering_settings WHERE offering = ?").get(offeringId) as { settings: string } | undefined;
      return row ? (JSON.parse(row.settings) as AnswerSettings) : {};
    };
    const shared = o.endpoint.shared ? read(this.self()) : {};
    const yours = this.withUser(userId, read);
    const values: AnswerSettings = { ...shared, ...yours };
    const sources = Object.fromEntries(ANSWER_SETTINGS.filter((k) => values[k] !== undefined).map((k) => [k, k in yours ? "yours" : "shared"]));
    const db = o.endpoint.shared ? this.self() : undefined;
    const raw = (db ? db.prepare("SELECT found, hand FROM offerings WHERE id = ?").get(offeringId)
      : this.withUser(userId, (u) => u.prepare("SELECT found, hand FROM offerings WHERE id = ?").get(offeringId))) as { found: string; hand: string };
    const hand = JSON.parse(raw.hand).contextWindow as number | undefined;
    const found = JSON.parse(raw.found).contextWindow as number | undefined;
    return {
      values, sources,
      ...(hand ? { contextWindow: { value: hand, source: "hand" as const } } : found ? { contextWindow: { value: found, source: "discovered" as const } } : {}),
    };
  }

  /**
   * Saves settings for an offering. `shared` sets a shared offering's values
   * for everyone (administrators only); `mine` sets the user's own: for their
   * offering, or over a shared one's for them alone. null clears a value.
   */
  setOfferingSettings(actor: User, offeringId: string, change: Record<string, unknown>, scope: "shared" | "mine" = "mine"): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    const checked = checkSettings(change);
    if (scope === "shared" && !o.endpoint.shared) throw new Error("only a shared model has shared settings");
    if (scope === "shared" && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change a shared model's settings");
    const apply = (db: Db) => {
      const row = db.prepare("SELECT settings FROM offering_settings WHERE offering = ?").get(offeringId) as { settings: string } | undefined;
      const next: Record<string, unknown> = row ? JSON.parse(row.settings) : {};
      for (const [k, v] of Object.entries(checked)) if (v === null) delete next[k]; else next[k] = v;
      if (Object.keys(next).length) db.prepare("INSERT OR REPLACE INTO offering_settings (offering, settings) VALUES (?, ?)").run(offeringId, JSON.stringify(next));
      else db.prepare("DELETE FROM offering_settings WHERE offering = ?").run(offeringId);
    };
    if (scope === "shared") apply(this.self()); else this.withUser(actor.id, apply);
  }

  // --- Model hosts ---

  /**
   * Pairs a model host (host/PAIRING.md) from its addresses and the code its
   * dashboard shows, and pins its key. Hosts are always local. A shared host
   * needs an administrator; a personal one is visible to its user only.
   * With `endpointId`, pairs an existing host again (its key changed),
   * keeping every ID.
   */
  async pairHost(actor: User, input: { name: string; addresses: string[]; code: string }, opts: { shared?: boolean; endpointId?: string } = {}): Promise<Endpoint> {
    checkName(input.name);
    const addresses = checkAddresses(input.addresses);
    const existing = opts.endpointId ? this.endpoint(actor.id, opts.endpointId) : undefined;
    if (opts.endpointId && existing?.api !== "host") throw new Error(`no model host ${opts.endpointId}`);
    const shared = existing ? existing.shared : !!opts.shared;
    if (shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can pair a shared model host");
    const paired = await pair(lyricaIdentity(this.self()), addresses, input.code, `Lyrica (${input.name})`);
    const baseUrl = `${hostOrigin(addresses[0]!)}/v1`;
    const id = existing?.id ?? randomUUID();
    this.place(actor, shared, (db) => {
      if (existing) {
        db.prepare("UPDATE endpoints SET addresses = ?, pin = ?, base_url = ?, down_since = NULL WHERE id = ?").run(JSON.stringify(addresses), paired.fingerprint, baseUrl, id);
        return;
      }
      if (db.prepare("SELECT 1 FROM endpoints WHERE name = ?").get(input.name)) throw new Error(`endpoint ${input.name} already exists`);
      db.prepare("INSERT INTO endpoints (id, name, kind, api, base_url, api_key, created_at, addresses, pin) VALUES (?, ?, 'local', 'host', ?, NULL, ?, ?, ?)")
        .run(id, input.name, baseUrl, new Date().toISOString(), JSON.stringify(addresses), paired.fingerprint);
    });
    this.health.delete(id);
    return this.endpoint(actor.id, id)!;
  }

  /** Changes a host's addresses. Trust stays with its key, and its IDs stay as they are. */
  setHostAddresses(actor: User, id: string, addresses: string[]): Endpoint {
    const list = checkAddresses(addresses);
    this.write(actor, id, (db) => {
      if ((db.prepare("SELECT api FROM endpoints WHERE id = ?").get(id) as { api: string }).api !== "host") throw new Error("only a model host has addresses");
      db.prepare("UPDATE endpoints SET addresses = ?, base_url = ? WHERE id = ?").run(JSON.stringify(list), `${hostOrigin(list[0]!)}/v1`, id);
    });
    this.health.delete(id);
    return this.endpoint(actor.id, id)!;
  }

  /** The fetch that reaches a host over mutual TLS with its pinned key; undefined for a plain endpoint. */
  fetchFor(ep: Endpoint): typeof fetch | undefined {
    if (ep.api !== "host") return undefined;
    const key = `${ep.id}\u0000${ep.fingerprint}\u0000${(ep.addresses ?? []).join(",")}`;
    let f = this.fetches.get(key);
    if (!f) {
      f = hostFetch(lyricaIdentity(this.self()), { addresses: ep.addresses ?? [], pin: ep.fingerprint ?? "" }, () => this.reportDown(ep.id));
      this.fetches.set(key, f);
    }
    return f;
  }

  /** A host's status (host/API.md): GPUs, roles, loaded and pinned models, VRAM, queue. Anyone who can use the host may read it. */
  async hostStatus(userId: string, id: string): Promise<unknown> {
    return this.hostCall(this.needHost(userId, id), "GET", "/host/v1/status");
  }

  /** Pauses, resumes or restarts a host. A shared host needs an administrator. */
  async hostControl(actor: User, id: string, action: "pause" | "resume" | "restart"): Promise<unknown> {
    const ep = this.needHost(actor.id, id);
    if (ep.shared && !this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can manage a shared model host");
    if (!["pause", "resume", "restart"].includes(action)) throw new Error("a host can be paused, resumed or restarted");
    const status = await this.hostCall(ep, "POST", `/host/v1/${action}`);
    if (action === "pause") this.reportDown(ep.id); else this.health.delete(ep.id);
    return status;
  }

  private needHost(userId: string, id: string): Endpoint {
    const ep = this.endpoint(userId, id);
    if (!ep || ep.api !== "host") throw new NoModel(`no model host ${id}`);
    return ep;
  }

  /** One call to a host's API, with its error as a plain reason. */
  private async hostCall(ep: Endpoint, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<unknown> {
    const res = await this.fetchFor(ep)!(`${hostOrigin(ep.addresses![0]!)}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const err = await hostError(res);
    if (err) throw new HostRefused(err.code, err.message);
    if (!res.ok) throw new HostRefused("error", `${ep.name} answered ${res.status}`);
    return res.json();
  }

  /** Up when the host answers its status and is running; paused, pausing and restarting count as down. */
  private async hostUp(ep: Endpoint, timeoutMs = 5000): Promise<"up" | "down"> {
    try {
      const res = await this.fetchFor(ep)!(`${hostOrigin(ep.addresses![0]!)}/host/v1/status`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return "down";
      return ((await res.json()) as { state?: string }).state === "running" ? "up" : "down";
    } catch {
      return "down";
    }
  }

  /** A host's text models, from its library (host/API.md "Models"). */
  private async hostModels(ep: Endpoint): Promise<DiscoveredModel[]> {
    const list = (await this.hostCall(ep, "GET", "/host/v1/models")) as {
      id: string; kind?: string; sha256?: string | null; contextLength?: number | null; size?: number; downloaded?: boolean; identity?: ModelIdentity | null;
      capabilities?: { tools?: boolean; vision?: boolean; embedding?: boolean; reasoning?: string[] | null };
    }[];
    if (!Array.isArray(list)) throw new Error(`${ep.name} didn't return a model list`);
    // Image models are recipes: only confirmed ones become offerings, so a proposal never resolves.
    const recipes = ((await this.hostCall(ep, "GET", "/host/v1/recipes?state=confirmed").catch(() => [])) as { id: string; name: string; state: string; does?: string[] }[])
      .filter((r) => r?.state === "confirmed").map((r) => ({
        modelId: `recipe/${r.id}`, recipe: r.name, ...(r.does?.includes("create") ? { image: true } : {}), ...(r.does?.includes("edit") ? { edit: true } : {}),
      } as DiscoveredModel));
    return [...list.filter((m) => typeof m?.id === "string" && m.kind !== "image").map((m) => {
      const levels = (m.capabilities?.reasoning ?? []).filter((l) => l !== "off");
      // A thinking switch in the chat template is on or off: one level.
      const reasoning = levels.filter((l): l is "low" | "medium" | "high" => ["low", "medium", "high"].includes(l));
      return {
        modelId: m.id,
        ...(m.contextLength ? { contextWindow: m.contextLength } : {}),
        ...(m.capabilities?.tools !== undefined ? { tools: !!m.capabilities.tools } : {}),
        ...(m.capabilities?.vision !== undefined ? { vision: !!m.capabilities.vision } : {}),
        ...(m.capabilities?.embedding || m.kind === "embedding" ? { embedding: true } : {}),
        ...(levels.length ? { reasoning: reasoning.length ? reasoning : ["medium"] as "medium"[] } : {}),
        ...(m.sha256 ? { digest: m.sha256 } : {}),
        ...(m.identity ? { identity: m.identity } : {}),
        ...(m.downloaded !== undefined ? { downloaded: !!m.downloaded } : {}),
        ...(m.size ? { size: m.size } : {}),
      } as DiscoveredModel;
    }), ...recipes];
  }

  /** A call to the endpoint failed to connect or was refused as away: the router skips it for HEALTH_MS. */
  reportDown(endpointId: string): void {
    this.health.set(endpointId, { up: false, at: Date.now() });
  }

  /** Other offerings of the same model, by name, on endpoints of the same kind: suggested fallbacks and replacements. */
  sameModel(userId: string, offeringId: string): { offeringId: string }[] {
    const c = this.catalog(userId);
    const o = c.offerings.get(offeringId);
    if (!o) return [];
    const kind = c.endpoints.get(o.endpointId)!.kind;
    const name = baseName(o.modelId);
    return [...c.offerings.values()]
      .filter((x) => x.id !== o.id && x.endpointId !== o.endpointId && x.status !== "gone" && c.endpoints.get(x.endpointId)!.kind === kind && !c.endpoints.get(x.endpointId)!.stale && baseName(x.modelId) === name)
      .map((x) => ({ offeringId: x.id }));
  }

  // --- Groups ---

  /** The user's own groups, then the shared ones. */
  groups(userId: string): Group[] {
    return [...this.catalog(userId).groups.values()];
  }

  group(userId: string, id: string): Group | undefined {
    return this.catalog(userId).groups.get(id);
  }

  /**
   * Declares offerings from different endpoints the same model, in order.
   * A shared group (administrators only) takes shared offerings only.
   */
  addGroup(actor: User, input: { name: string; members: string[] }, opts: { shared?: boolean } = {}): Group {
    const members = this.checkMembers(actor.id, input.members, !!opts.shared);
    const name = checkGroupName(input.name);
    const id = randomUUID();
    this.place(actor, !!opts.shared, (db) => {
      db.prepare("INSERT INTO model_groups (id, name, members, created_at) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(members), new Date().toISOString());
    });
    if (!opts.shared) this.withUser(actor.id, (db) => this.index(actor.id, db));
    return this.group(actor.id, id)!;
  }

  /** Renames a group, or reorders, adds or removes its members. */
  editGroup(actor: User, id: string, change: { name?: string; members?: string[] }): Group {
    const g = this.group(actor.id, id);
    if (!g) throw new NoModel(`no group ${id}`);
    const members = change.members && this.checkMembers(actor.id, change.members, g.shared);
    const name = change.name === undefined ? g.name : checkGroupName(change.name);
    this.place(actor, g.shared, (db) => {
      db.prepare("UPDATE model_groups SET name = ?, members = ? WHERE id = ?").run(name, JSON.stringify(members ?? g.members), id);
    });
    if (!g.shared) this.withUser(actor.id, (db) => this.index(actor.id, db));
    return this.group(actor.id, id)!;
  }

  /** Undoes a group. Lists that named it drop it, through a tombstone like a removed model. */
  removeGroup(actor: User, id: string): void {
    const g = this.group(actor.id, id);
    if (!g) throw new NoModel(`no group ${id}`);
    this.retire(actor, g.shared, () => [[id, null]], (db) => { db.prepare("DELETE FROM model_groups WHERE id = ?").run(id); });
  }

  /**
   * A group's members side by side, with warnings where they differ in a way
   * that matters: kind, context window, tools, vision, thinking, or a member
   * that is missing, gone or on a stale endpoint.
   */
  groupDetail(userId: string, id: string): { group: Group; members: (Offering & { label: string; kind: "cloud" | "local"; stale: boolean })[]; warnings: string[] } {
    const c = this.catalog(userId);
    const group = c.groups.get(id);
    if (!group) throw new NoModel(`no group ${id}`);
    const members = group.members.flatMap((m) => {
      const o = c.offerings.get(m);
      if (!o) return [];
      const ep = c.endpoints.get(o.endpointId)!;
      return [{ ...o, label: labelOf(ep, o), kind: ep.kind, stale: ep.stale }];
    });
    const warnings: string[] = [];
    const differ = (what: string, f: (m: (typeof members)[number]) => unknown) => {
      if (new Set(members.map((m) => JSON.stringify(f(m) ?? null))).size > 1) warnings.push(`Its copies differ in ${what}.`);
    };
    if (new Set(members.map((m) => m.kind)).size > 1) warnings.push("It mixes local and cloud copies, so as a whole it can only be used in the Custom profile; elsewhere only the copies of the right kind are used.");
    differ("context window", (m) => m.contextWindow);
    differ("tool support", (m) => m.tools);
    differ("vision", (m) => m.vision);
    differ("thinking", (m) => m.reasoning);
    for (const m of members) {
      if (m.status !== "listed") warnings.push(`${m.label} is ${m.status}.`);
      if (m.stale) warnings.push(`${m.label}'s endpoint hasn't answered for ${STALE_DAYS} days.`);
    }
    if (!members.length) warnings.push("It has no members left.");
    return { group, members, warnings };
  }

  /**
   * Suggested groups, never made automatically: copies on different
   * endpoints of the same kind with the same file checksum (strong) or the
   * same name (weak), not already grouped together.
   */
  groupSuggestions(userId: string): { name: string; members: string[]; strength: "strong" | "weak" }[] {
    const c = this.catalog(userId);
    const live = [...c.offerings.values()].filter((o) => o.status !== "gone" && !c.endpoints.get(o.endpointId)!.stale);
    const out: { name: string; members: string[]; strength: "strong" | "weak" }[] = [];
    const covered = (ids: string[]) => [...c.groups.values()].some((g) => ids.every((id) => g.members.includes(id)));
    const bucket = (key: (o: Offering) => string | undefined, strength: "strong" | "weak") => {
      const by = new Map<string, Offering[]>();
      for (const o of live) {
        const k = key(o);
        if (!k) continue;
        const b = `${c.endpoints.get(o.endpointId)!.kind}\u0000${k}`;
        by.set(b, [...(by.get(b) ?? []), o]);
      }
      for (const list of by.values()) {
        // One copy per endpoint: the first.
        const one = list.filter((o, i) => list.findIndex((x) => x.endpointId === o.endpointId) === i);
        const ids = one.map((o) => o.id);
        if (one.length > 1 && !covered(ids) && !out.some((s) => ids.every((id) => s.members.includes(id)))) out.push({ name: baseName(one[0]!.modelId), members: ids, strength });
      }
    };
    bucket((o) => o.digest, "strong");
    // Same entry in the library, never a flagged or separated copy: a finetune is never suggested for its base's group.
    bucket((o) => { const id = copyIdentity(o); return id.flagged || id.key.startsWith("copy:") ? undefined : id.key; }, "weak");
    return out;
  }

  // --- Clean up, redirects and tombstones ---

  /**
   * Stale endpoints, gone models and empty groups this user can see, with
   * where their own lists (and shared groups) use them and how many other
   * users' lists do.
   */
  cleanup(userId: string): CleanupItem[] {
    const c = this.catalog(userId);
    const uses = this.uses(userId);
    for (const [id, list] of collectRefs(this.self())) uses.set(id, [...(uses.get(id) ?? []), ...list]);
    const others = (ids: string[]) => {
      const shared = ids.filter((id) => c.endpoints.get(c.offerings.get(id)?.endpointId ?? "")?.shared || c.groups.get(id)?.shared);
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
        ...(same ? { suggestion: { offeringId: same.offeringId, label: this.label(userId, same.offeringId)! } } : {}),
      });
    }
    for (const group of c.groups.values()) {
      if (group.members.length) continue;
      items.push({ group, label: this.label(userId, group.id)!, usedIn: uses.get(group.id) ?? [], otherUsers: others([group.id]) });
    }
    return items;
  }

  /**
   * Replaces a model everywhere: it is deleted, and a redirect sends every
   * list and group that named it to the replacement. The replacement must be
   * of the same kind, and for a shared model, shared too.
   */
  replace(actor: User, fromId: string, toId: string): void {
    const from = this.offering(actor.id, fromId);
    const to = this.offering(actor.id, toId);
    if (!from) throw new NoModel(`no model ${fromId}`);
    if (!to) throw new NoModel(`no model ${toId}`);
    if (fromId === toId) throw new Error("a model can't replace itself");
    if (from.endpoint.kind !== to.endpoint.kind) throw new CloudModelForbidden(`a ${from.endpoint.kind} model can only be replaced by another ${from.endpoint.kind} model`);
    if (from.endpoint.shared && !to.endpoint.shared) throw new Error("a shared model can only be replaced by another shared model");
    this.retire(actor, from.endpoint.shared, () => [[fromId, toId]], (db) => { db.prepare("DELETE FROM offerings WHERE id = ?").run(fromId); });
  }

  /** Removes a model. A tombstone makes every list and group that named it drop it. */
  removeOffering(actor: User, offeringId: string): void {
    const o = this.offering(actor.id, offeringId);
    if (!o) throw new NoModel(`no model ${offeringId}`);
    this.retire(actor, o.endpoint.shared, () => [[offeringId, null]], (db) => { db.prepare("DELETE FROM offerings WHERE id = ?").run(offeringId); });
  }

  /** Gives an endpoint and its models fresh IDs, for a server to be treated as new. Redirects keep every list working. */
  resetIds(actor: User, endpointId: string): string {
    const fresh = randomUUID();
    const map = new Map<string, string>();
    this.retire(actor, this.isShared(endpointId), (db) => {
      if (!db.prepare("SELECT 1 FROM endpoints WHERE id = ?").get(endpointId)) throw new Error(`no endpoint ${endpointId}`);
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
    this.retire(actor, from.shared, (db) => {
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
   * shared model that means no user's lists and no shared group name it,
   * which needs every user to have been indexed; a user's own gone models go
   * while they are unlocked. Old call records are trimmed too.
   */
  prune(now = Date.now()): void {
    const self = this.self();
    const gone = (db: Db) => (db.prepare("SELECT * FROM offerings WHERE missing_since IS NOT NULL").all() as OfferingRow[]).filter((r) => toOffering(r, now).status === "gone");
    const allIndexed = this.users.all().every((u) => self.prepare("SELECT 1 FROM shared_refs_indexed WHERE user = ?").get(u.id));
    self.prepare("DELETE FROM offering_settings WHERE offering NOT IN (SELECT id FROM offerings)").run();
    const sharedIds = new Set((self.prepare("SELECT id FROM offerings").all() as { id: string }[]).map((r) => r.id));
    if (allIndexed) {
      const inGroups = collectRefs(self);
      for (const r of gone(self)) if (!inGroups.has(r.id) && !self.prepare("SELECT 1 FROM shared_refs WHERE ref = ?").get(r.id)) self.prepare("DELETE FROM offerings WHERE id = ?").run(r.id);
    }
    for (const u of this.users.all()) {
      if (!this.keyring.hasUserKey(u.id)) continue;
      this.withUser(u.id, (db) => {
        for (const r of db.prepare("SELECT offering FROM offering_settings WHERE offering NOT IN (SELECT id FROM offerings)").all() as { offering: string }[]) {
          if (!sharedIds.has(r.offering)) db.prepare("DELETE FROM offering_settings WHERE offering = ?").run(r.offering);
        }
        const used = collectRefs(db);
        for (const r of gone(db)) if (!used.has(r.id)) db.prepare("DELETE FROM offerings WHERE id = ?").run(r.id);
        db.prepare("DELETE FROM model_calls WHERE id <= (SELECT max(id) FROM model_calls) - ?").run(CALLS_KEPT);
      });
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

  /** A profile's entries: an ordered list per task, or `{ same }` for a task that uses another task's list. */
  profile(userId: string, name: ProfileName): Profiles {
    const rows = this.withUser(userId, (db) => db.prepare("SELECT task, entry FROM model_profiles WHERE profile = ?").all(name)) as { task: Task; entry: string }[];
    return Object.fromEntries(rows.map((r) => [r.task, JSON.parse(r.entry) as Entry]));
  }

  /**
   * Sets (or with no entry, clears) a profile's entry for a task. The local
   * profile takes local models only and the cloud profile cloud models only
   * (a group needs at least one member of the right kind); Custom takes both.
   * `same` names a task of the same capability that doesn't itself follow
   * another. A profile's first entry brings the defaults: titles and
   * compaction follow cheap subagents, and sleep follows strong subagents.
   * A single model is a one-model list.
   */
  setProfile(userId: string, name: ProfileName, task: Task, value?: Entry | ModelRef): void {
    if (name !== "cloud" && name !== "local" && name !== "custom") throw new Error("the profiles are local, cloud and custom");
    const entry: Entry | undefined = value && !Array.isArray(value) && !("same" in value) ? [value] : value as Entry | undefined;
    const current = this.profile(userId, name);
    let stored: Entry | undefined = entry;
    if (entry && !isList(entry)) {
      const target = checkTask(entry.same);
      if (target === task) throw new Error(`${task} can't follow itself`);
      if (capability(target) !== capability(task)) throw new Error(`${task} can only follow a task that uses the same kind of model`);
      const t = current[target];
      if (t && !isList(t)) throw new Error(`${target} already follows ${t.same}, and Same as goes one level deep`);
      stored = { same: target };
    } else if (entry) {
      stored = this.checkList(userId, entry, { kind: name === "custom" ? undefined : name, task });
    }
    if (stored && isList(stored) && !stored.length) stored = undefined;
    const followers = Object.entries(current).filter(([, e]) => e && !isList(e) && e.same === task).map(([t]) => t);
    if (stored && !isList(stored) && followers.length) throw new Error(`${followers.join(" and ")} already follow ${task}, and Same as goes one level deep`);
    this.withUser(userId, (db) => {
      if (!db.prepare("SELECT 1 FROM model_profiles WHERE profile = ?").get(name)) {
        const fresh = db.prepare("INSERT OR IGNORE INTO model_profiles (profile, task, entry) VALUES (?, ?, ?)");
        for (const [t, e] of Object.entries(NEW_PROFILE)) if (t !== task) fresh.run(name, t, JSON.stringify(e));
      }
      if (!stored) db.prepare("DELETE FROM model_profiles WHERE profile = ? AND task = ?").run(name, task);
      else db.prepare("INSERT OR REPLACE INTO model_profiles (profile, task, entry) VALUES (?, ?, ?)").run(name, task, JSON.stringify(stored));
      this.index(userId, db);
    });
  }

  /** Which profile general threads use unless they choose: cloud (the default) or custom. */
  defaultProfile(userId: string): "cloud" | "custom" {
    return this.setting(userId, "general_profile") === "custom" ? "custom" : "cloud";
  }

  setDefaultProfile(userId: string, profile: "cloud" | "custom"): void {
    if (profile !== "cloud" && profile !== "custom") throw new Error("general threads use the cloud or the custom profile");
    this.setSetting(userId, "general_profile", profile);
  }

  /** The thinking level threads use unless they choose. Off by default. */
  defaultThinking(userId: string): ThinkingLevel {
    const v = this.setting(userId, "thinking") as ThinkingLevel | undefined;
    return v && THINKING_LEVELS.includes(v) ? v : "off";
  }

  setDefaultThinking(userId: string, level: ThinkingLevel): void {
    this.setSetting(userId, "thinking", checkThinking(level));
  }

  /** Sets (or clears) one thread's ordered list for a task. A private or local-only thread takes local models only. */
  setThreadModel(userId: string, pool: Pool, threadId: string, task: Task, list?: ModelRef[] | ModelRef): void {
    const refs = list === undefined ? undefined : Array.isArray(list) ? list : [list];
    const stored = refs?.length ? this.checkThreadList(this.callContext(userId, pool, threadId), task, refs) : undefined;
    this.withUser(userId, (db) => {
      if (!stored) db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ? AND task = ?").run(pool, threadId, task);
      else db.prepare("INSERT OR REPLACE INTO thread_models (pool, thread, task, entry) VALUES (?, ?, ?, ?)").run(pool, threadId, task, JSON.stringify(stored));
      this.index(userId, db);
    });
  }

  /**
   * Checks a thread's list for a task against the thread's context, without
   * saving it: local models only in a private or local-only thread, and one
   * kind only unless the thread uses the custom profile.
   */
  checkThreadList(ctx: CallContext, task: Task, list: ModelRef[]): ModelRef[] {
    const p = profileFor(ctx);
    return this.checkList(ctx.userId, list, { kind: isRestricted(ctx) ? "local" : p === "custom" ? undefined : "single", task });
  }

  /** Switches a general thread to the cloud or custom profile, or back to the user's default. Private threads always use local. */
  setThreadProfile(userId: string, pool: Pool, threadId: string, profile: "cloud" | "custom" | null): void {
    if (pool === "private" && profile) throw new CloudModelForbidden("a private thread always uses the local profile");
    if (profile !== null && profile !== "cloud" && profile !== "custom") throw new Error("a thread uses the cloud or the custom profile");
    this.threadChoice(userId, threadId, "profile", profile);
  }

  /** The profile a thread chose, if it chose one rather than following the user's default. */
  threadProfile(userId: string, threadId: string): "cloud" | "custom" | null {
    const v = this.withUser(userId, (db) => (db.prepare("SELECT profile FROM thread_choices WHERE thread = ?").get(threadId) as { profile: string | null } | undefined)?.profile);
    return v === "cloud" || v === "custom" ? v : null;
  }

  /** Sets (or with null, clears) a thread's thinking level. */
  setThinking(userId: string, threadId: string, level: ThinkingLevel | null): void {
    this.threadChoice(userId, threadId, "thinking", level === null ? null : checkThinking(level));
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

  /** A forgotten thread's model choices and call records go with it. */
  forgetThread(userId: string, pool: Pool, threadId: string): void {
    this.withUser(userId, (db) => db.transaction(() => {
      db.prepare("DELETE FROM thread_models WHERE pool = ? AND thread = ?").run(pool, threadId);
      db.prepare("DELETE FROM model_calls WHERE pool = ? AND thread = ?").run(pool, threadId);
      db.prepare("DELETE FROM thread_choices WHERE thread = ?").run(threadId);
      db.prepare("DELETE FROM local_only_threads WHERE thread = ?").run(threadId);
      this.index(userId, db);
    })());
  }

  /** The thread's CallContext: its local-only switch, profile, thinking level and model overrides. */
  callContext(userId: string, pool: Pool, threadId: string): CallContext {
    return this.withUser(userId, (db) => {
      const rows = db.prepare("SELECT task, entry FROM thread_models WHERE pool = ? AND thread = ?").all(pool, threadId) as { task: Task; entry: string }[];
      const localOnly = pool === "private" || !!db.prepare("SELECT 1 FROM local_only_threads WHERE thread = ?").get(threadId);
      const choice = db.prepare("SELECT profile, thinking FROM thread_choices WHERE thread = ?").get(threadId) as { profile: string | null; thinking: string | null } | undefined;
      const setting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
      const profile = (choice?.profile ?? setting("general_profile")) === "custom" ? "custom" : "cloud";
      const thinking = (choice?.thinking ?? setting("thinking") ?? "off") as ThinkingLevel;
      return {
        userId, pool, localOnly, ...(pool === "general" ? { profile } : {}), thinking: THINKING_LEVELS.includes(thinking) ? thinking : "off",
        overrides: Object.fromEntries(rows.map((r) => [r.task, JSON.parse(r.entry) as ModelRef[]])),
      };
    });
  }

  /**
   * The CallContext for a child thread, such as a subagent's. It keeps the
   * parent's local-only switch, profile and model choices, and its chat list
   * is the parent's `subagent.<tier>` list, or a named model the parent's
   * context allows. Throws CloudModelForbidden or NoModel before changing anything.
   */
  childContext(parent: CallContext, childThreadId: string, pick: { tier: "cheap" | "strong" } | { model: ModelRef }): CallContext {
    let chat: ModelRef[];
    if ("tier" in pick) {
      this.resolve(`subagent.${pick.tier}`, parent);
      chat = this.listFor(`subagent.${pick.tier}`, parent)!.list;
    } else {
      this.check(parent.userId, pick.model, isRestricted(parent));
      chat = [pick.model];
    }
    const { userId, pool } = parent;
    if (parent.localOnly) this.setLocalOnly(userId, pool, childThreadId, true);
    if (pool === "general" && parent.profile) this.setThreadProfile(userId, pool, childThreadId, parent.profile);
    if (parent.thinking) this.setThinking(userId, childThreadId, parent.thinking);
    for (const [task, r] of Object.entries(parent.overrides ?? {})) if (task !== "chat") this.setThreadModel(userId, pool, childThreadId, task as Task, r);
    this.setThreadModel(userId, pool, childThreadId, "chat", chat);
    return this.callContext(userId, pool, childThreadId);
  }

  // --- The router ---

  /** The model for a task, as `resolve` chooses it. */
  resolveModel(task: Task, ctx: CallContext, need: Need = {}): { offeringId: string } {
    return this.resolve(task, ctx, need).ref;
  }

  /**
   * The model for a task: the first usable one in the thread's list for it,
   * else the profile's (local for private and local-only threads; otherwise
   * the thread's, cloud or custom), following `same` one level. A task with
   * neither uses the chat list, except embeddings and images.
   *
   * Groups expand in place into their members. Redirects are followed, and a
   * removed model counts as not there. A model is skipped when it is gone,
   * its endpoint is stale or known to be down, or it can't handle the call
   * (tools, context window, images). Outside Custom, the first usable model
   * fixes the kind, so a fallback never crosses the local/cloud line. In a
   * private or local-only context, a group's cloud members are skipped and a
   * cloud model named directly throws CloudModelForbidden.
   */
  resolve(task: Task, ctx: CallContext, need: Need = {}): Resolution {
    const c = this.catalog(ctx.userId);
    const profile = profileFor(ctx);
    const found = this.listFor(task, ctx, c);
    if (!found) throw new NoModel(`no model is set for ${task} in the ${profile} profile`);
    const restricted = isRestricted(ctx);
    const fixKind = profile !== "custom";
    const candidates: { id: string; grouped: boolean }[] = [];
    for (const ref of found.list) {
      if ("offeringId" in ref) candidates.push({ id: ref.offeringId, grouped: false });
      else for (const m of c.groups.get(ref.groupId)?.members ?? []) { const id = this.follow(m); if (id) candidates.push({ id, grouped: true }); }
    }
    const seen = new Set<string>();
    const unique = candidates.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
    // Outside Custom a list keeps to one kind: local where restricted, cloud in the cloud profile, else its first model's.
    const firstKind = unique.map((x) => c.endpoints.get(c.offerings.get(x.id)?.endpointId ?? "")?.kind).find(Boolean);
    const kind = restricted ? "local" : !fixKind ? undefined : found.source === "profile" ? "cloud" : firstKind;
    const skipped: { label: string; reason: string }[] = [];
    for (let i = 0; i < unique.length; i++) {
      const { id, grouped } = unique[i]!;
      const o = c.offerings.get(id);
      if (!o) { skipped.push({ label: id, reason: "it no longer exists" }); continue; }
      const ep = c.endpoints.get(o.endpointId)!;
      const label = labelOf(ep, o);
      if (restricted && ep.kind !== "local") {
        if (!grouped) throw new CloudModelForbidden(`${label} is a cloud model, and only local models are allowed here`);
        continue;
      }
      if (fixKind && kind && ep.kind !== kind) { skipped.push({ label, reason: `it is ${ep.kind}, and this list won't cross to ${ep.kind}` }); continue; }
      const why = this.unfit(task, o, ep, need);
      if (why) { skipped.push({ label, reason: why }); continue; }
      return { ref: { offeringId: o.id }, endpoint: ep, offering: o, label, profile, source: found.source, skipped, remaining: unique.length - i - 1 };
    }
    const reasons = skipped.map((s) => `${s.label}: ${s.reason}`).join("; ");
    throw new NoModel(`no model for ${task} can answer now${reasons ? ` (${reasons})` : ""}`);
  }

  /**
   * Like `resolve`, but first probes a chosen endpoint whose health isn't
   * known lately, when there is a later model to fall back to, so a machine
   * that is off is passed over before the call rather than after.
   */
  async resolveLive(task: Task, ctx: CallContext, need: Need = {}): Promise<Resolution> {
    for (;;) {
      const r = this.resolve(task, ctx, need);
      const h = this.health.get(r.endpoint.id);
      if (!r.remaining || (h && Date.now() - h.at < HEALTH_MS)) return r;
      const { state } = await this.probe(ctx.userId, r.endpoint.id, PROBE_MS).catch(() => ({ state: "down" as const }));
      if (state === "down") this.reportDown(r.endpoint.id);
      if (state === "up") return r;
    }
  }

  /** The thinking level a model runs at for a requested one, and a note when it can't think at that level. */
  thinkingFor(r: Pick<Resolution, "offering" | "label">, asked: ThinkingLevel = "off"): { level: ThinkingLevel; note?: string } {
    if (asked === "off") return { level: "off" };
    const levels = r.offering.reasoning ?? [];
    if (!levels.length) return { level: "off", note: `${r.label} can't think, so it answered without thinking` };
    if ((levels as string[]).includes(asked)) return { level: asked };
    // A thinking switch (one level) is simply on.
    if (levels.length === 1) return { level: levels[0]! };
    const at = THINKING_LEVELS.indexOf(asked);
    const level = [...levels].sort((a, b) => Math.abs(THINKING_LEVELS.indexOf(a) - at) - Math.abs(THINKING_LEVELS.indexOf(b) - at))[0]!;
    return { level, note: `${r.label} doesn't think at ${asked}, so it thought at ${level}` };
  }

  /** Records which model answered a call. Never any of the conversation's text. */
  recordCall(userId: string, call: { pool: Pool; threadId: string; task: Task; resolution: Resolution; note?: string }): void {
    const r = call.resolution;
    const first = r.skipped[0];
    const fallback = first && `${first.label} was skipped (${first.reason.replace(/^it /, "")}), so ${r.label} answered${r.endpoint.kind === "cloud" && r.profile === "custom" ? ", a cloud model" : ""}`;
    this.withUser(userId, (db) => db.prepare("INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, fallback, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), call.pool, call.threadId, call.task, r.offering.id, r.label, r.endpoint.name, r.endpoint.kind, fallback ?? null, call.note ?? null));
  }

  /** The user's recent calls, newest first. With a thread, that thread's only. */
  recentCalls(userId: string, opts: { limit?: number; threadId?: string } = {}): CallRecord[] {
    const rows = this.withUser(userId, (db) => db.prepare(`SELECT * FROM model_calls ${opts.threadId ? "WHERE thread = ?" : ""} ORDER BY id DESC LIMIT ?`)
      .all(...(opts.threadId ? [opts.threadId] : []), opts.limit ?? 50)) as { at: string; pool: Pool; thread: string; task: Task; offering: string; label: string; endpoint: string; kind: "cloud" | "local"; fallback: string | null; note: string | null }[];
    return rows.map((r) => ({
      at: r.at, pool: r.pool, threadId: r.thread, task: r.task, offeringId: r.offering, label: r.label, endpointName: r.endpoint, kind: r.kind,
      ...(r.fallback ? { fallback: r.fallback } : {}), ...(r.note ? { note: r.note } : {}),
    }));
  }

  /** Every endpoint and model a context may use. For a restricted context, local endpoints only. */
  allowed(ctx: CallContext): { endpoint: Endpoint; offerings: Offering[] }[] {
    const c = this.catalog(ctx.userId);
    return [...c.endpoints.values()]
      .filter((e) => !isRestricted(ctx) || e.kind === "local")
      .map((endpoint) => ({ endpoint, offerings: [...c.offerings.values()].filter((o) => o.endpointId === endpoint.id) }));
  }

  /** The list that decides a task, after `same` and the chat fallback, with tombstoned entries dropped. */
  private listFor(task: Task, ctx: CallContext, c = this.catalog(ctx.userId)): { list: ModelRef[]; source: "thread" | "profile" } | undefined {
    const profile = this.profile(ctx.userId, profileFor(ctx));
    const live = (list: ModelRef[] | undefined) => list?.flatMap((r): ModelRef[] => {
      const id = this.follow(refId(r));
      if (!id) return [];
      return "groupId" in r ? (c.groups.has(id) ? [{ groupId: id }] : []) : [{ offeringId: id }];
    });
    const of = (t: Task): { list: ModelRef[]; source: "thread" | "profile" } | undefined => {
      const own = live(ctx.overrides?.[t]);
      if (own?.length) return { list: own, source: "thread" };
      let e = profile[t];
      if (e && !isList(e)) e = profile[e.same];
      const listed = live(isList(e) ? e : undefined);
      return listed?.length ? { list: listed, source: "profile" } : undefined;
    };
    return of(task) ?? (OWN_LIST_ONLY.includes(task) ? undefined : of("chat"));
  }

  /** Why a model can't take this call now, if it can't. */
  private unfit(task: Task, o: Offering, ep: Endpoint, need: Need): string | undefined {
    if (o.status === "gone") return `it has been missing from ${ep.name} for ${GONE_DAYS} days`;
    if (ep.stale) return `${ep.name} hasn't answered for ${STALE_DAYS} days`;
    const h = this.health.get(ep.id);
    if (h && !h.up && Date.now() - h.at < HEALTH_MS) return `${ep.name} is down`;
    if (task === "image.create" && !o.image) return "it doesn't make images";
    if (task === "image.edit" && !o.edit) return "it doesn't edit images";
    if (need.tools && o.tools === false) return "it can't use tools";
    if (need.tokens && o.contextWindow && o.contextWindow < need.tokens) return `its context window (${o.contextWindow} tokens) is smaller than the conversation`;
    return undefined;
  }

  /**
   * Checks a list before it is saved: every entry exists; `kind` local or
   * cloud takes that kind only (a group needs a member of it), `single`
   * takes one kind, either; image tasks take models that can do the job.
   */
  private checkList(userId: string, list: ModelRef[], opts: { kind?: "cloud" | "local" | "single"; task: Task }): ModelRef[] {
    const c = this.catalog(userId);
    const out: ModelRef[] = [];
    const kinds = new Set<string>();
    const fits = (o: Offering) => (opts.task === "image.create" ? !!o.image : opts.task === "image.edit" ? !!o.edit : true);
    for (const ref of list) {
      const id = ref && typeof ref === "object" ? refId(ref) : undefined;
      if (!id || typeof id !== "string") throw new NoModel("a list holds models or groups");
      if (out.some((r) => refId(r) === id)) continue;
      if ("groupId" in ref) {
        const g = c.groups.get(ref.groupId);
        if (!g) throw new NoModel(`no group ${ref.groupId}`);
        const members = g.members.map((m) => c.offerings.get(m)).filter((o): o is Offering => !!o);
        const want = opts.kind === "local" || opts.kind === "cloud" ? opts.kind : undefined;
        if (want && !members.some((o) => c.endpoints.get(o.endpointId)!.kind === want)) {
          const msg = `the group ${g.name} has no ${want} copy`;
          throw want === "local" ? new CloudModelForbidden(`${msg}, and only local models are allowed here`) : new Error(msg);
        }
        if (!members.some(fits)) throw new Error(`no copy in the group ${g.name} can do ${opts.task}`);
        out.push({ groupId: g.id });
      } else {
        const o = c.offerings.get(ref.offeringId);
        if (!o) throw new NoModel(`no model ${ref.offeringId}`);
        const ep = c.endpoints.get(o.endpointId)!;
        if (opts.kind === "local" && ep.kind !== "local") throw new CloudModelForbidden(`${labelOf(ep, o)} is a cloud model, and only local models are allowed here`);
        if (opts.kind === "cloud" && ep.kind !== "cloud") throw new Error(`${labelOf(ep, o)} is a local model, and the cloud profile takes cloud models only; use the custom profile to mix them`);
        if (!fits(o)) throw new Error(`${labelOf(ep, o)} can't do ${opts.task}`);
        kinds.add(ep.kind);
        out.push({ offeringId: o.id });
      }
    }
    if (opts.kind === "single" && kinds.size > 1) throw new Error("a list here can't mix local and cloud models; only the custom profile can");
    return out;
  }

  private check(userId: string, ref: ModelRef, localOnly: boolean): void {
    this.checkList(userId, [ref], { kind: localOnly ? "local" : undefined, task: "chat" });
  }

  /** Follows redirects. Undefined for a removed model or group. */
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
      groups: (db.prepare("SELECT * FROM model_groups ORDER BY name").all() as GroupRow[]).map((r) => toGroup(r, shared)),
    });
    const own = this.withUser(userId, (db) => read(db, false));
    const shared = read(this.self(), true);
    return {
      endpoints: new Map([...own.endpoints, ...shared.endpoints].map((e) => [e.id, e])),
      offerings: new Map([...own.offerings, ...shared.offerings].map((o) => [o.id, o])),
      groups: new Map([...own.groups, ...shared.groups].map((g) => [g.id, g])),
    };
  }

  /** Members must exist, be on different endpoints, and for a shared group be shared. */
  private checkMembers(userId: string, members: string[], shared: boolean): string[] {
    const c = this.catalog(userId);
    const endpoints = new Set<string>();
    const out: string[] = [];
    for (const id of members) {
      const o = c.offerings.get(id);
      if (!o) throw new NoModel(`no model ${id}`);
      const ep = c.endpoints.get(o.endpointId)!;
      if (shared && !ep.shared) throw new Error("a shared group takes shared models only");
      if (endpoints.has(ep.id)) throw new Error(`a group holds one copy per endpoint, and ${ep.name} is already in it`);
      endpoints.add(ep.id);
      out.push(id);
    }
    return out;
  }

  /**
   * A call to the endpoint succeeded: it isn't down, so it can't go stale.
   * Stale counts only failures with no success since.
   */
  reportUp(userId: string, endpointId: string): void {
    this.health.set(endpointId, { up: true, at: Date.now() });
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
      return refId(ref);
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

  /** Records whether an endpoint answered, for stale and for the router's health cache. */
  private seen(ep: Endpoint, up: boolean, userId: string): void {
    this.health.set(ep.id, { up, at: Date.now() });
    const sql = up ? "UPDATE endpoints SET down_since = NULL WHERE id = ?" : "UPDATE endpoints SET down_since = ? WHERE id = ? AND down_since IS NULL";
    const args = up ? [ep.id] : [new Date().toISOString(), ep.id];
    if (ep.shared) this.self().prepare(sql).run(...args);
    else this.withUser(userId, (db) => db.prepare(sql).run(...args));
  }

  private setting(userId: string, key: string): string | undefined {
    return this.withUser(userId, (db) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value);
  }

  private setSetting(userId: string, key: string, value: string): void {
    this.withUser(userId, (db) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value));
  }

  private threadChoice(userId: string, threadId: string, column: "profile" | "thinking", value: string | null): void {
    this.withUser(userId, (db) => {
      db.prepare("INSERT OR IGNORE INTO thread_choices (thread) VALUES (?)").run(threadId);
      db.prepare(`UPDATE thread_choices SET ${column} = ? WHERE thread = ?`).run(value, threadId);
    });
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
        splitCloudProfile(db, self);
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

  /** Records which shared models and groups this user's lists name: shared offerings and groups, and redirected IDs, only. */
  private index(userId: string, db: Db): void {
    const self = this.self();
    const shared = new Set((self.prepare("SELECT id FROM offerings UNION SELECT id FROM model_groups UNION SELECT from_id FROM offering_redirects").all() as { id: string }[]).map((r) => r.id));
    const refs = [...collectRefs(db).keys()].filter((id) => shared.has(id));
    self.transaction(() => {
      self.prepare("DELETE FROM shared_refs WHERE user = ?").run(userId);
      const add = self.prepare("INSERT OR IGNORE INTO shared_refs (user, ref) VALUES (?, ?)");
      for (const r of refs) add.run(userId, r);
      self.prepare("INSERT OR IGNORE INTO shared_refs_indexed (user) VALUES (?)").run(userId);
    })();
  }

  /** Where this user's own lists use each offering or group. */
  private uses(userId: string): Map<string, Use[]> {
    return this.withUser(userId, (db) => collectRefs(db));
  }

  /** A model's or group's label as stored in `db`, with `prefix` (`shared.` for self.db). */
  private labelIn(db: Db, id: string, prefix = SHARED): string | undefined {
    const o = db.prepare("SELECT e.name, o.model FROM offerings o JOIN endpoints e ON e.id = o.endpoint WHERE o.id = ?").get(id) as { name: string; model: string } | undefined;
    if (o) return `${prefix}${o.name}/${o.model}`;
    const g = db.prepare("SELECT name FROM model_groups WHERE id = ?").get(id) as { name: string } | undefined;
    return g && `the group ${prefix}${g.name}`;
  }

  /**
   * Retires offerings or groups: `pairs` lists each from → to (null for
   * removed), then `change` runs in the same transaction. A personal one's
   * owner rewrites their lists at once; a shared one's redirects are followed
   * at once and wait for each user, who rewrites their lists at their next
   * open. Shared groups are rewritten at once.
   */
  private retire(actor: User, shared: boolean, pairs: (db: Db) => [string, string | null][], change: (db: Db) => void): void {
    if (shared) {
      if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints and groups");
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
        const map = new Map(list);
        for (const g of self.prepare("SELECT id, members FROM model_groups").all() as { id: string; members: string }[]) {
          const next = mapMembers(JSON.parse(g.members), map);
          if (next) self.prepare("UPDATE model_groups SET members = ? WHERE id = ?").run(JSON.stringify(next), g.id);
        }
      })();
      return;
    }
    this.withUser(actor.id, (db) => {
      db.transaction(() => {
        const list = pairs(db);
        const labels = new Map(list.map(([from]) => [from, this.labelIn(db, from, "") ?? from]));
        change(db);
        rewrite(db, new Map(list), (id) => labels.get(id) ?? id, (id) => this.labelIn(db, id, "") ?? this.labelIn(this.self(), id));
      })();
      this.index(actor.id, db);
    });
  }

  /** Shared endpoints change only with an administrator; own endpoints, only as their user. */
  private write(actor: User, endpointId: string, fn: (db: Db) => void): void {
    if (this.isShared(endpointId)) {
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
    if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change shared endpoints and groups");
    fn(this.self());
  }
}

const labelOf = (ep: Endpoint, o: Offering) => `${ep.shared ? SHARED : ""}${ep.name}/${o.modelId}`;

/**
 * The cloud profile used to take local models too; now it takes cloud
 * models only. Once per user: a cloud profile that names a local model is
 * copied to Custom, which becomes their default for general threads, and
 * the local models leave the cloud profile.
 */
function splitCloudProfile(db: Db, self: Db): void {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'profiles_v2'").get()) return;
  db.transaction(() => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('profiles_v2', 'done')").run();
    const sql = "SELECT e.kind FROM offerings o JOIN endpoints e ON e.id = o.endpoint WHERE o.id = ?";
    const kindOf = (id: string) => ((db.prepare(sql).get(id) ?? self.prepare(sql).get(id)) as { kind: string } | undefined)?.kind;
    const rows = db.prepare("SELECT task, entry FROM model_profiles WHERE profile = 'cloud'").all() as { task: string; entry: string }[];
    const isLocal = (ref: ModelRef) => "offeringId" in ref && kindOf(ref.offeringId) === "local";
    if (!rows.some((r) => { const e = JSON.parse(r.entry) as Entry; return isList(e) && e.some(isLocal); })) return;
    if (!db.prepare("SELECT 1 FROM model_profiles WHERE profile = 'custom'").get()) {
      for (const r of rows) db.prepare("INSERT INTO model_profiles (profile, task, entry) VALUES ('custom', ?, ?)").run(r.task, r.entry);
    }
    for (const r of rows) {
      const e = JSON.parse(r.entry) as Entry;
      if (!isList(e)) continue;
      const cloud = e.filter((ref) => !isLocal(ref));
      if (!cloud.length) db.prepare("DELETE FROM model_profiles WHERE profile = 'cloud' AND task = ?").run(r.task);
      else db.prepare("UPDATE model_profiles SET entry = ? WHERE profile = 'cloud' AND task = ?").run(JSON.stringify(cloud), r.task);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('general_profile', 'custom')").run();
    addNotice(db, ["Your cloud profile named local models. The cloud profile now takes cloud models only, so it was copied to the new custom profile, which general threads now use."]);
  })();
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error("endpoint names use lowercase letters, digits and '-'");
}

function checkAddresses(addresses: string[]): string[] {
  const list = (Array.isArray(addresses) ? addresses : []).map((a) => String(a).trim()).filter(Boolean);
  if (!list.length) throw new Error("a model host needs at least one address");
  for (const a of list) hostOrigin(a);
  return list;
}

function checkGroupName(name: string): string {
  const n = String(name ?? "").trim();
  if (!n || n.length > 80) throw new Error("a group needs a name of up to 80 characters");
  return n;
}

function checkThinking(level: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) throw new Error("thinking is off, low, medium or high");
  return level as ThinkingLevel;
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
