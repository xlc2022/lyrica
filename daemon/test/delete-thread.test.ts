// Deleting a thread (docs/memory.md, "Deletion"; principle 1): nothing of it is
// left in user.db or its pool, whatever table a later change adds.
import { describe, expect, it } from "vitest";
import type { Db } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** Every table and column of `db` that still holds `needle`, as `table.column`. */
function holding(db: Db, needle: string): string[] {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return tables.flatMap((t) => (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[])
    .filter(({ name }) => (db.prepare(`SELECT count(*) AS n FROM "${t}" WHERE instr(CAST("${name}" AS TEXT), ?) > 0`).get(needle) as { n: number }).n > 0)
    .map(({ name }) => `${t}.${name}`));
}

describe("deleting a thread", () => {
  it("leaves no row naming it in user.db or its pool", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const u = `/api/u/${rt.ada.id}`;
    const thread = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Miso the cat" })).body;
    const path = `${u}/threads/general/${enc(thread.id)}`;
    // A turn, its settings, a pin, a note from the Files panel and a held approval: rows in both databases.
    model.reply({ text: "Hello, Ada." });
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    await ada.post(`${path}/messages`, { text: "my cat Miso is ill" });
    await stream.until((e: ThreadEvent) => e.type === "turn_end");
    stream.close();
    expect((await ada.call("PATCH", `${path}/settings`, { code: true })).status).toBe(200);
    await ada.put(`${path}/pin`, {});
    const settings = d.services!.workspace.settings(rt.ada.id);
    settings.noteFiles(thread.id, "added", ["notes/miso.md"]);
    settings.grantHeld(thread.id, "bash:ls");
    // Her write's record, while the home isn't mounted: the record goes at once, a snapshot at the sweep.
    d.services!.workspace.changes(rt.ada.id).record("general", thread.id, { toolCall: "c1", target: "sandbox", path: "/workspace/miso.md", before: undefined, after: "x" });

    const userDb = () => d.services!.users.openUserDb(rt.ada.id);
    const poolDb = () => {
      const o = d.services!.memory.openOwnerView(rt.ada.id);
      return { db: (o.general as unknown as { db: Db }).db, close: () => o.close() };
    };
    const before = userDb();
    const p = poolDb();
    try {
      expect(holding(before, thread.id).length).toBeGreaterThan(3);
      expect(holding(p.db, thread.id)).toContain("entries.thread");
    } finally { before.close(); p.close(); }

    expect((await ada.del(path)).status).toBe(200);
    const after = userDb();
    const q = poolDb();
    try {
      expect(holding(after, thread.id)).toEqual([]);
      expect(holding(q.db, thread.id)).toEqual([]);
      expect(holding(q.db, "Miso")).toEqual([]);
      expect(holding(q.db, "miso")).toEqual([]);
    } finally { after.close(); q.close(); }
  });

  it("sweeps the settings an older release left for threads that are gone, and keeps a live thread's", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general" })).body;
    const settings = d.services!.workspace.settings(rt.ada.id);
    settings.setThread("web/gone", "general", { code: true });
    settings.noteFiles("web/gone", "added", ["a.md"]);
    expect((await d.sweepUser(rt.ada.id)).records).toBe(2);
    const db = d.services!.users.openUserDb(rt.ada.id);
    try {
      expect(holding(db, "web/gone")).toEqual([]);
      expect(holding(db, thread.id)).toEqual(["thread_workspaces.thread_id"]);
    } finally { db.close(); }
  });
});
