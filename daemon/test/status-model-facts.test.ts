import { expect, it } from "vitest";
import { apiRoutes } from "../src/routes.ts";
import { match, statusOf, type Request } from "../src/http.ts";
import { Lyricad } from "../src/lyricad.ts";
import type { AdminStatus } from "../src/api.ts";
import { ARGON2, KDF_ITER, runtime } from "./helpers.ts";

it("Status reads all retained calls, but only this administrator's displayed pools, with existing facts intact", async () => {
  const rt = await runtime();
  const d = new Lyricad({ home: rt.home, port: 0, selfTest: false, log: () => {}, argon2: ARGON2, kdfIter: KDF_ITER });
  await d.unlock("passphrase");
  try {
    const users = d.services!.users;
    await users.authenticate("ada", "pw");
    await users.authenticate("sam", "pw2");
    const cookie = d.sessions.login(undefined, rt.ada.id, () => false).id;
    const routes = apiRoutes(d);
    const request = async (userId: string, session = cookie) => {
      const url = new URL(`/api/u/${userId}/admin/status`, "http://localhost");
      const found = match(routes, "GET", url.pathname);
      if (!found || found === "method") throw new Error("route not found");
      try { return { status: 200, body: await found.route.handler({ params: found.params, query: url.searchParams, cookie: session } as Request) as AdminStatus }; }
      catch (err) { return { status: statusOf(err), body: undefined }; }
    };
    const now = new Date().toISOString();
    for (const [userId, offering, count, pool] of [[rt.ada.id, "visible", 125, "general"], [rt.ada.id, "private-only", 80, "private"], [rt.sam.id, "other-user-only", 20, "general"]] as const) {
      const db = users.openUserDb(userId);
      try {
        const insert = db.prepare("INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES (?, ?, 'fixture', 'chat', ?, ?, 'fixture', 'local')");
        for (let i = 0; i < count; i++) insert.run(now, pool, offering, offering);
      } finally { db.close(); }
    }
    const both = (await request(rt.ada.id)).body!;
    expect(both.savedPassphrase).toBeTypeOf("boolean");
    expect(both.credentials).toHaveProperty("available");
    expect(both.modelFacts!.models.map((m) => [m.offeringId, m.calls])).toEqual([["private-only", 80], ["visible", 125]]);
    const db = users.openUserDb(rt.ada.id);
    try { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('display', ?)").run(JSON.stringify({ showPrivate: false })); }
    finally { db.close(); }
    const shown = (await request(rt.ada.id)).body!.modelFacts!;
    expect(shown.pools).toEqual(["general"]);
    expect(shown.models).toEqual([{ offeringId: "visible", label: "visible", endpointName: "fixture", calls: 125, speedSamples: 0, fallbacks: 0 }]);
    expect(JSON.stringify(shown)).not.toContain("private-only");
    expect(JSON.stringify(both)).not.toContain("other-user-only");
    // A signed-in normal user and a cross-account request cannot read the admin facts.
    const normalCookie = d.sessions.login(undefined, rt.sam.id, () => false).id;
    expect((await request(rt.sam.id, normalCookie)).status).toBe(403);
    expect((await request(rt.sam.id)).status).not.toBe(200);
    const emptyDb = users.openUserDb(rt.ada.id);
    try { emptyDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('display', ?)").run(JSON.stringify({ showGeneral: false, showPrivate: false })); }
    finally { emptyDb.close(); }
    expect((await request(rt.ada.id)).body!.modelFacts).toMatchObject({ pools: [], models: [] });
  } finally { await d.stop(); }
});
