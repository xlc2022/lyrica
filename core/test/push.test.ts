import { afterEach, expect, it } from "vitest";
import { PushStore, SCHEMA, STEPS, checkReadable, migrate } from "../src/index.ts";
import { openEncrypted } from "../src/db.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratchDb = () => { const dir = mkdtempSync(join(tmpdir(), "lyrica-push-")); dirs.push(dir); return openEncrypted(join(dir, "user.db"), { raw: Buffer.alloc(32, 7) }); };

it("expands every released user schema with durable text-free delivery IDs", () => {
  for (let v = 1; v < SCHEMA.user; v++) {
    const db = scratchDb(), previous = STEPS.user.filter(s => s.version <= v);
    migrate(db, "user", {}, previous);
    db.prepare("INSERT INTO settings (key, value) VALUES ('example', 'kept')").run();
    migrate(db, "user");
    expect(() => checkReadable(db, "user", previous)).not.toThrow();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'example'").get()).toEqual({ value: "kept" });
    const store = new PushStore(db);
    store.save({ url: "https://receiver.example/secret", token: "secret", link: false, origin: "https://app.example" });
    expect(new PushStore(db).settings()?.token).toBe("secret");
    store.sent(["question:1"], 100);
    expect(new PushStore(db).pending(["question:1", "question:2"], 200)).toEqual(["question:2"]);
    store.pending([], 300);
    expect(store.pending(["question:1"], 400)).toEqual(["question:1"]);
    store.sent(["question:1"], 100);
    expect(store.pending(["question:1"], 31 * 86400_000)).toEqual(["question:1"]);
    store.off();
    expect(store.settings()).toBeUndefined();
    db.close();
  }
});
