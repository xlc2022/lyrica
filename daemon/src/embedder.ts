import { EMBED_BATCH, isUnreachable, NoModel, type Memory, type Models, type Pool, type Users } from "@lyrica/core";

// The embedder: vectors for recall by meaning (docs/briefs/recall-meaning.md).
// On each tick, for each unlocked user and pool, it resolves the pool's
// Embeddings model, embeds a batch of what the index holds without a vector
// from that model, and stores them. A pool whose model changed starts over,
// since one index holds one model's vectors. It logs counts only, never text.

export interface EmbedderOptions {
  users: Users;
  memory: Memory;
  models: Models;
  hasKey: (userId: string) => boolean;
  log: (line: string) => void;
}

/** How long a pool rests after its embedding model couldn't be reached or has nothing to do. */
const REST_MS = 60_000;

export class Embedder {
  private running = false;
  private readonly restUntil = new Map<string, number>();
  constructor(private readonly o: EmbedderOptions) {}

  /** One pass over every unlocked pool, one at a time; a pass still running isn't joined by another. */
  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const u of this.o.users.all()) {
        if (!this.o.hasKey(u.id)) continue;
        for (const pool of ["general", "private"] as const) {
          const key = `${u.id}/${pool}`;
          if ((this.restUntil.get(key) ?? 0) > now) continue;
          const did = await this.pool(u.id, pool).catch((err: Error) => { this.o.log(`embedding ${pool} memory failed: ${err.name}`); return 0; });
          if (did < EMBED_BATCH) this.restUntil.set(key, now + REST_MS);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Embeds one batch for a pool. Returns how many items got a vector or were marked skipped (0 with nothing to do or no model). */
  async pool(userId: string, pool: Pool): Promise<number> {
    const ctx = { userId, pool, localOnly: pool === "private" };
    const model = this.o.models.embeddingModel(ctx);
    if (!model) return 0;
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const pending = view.own.unembedded(model, EMBED_BATCH);
      if (!pending.length) return 0;
      const toEmbed = pending.filter((p) => p.text);
      let vectors: Float32Array[] = [];
      if (toEmbed.length) {
        try {
          const out = await this.o.models.embed(ctx, toEmbed.map((p) => p.text));
          // The list resolved to another model meanwhile: its vectors go with that model, and the next pass sees what's left.
          if (out.model !== model) { view.own.putVectors(out.model, toEmbed.map((p, i) => ({ id: p.id, kind: p.kind, vec: out.vectors[i]! }))); return out.vectors.length; }
          vectors = out.vectors;
        } catch (err) {
          if (err instanceof NoModel || isUnreachable(err)) return 0;
          throw err;
        }
      }
      const rows = pending.map((p) => {
        const at = toEmbed.indexOf(p);
        return at >= 0 ? { id: p.id, kind: p.kind, vec: vectors[at]! } : { id: p.id, kind: p.kind };
      });
      view.own.putVectors(model, rows);
      return rows.length;
    } finally {
      view.close();
    }
  }
}
