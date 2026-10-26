// Deleting a user (DESIGN.md, "Deleting a user"): another administrator, with
// their own password and the box ticked, removes the user's account and
// everything they own. Other users keep their own data; nothing about the
// deleted user is left in self.db or on disk, and nothing is logged.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keyring, Users } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { DeleteUserResult, ThreadSummary } from "../src/api.ts";
import { ARGON2, browser, daemon, KDF_ITER, enc, localModel, login, runtime } from "./helpers.ts";

/** Every self.db row that names the user, by table. */
function traces(keyring: Keyring, id: string): Record<string, number> {
  const self = keyring.self();
  const count = (sql: string, ...args: string[]) => (self.prepare(sql).get(...args) as { n: number }).n;
  return {
    users: count("SELECT count(*) AS n FROM users WHERE id = ?", id),
    user_links: count("SELECT count(*) AS n FROM user_links WHERE a = ? OR b = ?", id, id),
    thread_shares: count("SELECT count(*) AS n FROM thread_shares WHERE from_user = ? OR to_user = ?", id, id),
    persona_proposals: count("SELECT count(*) AS n FROM persona_proposals WHERE sent_by = 'user:' || ?", id),
    password_set_by: count("SELECT count(*) AS n FROM users WHERE password_set_by = ?", id),
    workspace_paths: count("SELECT count(*) AS n FROM workspace_paths WHERE user_id = ?", id),
    redirect_pending: count("SELECT count(*) AS n FROM redirect_pending WHERE user = ?", id),
    shared_refs: count("SELECT count(*) AS n FROM shared_refs WHERE user = ?", id),
    settings: count("SELECT count(*) AS n FROM settings WHERE value LIKE ?", `%${id}%`),
  };
}

const none = { users: 0, user_links: 0, thread_shares: 0, persona_proposals: 0, password_set_by: 0, workspace_paths: 0, redirect_pending: 0, shared_refs: 0, settings: 0 };

