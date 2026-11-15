import { afterEach, describe, expect, it, vi } from "vitest";
import { Memory, Users, type PoolStore } from "../src/index.ts";
import { exactScores, forgetVectors, nearestInMemory, VECTOR_CACHE_BYTES, VECTOR_CACHE_IDLE_MS, vectorCacheBytes, vectorCacheLimits } from "../src/store/vector-cache.ts";
import { freshKeyring, profile } from "./helpers.ts";

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Al"), { admin: true });
  await users.authenticate("ada", "pw");
  return { users, ada, memory: new Memory(keyring, users) };
}

/** A repeatable pseudo-random vector, so a failure can be rerun. */
function vector(seed: number, dim: number): Float32Array {
  let x = seed * 2654435761 % 4294967296 || 1;
  return Float32Array.from({ length: dim }, () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 - 0.5; });
}
const unit = (v: Float32Array) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const near = (base: Float32Array, seed: number, mix: number) => Float32Array.from(base, (x, i) => x + mix * vector(seed, base.length)[i]!);
const db = (store: PoolStore) => (store as unknown as { db: Parameters<typeof nearestInMemory>[0] }).db;
/** What the search read from disk would say: every row, scored exactly. */
const fromDisk = (store: PoolStore, model: string, q: Float32Array, limit: number) =>
  exactScores(db(store).prepare("SELECT id, kind, vec FROM vectors WHERE model = ? AND vec IS NOT NULL").all(model) as never, unit(q), 0.5).slice(0, limit);

afterEach(() => {
  vectorCacheLimits.bytes = VECTOR_CACHE_BYTES;
  vectorCacheLimits.idleMs = VECTOR_CACHE_IDLE_MS;
  forgetVectors("/");
  vi.useRealTimers();
});

describe("recall's vectors in memory", () => {
  it("finds exactly what reading every vector from disk finds, with the same scores", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const dim = 256;
    const topics = [1, 2, 3].map((t) => vector(1000 + t, dim));
    // Clusters around three topics, so many items clear the floor and their order matters.
    own.putVectors("m", Array.from({ length: 600 }, (_, i) => ({ id: `n:${i}`, kind: "note" as const, vec: near(topics[i % 3]!, i, 0.4 + (i % 7) / 10) })));
    for (const q of [...topics, near(topics[0]!, 9999, 0.8), vector(77, dim)]) {
      expect(own.nearest("m", q, 20)).toEqual(fromDisk(own, "m", q, 20));
    }
    expect(own.nearest("m", topics[0]!, 20)).toHaveLength(20);
    expect(vectorCacheBytes()).toBeGreaterThan(600 * dim);
  });

  it("follows what any connection to the pool adds, replaces or deletes", async () => {
    const { memory, ada } = await setup();
    const a = memory.openThreadView(ada.id, "general");
    const b = memory.openThreadView(ada.id, "general");
    const food = Float32Array.from([1, 0, 0, 0]), rail = Float32Array.from([0, 1, 0, 0]);
    a.own.putVectors("m", [{ id: "n:1", kind: "note", vec: food }, { id: "n:2", kind: "note", vec: rail }]);
    expect(a.own.nearest("m", food, 5).map((n) => n.id)).toEqual(["n:1"]);
    // Another connection: a new item, one moved to another meaning, one skipped.
    b.own.putVectors("m", [{ id: "n:3", kind: "note", vec: food }, { id: "n:2", kind: "note", vec: food }, { id: "n:1", kind: "note" }]);
    expect(a.own.nearest("m", food, 5).map((n) => n.id).sort()).toEqual(["n:2", "n:3"]);
    db(b.own).prepare("DELETE FROM vectors WHERE id = 'n:3'").run();
    expect(a.own.nearest("m", food, 5).map((n) => n.id)).toEqual(["n:2"]);
    // The private pool's view reads the general pool through a read-only connection, and sees the same.
    const priv = memory.openThreadView(ada.id, "private");
    expect(priv.reads[0]!.nearest("m", food, 5).map((n) => n.id)).toEqual(["n:2"]);
    // A change of model starts the index over.
    b.own.putVectors("m2", [{ id: "n:9", kind: "note", vec: rail }]);
    expect(a.own.nearest("m", food, 5)).toEqual([]);
    expect(a.own.nearest("m2", rail, 5).map((n) => n.id)).toEqual(["n:9"]);
  });

  it("stays under its budget: the least recently used pool goes first, and a pool too big alone is read from disk", async () => {
    const { memory, ada } = await setup();
    const general = memory.openThreadView(ada.id, "general").own;
    const priv = memory.openThreadView(ada.id, "private").own;
    const dim = 128;
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n:${i}`, kind: "note" as const, vec: vector(i + 1, dim) }));
    general.putVectors("m", rows(100));
    priv.putVectors("m", rows(100));
    const q = vector(5, dim);
    general.nearest("m", q, 3);
    const one = vectorCacheBytes();
    // Room for one pool: searching the other lets the first go.
    vectorCacheLimits.bytes = Math.ceil(one * 1.5);
    priv.nearest("m", q, 3);
    expect(vectorCacheBytes()).toBeLessThanOrEqual(vectorCacheLimits.bytes);
    expect(vectorCacheBytes()).toBeGreaterThan(0);
    // Too small for either: nothing is held, and the answer is still right.
    forgetVectors("/");
    vectorCacheLimits.bytes = Math.floor(one / 2);
    expect(general.nearest("m", q, 3)).toEqual(fromDisk(general, "m", q, 3));
    expect(vectorCacheBytes()).toBe(0);
  });

  it("lets go of a pool's vectors when they go unused, and when the user locks", async () => {
    vi.useFakeTimers();
    const { memory, ada, users } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    own.putVectors("m", [{ id: "n:1", kind: "note", vec: Float32Array.from([1, 0]) }]);
    own.nearest("m", Float32Array.from([1, 0]), 1);
    expect(vectorCacheBytes()).toBeGreaterThan(0);
    vi.advanceTimersByTime(VECTOR_CACHE_IDLE_MS + 120_000);
    expect(vectorCacheBytes()).toBe(0);
    own.nearest("m", Float32Array.from([1, 0]), 1);
    expect(vectorCacheBytes()).toBeGreaterThan(0);
    forgetVectors(users.userDir(ada.id) + "/");
    expect(vectorCacheBytes()).toBe(0);
  });
});
