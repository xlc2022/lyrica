import { existsSync } from "node:fs";
import { join } from "node:path";
import { openEncrypted, type Db } from "../db.ts";
import type { Keyring } from "../keyring.ts";
import type { UserId } from "../mentions.ts";
import type { Profile } from "../profile.ts";
import type { Pool } from "../types.ts";
import type { Users } from "../users.ts";
import { PoolReader, PoolStore, type Hit, type Item, type SearchOptions, type StoredEntry } from "./pool.ts";
import { splitId } from "./refs.ts";
import { POOL_SCHEMA, POOL_UPGRADES } from "./schema.ts";

/**
 * Store handles for one conversation (or one sleep run). A general view holds
 * only general.db. A private view writes private.db and reads general.db
 * through a read-only connection. Nothing hands a general view a private handle.
 */
export interface PoolView {
  readonly pool: Pool;
  readonly own: PoolStore;
  readonly reads: readonly PoolReader[];
  close(): void;
}

/** Both of a user's pools, read and write, for the memory browser and `lyrica mem`. Never given to a session. */
export interface OwnerView {
  readonly userId: UserId;
  readonly general: PoolStore;
  readonly private: PoolStore;
  close(): void;
}

const threadViews = new WeakSet<object>();

/** True only for views made by `openThreadView`. The extension refuses anything else. */
export function isThreadView(view: unknown): view is PoolView {
  return typeof view === "object" && view !== null && threadViews.has(view);
}

/** Opens the pool databases, keyed with the user's pool subkeys. */
export class Memory {
  constructor(private readonly keyring: Keyring, private readonly users: Users) {}

  /** The only way to get store handles for conversation work. */
  openThreadView(userId: UserId, pool: Pool): PoolView {
    const own = new PoolStore(this.context(userId, pool, "thread"));
    const reads: PoolReader[] = [];
    try {
      if (pool === "private") reads.push(new PoolReader(this.context(userId, "general", "thread", true)));
    } catch (err) {
      own.close();
      throw err;
    }
    const view: PoolView = {
      pool, own, reads: Object.freeze(reads),
      close: () => { own.close(); for (const r of reads) r.close(); },
    };
    threadViews.add(view);
    return Object.freeze(view);
  }

  openOwnerView(userId: UserId): OwnerView {
    const general = new PoolStore(this.context(userId, "general", "owner"));
    const priv = new PoolStore(this.context(userId, "private", "owner"));
    return Object.freeze({ userId, general, private: priv, close: () => { general.close(); priv.close(); } });
  }

  private context(userId: UserId, pool: Pool, mode: "thread" | "owner", readonly = false) {
    return { db: this.open(userId, pool, readonly), pool, owner: userId, profiles: () => this.profiles(), mode };
  }

  private open(userId: UserId, pool: Pool, readonly: boolean): Db {
    const path = join(this.users.userDir(userId), `${pool}.db`);
    const key = { raw: this.keyring.subkey(userId, `pool:${pool}`) };
    if (readonly && !existsSync(path)) openEncrypted(path, key).exec(POOL_SCHEMA).close();
    if (readonly) return openEncrypted(path, key, { readonly: true });
    const db = openEncrypted(path, key);
    db.pragma("secure_delete = ON");
    db.exec(POOL_SCHEMA);
    for (const u of POOL_UPGRADES) if (!db.prepare(u.check).get()) db.exec(u.sql);
    return db;
  }

  private profiles(): Map<UserId, Profile> {
    return new Map(this.users.all().map((u) => [u.id, u.profile]));
  }
}

// Reading across a view's pools. IDs from the other pool carry it: `general/n:…`.

function readers(view: PoolView): { prefix: string; store: PoolReader }[] {
  return [{ prefix: "", store: view.own }, ...view.reads.map((store) => ({ prefix: `${store.pool}/`, store }))];
}

/** Searches every pool the view can read. */
export function searchView(view: PoolView, query: string, opts: SearchOptions = {}): Hit[] {
  const limit = opts.limit ?? 8;
  return readers(view)
    .flatMap(({ prefix, store }) => store.search(query, opts).map((h) => ({ ...h, id: prefix + h.id })))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Resolves an ID (`n:…`, or `general/n:…` from a private view) to the store that holds it. */
export function resolve(view: PoolView, id: string): { store: PoolReader; id: string } | undefined {
  const ref = splitId(id);
  if (!ref) return undefined;
  const pool = ref.pool ?? view.pool;
  const store = pool === view.pool ? view.own : view.reads.find((r) => r.pool === pool);
  return store && { store, id: ref.id };
}

/** A memory, or a window of a past thread around an entry, as a view may read it. */
export function readView(view: PoolView, id: string, fromThread?: string): { item?: Item; entries?: StoredEntry[] } | undefined {
  const found = resolve(view, id);
  if (!found) return undefined;
  if (/^[et]:/.test(found.id)) {
    const entry = found.id.startsWith("t:") ? `e:${found.id.slice(2)}#1` : found.id;
    const entries = found.store.entryWindow(entry, 4, found.store === view.own ? fromThread : undefined);
    return entries.length ? { entries } : undefined;
  }
  const item = found.store.get(found.id);
  return item && { item };
}