describe("deleting a user", () => {
  it("removes their account, folder and every self.db row naming them, and leaves other users alone", async () => {
    const rt = await runtime();
    const { base, d, logs } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const au = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    const del = `${au}/admin/users/${rt.sam.id}/delete`;
    await ada.post<ThreadSummary>(`${au}/threads`, { pool: "general", title: "Miso the cat" });
    const plans = (await sam.post<ThreadSummary>(`${su}/threads`, { pool: "general", title: "Sam's plans" })).body;
    // Sam sends Ada a thread she hasn't accepted yet, saves their key, is linked to Ada and may grant a folder.
    expect((await sam.post(`${su}/threads/general/${enc(plans.id)}/share`, { to: rt.ada.id })).status).toBe(200);
    expect((await sam.put(`${su}/me/credentials`, { save: true })).status).toBe(200);
    d.keyring.self().prepare("INSERT INTO user_links (a, b) VALUES (?, ?)").run(...[rt.ada.id, rt.sam.id].sort());
    // Sam sends on a persona suggestion, as PersonaProposals.send does from a draft in their user.db.
    const db = d.services!.users.openUserDb(rt.sam.id);
    const draft = Number(db.prepare("INSERT INTO persona_drafts (path, text, original, reason, author, base, created_at) VALUES ('soul.md', 'x', 'x', 'y', 'lyrica', 0, ?)").run(new Date().toISOString()).lastInsertRowid);
    db.close();
    d.services!.proposals.send(rt.sam.id, draft);
    // Sam set someone's password once (only an administrator can; the column is all that matters here).
    d.keyring.self().prepare("UPDATE users SET password_set_by = ?, password_set_at = ? WHERE id = ?").run(rt.sam.id, "2026-10-26T00:00:00Z", rt.ada.id);
    d.keyring.self().prepare("INSERT INTO workspace_paths (user_id, pool, path) VALUES (?, 'general', '/srv/homelab')").run(rt.sam.id);
    expect(traces(d.keyring, rt.sam.id)).toMatchObject({ users: 1, user_links: 1, thread_shares: 1, persona_proposals: 1, password_set_by: 1, workspace_paths: 1 });
    expect(d.keyring.hasSavedKey(rt.sam.id)).toBe(true);

    // Administrators only, never themselves, with their own password and the box ticked.
    expect((await sam.post(`${su}/admin/users/${rt.ada.id}/delete`, { password: "pw2", understood: true })).status).toBe(403);
    expect((await ada.post(`${au}/admin/users/${rt.ada.id}/delete`, { password: "pw", understood: true })).status).toBe(403);
    expect((await ada.post(del, { password: "pw", understood: false })).status).toBe(400);
    expect((await ada.post(del, { password: "not-ada", understood: true })).status).toBe(401);
    expect(traces(d.keyring, rt.sam.id).users).toBe(1);

    expect((await ada.get<DeleteUserResult>(del)).body).toEqual({ deleted: false, busy: [] });
    expect((await ada.post<DeleteUserResult>(del, { password: "pw", understood: true })).body).toEqual({ deleted: true, busy: [] });

    expect(traces(d.keyring, rt.sam.id)).toEqual(none);
    expect(d.services!.users.passwordSetBy(rt.ada.id)).toBeUndefined();
    expect(d.keyring.self().prepare("SELECT password_set_at AS at FROM users WHERE id = ?").get(rt.ada.id)).toEqual({ at: "2026-10-26T00:00:00Z" });
    expect(existsSync(join(rt.home, "users", rt.sam.id))).toBe(false);
    expect(d.keyring.hasSavedKey(rt.sam.id)).toBe(false);
    expect(d.keyring.hasUserKey(rt.sam.id)).toBe(false);
    // Sam's browser is signed out and the login no longer works; the name is free again.
    expect((await sam.get(`${su}/threads`)).status).toBe(401);
    expect((await browser(base).post("/api/login", { login: "sam", password: "pw2" })).status).toBe(401);
    // Ada keeps her threads and stays signed in.
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body.map((t) => t.title)).toEqual(["Miso the cat"]);
    expect((await ada.get<{ login: string }[]>(`${au}/admin/users`)).body.map((x) => x.login)).toEqual(["ada"]);
    expect(JSON.stringify(logs)).not.toMatch(/Sam|plans|sam/);
  });

  it("deletes a locked user without their key", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    await sam.post<ThreadSummary>(`/api/u/${rt.sam.id}/threads`, { pool: "private", title: "A private worry" });
    await sam.post(`/api/u/${rt.sam.id}/lock`, {});
    expect(d.keyring.hasUserKey(rt.sam.id)).toBe(false);
    const done = await ada.post<DeleteUserResult>(`/api/u/${rt.ada.id}/admin/users/${rt.sam.id}/delete`, { password: "pw", understood: true });
    expect(done.body).toEqual({ deleted: true, busy: [] });
    expect(existsSync(join(rt.home, "users", rt.sam.id))).toBe(false);
    expect(traces(d.keyring, rt.sam.id)).toEqual(none);
  });

  it("stops the user's running work first and deletes only once it has stopped", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const su = `/api/u/${rt.sam.id}`;
    const del = `/api/u/${rt.ada.id}/admin/users/${rt.sam.id}/delete`;
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(sam, rt.sam.id, model.baseUrl);
    const thread = (await sam.post<ThreadSummary>(`${su}/threads`, { pool: "general", title: "long work" })).body;
    const path = `${su}/threads/general/${enc(thread.id)}`;
    const stream = sam.events(`${path}/events`);
    await stream.ready;
    model.reply({ text: "a very slow answer", slowMs: 60_000 });
    await sam.post(`${path}/messages`, { text: "take your time" });
    await stream.until((e) => e.type === "turn_start", 0, 10_000);

    // Thread titles never reach the administrator: only the kind and pool.
    expect((await ada.post<DeleteUserResult>(del, { password: "pw", understood: true })).body).toEqual({ deleted: false, busy: [{ kind: "turn", user: "Sam", pool: "general" }] });
    expect(existsSync(join(rt.home, "users", rt.sam.id))).toBe(true);
    await stream.until((e) => e.type === "turn_end", 0, 10_000);
    stream.close();
    expect((await ada.get<DeleteUserResult>(del)).body).toEqual({ deleted: false, busy: [] });
    expect((await ada.post<DeleteUserResult>(del, { password: "pw", understood: true })).body).toEqual({ deleted: true, busy: [] });
    expect(existsSync(join(rt.home, "users", rt.sam.id))).toBe(false);
  });

  it("finishes removing the folder at the next start after an interrupted delete", async () => {
    const rt = await runtime();
    // The transaction ran and the process stopped before the folder went.
    const keyring = new Keyring(rt.home, ARGON2, KDF_ITER);
    await keyring.unlockSelf("passphrase");
    const users = new Users(keyring);
    users.deleteUser(rt.ada, rt.sam);
    expect(users.pendingDeletes()).toEqual([rt.sam.id]);
    keyring.self().close();
    expect(existsSync(join(rt.home, "users", rt.sam.id))).toBe(true);

    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    expect(existsSync(join(rt.home, "users", rt.sam.id))).toBe(false);
    expect(d.services!.users.pendingDeletes()).toEqual([]);
    expect(existsSync(join(rt.home, "users", rt.ada.id))).toBe(true);
  });

  it("leaves an administrator however the roles change: only another administrator can delete", async () => {
    const rt = await runtime();
    const keyring = new Keyring(rt.home, ARGON2, KDF_ITER);
    await keyring.unlockSelf("passphrase");
    const users = new Users(keyring);
    // Sam is made an administrator, Ada steps down: Sam is now the only one, and nobody can delete them.
    users.setAdmin(rt.ada, rt.sam, true);
    users.setAdmin(rt.sam, rt.ada, false);
    const sam = users.get(rt.sam.id)!;
    expect(() => users.deleteUser(sam, sam)).toThrow("you can't delete yourself");
    expect(() => users.deleteUser(users.get(rt.ada.id)!, sam)).toThrow("only an administrator can delete a user");
    expect(users.all().map((u) => u.login)).toEqual(["ada", "sam"]);
    keyring.self().close();
  });
});
