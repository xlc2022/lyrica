import type { Db } from "./db.ts";

export interface PushSettings { url: string; token?: string; link: boolean; origin: string }
export interface PushFailure { at: string; status: number }
export const PUSH_LIMITS = { window: 30_000, minimumGap: 60_000, timeout: 10_000, retries: 2 } as const;

/** Secrets and delivery IDs live only in the user's encrypted database (principle 2). */
export class PushStore {
  constructor(private db: Db) {}
  private read<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  private write(key: string, value: unknown) { this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value)); }
  settings() { return this.read<PushSettings>("push.settings"); }
  save(value: PushSettings) { this.write("push.settings", value); }
  off() { this.db.prepare("DELETE FROM settings WHERE key IN ('push.settings', 'push.failure')").run(); }
  failure() { return this.read<PushFailure>("push.failure"); }
  failed(value: PushFailure) { this.write("push.failure", value); }
  lastAttempt() { return this.read<number>("push.attempt") ?? 0; }
  attempted(at: number) { this.write("push.attempt", at); }
  sent(ids: string[], at: number) {
    this.db.transaction(() => { for (const id of ids) this.db.prepare("INSERT OR REPLACE INTO push_sent (id, at) VALUES (?, ?)").run(id, at); this.db.prepare("DELETE FROM settings WHERE key = 'push.failure'").run(); })();
  }
  pending(ids: string[], now: number): string[] {
    this.db.prepare("DELETE FROM push_sent WHERE at < ?").run(now - 30 * 86400_000);
    const current = new Set(ids);
    const sent = this.db.prepare("SELECT id FROM push_sent").all() as { id: string }[];
    for (const row of sent) if (!current.has(row.id)) this.db.prepare("DELETE FROM push_sent WHERE id = ?").run(row.id);
    const pushed = new Set(sent.map(r => r.id));
    return ids.filter(id => !pushed.has(id));
  }
}
