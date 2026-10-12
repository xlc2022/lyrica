// An administrator sets a user's password without losing their data
// (DESIGN.md, "Users"): the server keeps a recovery copy of each user's key.
import { describe, expect, it } from "vitest";
import type { Me, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

describe("an administrator sets a password", () => {
  it("keeps the user's data, tells them until they change it, and is for administrators only", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const lu = `/api/u/${rt.li.id}`;
    const su = `/api/u/${rt.sam.id}`;
    // Sam has a thread and stays logged in.
    let sam = await login(base, "sam", "pw2");
    const t = (await sam.post<ThreadSummary>(`${su}/threads`, { pool: "private", title: "Sam's notes" })).body;
    expect((await sam.put(`${su}/admin/users/${rt.li.id}/password`, { password: "x", yourPassword: "pw2" })).status).toBe(403);
    // Li sets a new one, with their own password: the old stops working, Sam's session ends, and the new opens the same data.
    expect((await li.put(`${lu}/admin/users/${rt.sam.id}/password`, { password: "", yourPassword: "pw" })).status).toBe(400);
    expect((await li.put(`${lu}/admin/users/${rt.sam.id}/password`, { password: "fresh-pw", yourPassword: "not-li" })).status).toBe(401);
    expect((await sam.get(`${su}/threads`)).status).toBe(200);
    expect((await li.put(`${lu}/admin/users/${rt.sam.id}/password`, { password: "fresh-pw", yourPassword: "pw" })).status).toBe(200);
    expect((await sam.get(`${su}/threads`)).status).toBe(401);
    expect((await browser(base).post("/api/login", { login: "sam", password: "pw2" })).status).toBe(401);
    sam = await login(base, "sam", "fresh-pw");
    expect((await sam.get<ThreadSummary[]>(`${su}/threads`)).body.map((x) => x.title)).toEqual(["Sam's notes"]);
    expect((await sam.get(`${su}/threads/private/${enc(t.id)}/messages`)).status).toBe(200);
    // Sam is told who set it, until they change it themselves.
    expect((await sam.get<Me>(`${su}/me`)).body.warning).toMatch(/^Li set your password on \d{4}-\d{2}-\d{2}\. Change it in Settings → Password\.$/);
    expect((await sam.post(`${su}/me/password`, { oldPassword: "fresh-pw", newPassword: "mine-again" })).status).toBe(200);
    expect((await sam.get<Me>(`${su}/me`)).body.warning).toBeUndefined();
    expect((await login(base, "sam", "mine-again")).cookie).toBeDefined();
  });
});
