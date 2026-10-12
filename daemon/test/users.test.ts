import { describe, expect, it } from "vitest";
import type { LoginResponse, LogoutResponse, Me, PersonaProposal, ProposalDraft, State, UserCard } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

// Users may be different people: one browser holds one person's (linked)
// users, logout can drop the key, and persona proposals wait for the
// originating user's consent.

async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  return { rt, ...dm };
}

describe("one browser, one person", () => {
  it("logging in as an unlinked user ends the other user's session in that browser", async () => {
    const { rt, base } = await setup();
    const b = await login(base, "li", "pw");
    const liCookie = b.cookie;
    expect((await b.post<LoginResponse>("/api/login", { login: "sam", password: "pw2" })).body.replaced).toBe(true);
    expect(b.cookie).not.toBe(liCookie); // a new session
    expect((await b.get<State>("/api/state")).body.users.map((u) => u.login)).toEqual(["sam"]);
    expect((await b.get(`/api/u/${rt.li.id}/me`)).status).toBe(401);
    // The old cookie is dead too.
    b.cookie = liCookie;
    expect((await b.get(`/api/u/${rt.li.id}/me`)).status).toBe(401);
  });

  it("linking needs both passwords, and unlinking separates the two in every browser", async () => {
    const { rt, base } = await setup();
    const b = await login(base, "li", "pw");
    const url = `/api/u/${rt.li.id}/links`;
    expect((await b.post(url, { password: "pw", login: "sam", otherPassword: "wrong" })).status).toBe(401);
    expect((await b.post(url, { password: "wrong", login: "sam", otherPassword: "pw2" })).status).toBe(401);
    expect((await b.get<UserCard[]>(url)).body).toEqual([]);
    expect((await b.post<UserCard[]>(url, { password: "pw", login: "sam", otherPassword: "pw2" })).body.map((u) => u.login)).toEqual(["sam"]);

    await b.post("/api/login", { login: "sam", password: "pw2" });
    expect((await b.get<State>("/api/state")).body.users.map((u) => u.login).sort()).toEqual(["li", "sam"]);
    // Sam's side sees the link too.
    expect((await b.get<UserCard[]>(`/api/u/${rt.sam.id}/links`)).body.map((u) => u.login)).toEqual(["li"]);

    expect((await b.del<UserCard[]>(`${url}/${rt.sam.id}`)).body).toEqual([]);
    expect((await b.get<State>("/api/state")).body.users.map((u) => u.login)).toEqual(["li"]);
  });
});

describe("session IDs", () => {
  it("are never reused for someone new: after Lock, the next login gets a fresh cookie and the old one is dead", async () => {
    const { rt, base } = await setup();
    // The partner copies the cookie on the shared laptop, then Locks.
    const laptop = await login(base, "sam", "pw2");
    const copied = laptop.cookie;
    await laptop.post(`/api/u/${rt.sam.id}/lock`);
    // Ada logs in on that laptop.
    const li = await laptop.post<LoginResponse>("/api/login", { login: "li", password: "pw" });
    expect(li.body.replaced).toBe(false);
    expect(laptop.cookie).not.toBe(copied);
    const thief = browser(base);
    thief.cookie = copied;
    expect((await thief.get<State>("/api/state")).body.users).toEqual([]);
    expect((await thief.get(`/api/u/${rt.li.id}/me`)).status).toBe(401);
  });

  it("change at every login, and a session left empty ends", async () => {
    const { rt, base } = await setup();
    const b = await login(base, "li", "pw");
    const first = b.cookie;
    await b.post("/api/login", { login: "li", password: "pw" });
    expect(b.cookie).not.toBe(first);
    const second = b.cookie;
    await b.post("/api/logout", { userId: rt.li.id });
    const old = browser(base);
    old.cookie = second;
    expect((await old.post("/api/logout", {})).status).toBe(401);
  });

  it("linking by an unknown login says only that something is wrong", async () => {
    const { rt, base } = await setup();
    const b = await login(base, "li", "pw");
    const r = await b.post<{ error: string }>(`/api/u/${rt.li.id}/links`, { password: "pw", login: "nobody", otherPassword: "x" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("a login or password is wrong");
  });
});

describe("staying unlocked after logout", () => {
  it("is on by default; off, logging out drops the key once no other browser holds the user", async () => {
    const { rt, base, d } = await setup();
    const one = await login(base, "li", "pw");
    expect((await one.get<Me>(`/api/u/${rt.li.id}/me`)).body.stayUnlocked).toBe(true);
    await one.post("/api/logout", {});
    expect(d.keyring.hasUserKey(rt.li.id)).toBe(true);

    const a = await login(base, "li", "pw");
    expect((await a.put<Me>(`/api/u/${rt.li.id}/me/stay-unlocked`, { stayUnlocked: false })).body.stayUnlocked).toBe(false);
    const b = await login(base, "li", "pw");
    expect((await a.post<LogoutResponse>("/api/logout", {})).body.stillUnlocked).toEqual([rt.li.id]);
    expect(d.keyring.hasUserKey(rt.li.id)).toBe(true); // still held in the other browser
    expect((await b.post<LogoutResponse>("/api/logout", { userId: rt.li.id })).body.stillUnlocked).toEqual([]);
    expect(d.keyring.hasUserKey(rt.li.id)).toBe(false);
  });

  it("warns when saved credentials would unlock the user at every start anyway", async () => {
    const { rt, base } = await setup();
    const b = await login(base, "li", "pw");
    await b.put(`/api/u/${rt.li.id}/me/stay-unlocked`, { stayUnlocked: false });
    expect((await b.put<Me>(`/api/u/${rt.li.id}/me/credentials`, { save: true })).body.warning).toMatch(/restarts/);
    expect((await b.put<Me>(`/api/u/${rt.li.id}/me/stay-unlocked`, { stayUnlocked: true })).body.warning).toBeUndefined();
  });
});

describe("persona proposals", () => {
  /** A thread view and thread of the user's, as a conversation or dream would have. */
  const threadOf = (d: Awaited<ReturnType<typeof setup>>["d"], userId: string) => {
    const view = d.services!.memory.openThreadView(userId, "general");
    return { view, threadId: view.own.createThread({ interface: "web" }).id };
  };

  it("wait in the originating user's user.db, unseen by administrators, until that user sends them on", async () => {
    const { rt, base, d } = await setup();
    const li = await login(base, "li", "pw");
    const sam = await login(base, "sam", "pw2");
    const proposals = d.services!.proposals;
    const t = threadOf(d, rt.sam.id);
    const secret = "Sam told her about the surprise party for Ada";
    const sams = proposals.propose(t.view, t.threadId, { path: "persona_topics/friends.md", text: secret, reason: "a dream", author: "sleep" });
    expect(sams.sent).toBe(false);

    // The administrator can't list or read it.
    expect((await li.get<PersonaProposal[]>(`/api/u/${rt.li.id}/admin/proposals`)).body).toEqual([]);
    expect((await li.get(`/api/u/${rt.sam.id}/proposals`)).status).toBe(401);

    // Sam edits it, then sends it on: it's marked as sent, and edited, by Sam.
    const drafts = (await sam.get<ProposalDraft[]>(`/api/u/${rt.sam.id}/proposals`)).body;
    expect(drafts).toEqual([expect.objectContaining({ id: sams.id, text: secret })]);
    const edited = (await sam.patch<ProposalDraft>(`/api/u/${rt.sam.id}/proposals/${sams.id}`, { text: "Friends plan surprises for each other." })).body;
    expect(edited.text).toBe("Friends plan surprises for each other.");
    await sam.post(`/api/u/${rt.sam.id}/proposals/${sams.id}/send`);
    expect((await sam.get<ProposalDraft[]>(`/api/u/${rt.sam.id}/proposals`)).body).toEqual([]);
    expect((await li.get<PersonaProposal[]>(`/api/u/${rt.li.id}/admin/proposals`)).body).toEqual([
      expect.objectContaining({ text: "Friends plan surprises for each other.", author: "sleep", sentBy: `user:${rt.sam.id}`, edited: true, stale: false }),
    ]);

    // An administrator's own goes straight to review, unedited.
    const lt = threadOf(d, rt.li.id);
    expect(proposals.propose(lt.view, lt.threadId, { path: "persona_topics/music.md", text: "x", reason: "y", author: "sleep" }).sent).toBe(true);
    expect((await li.get<PersonaProposal[]>(`/api/u/${rt.li.id}/admin/proposals`)).body.at(-1)).toMatchObject({ sentBy: `user:${rt.li.id}`, edited: false });

    // Dropping a draft.
    const another = proposals.propose(t.view, t.threadId, { path: "persona_topics/friends.md", text: "z", reason: "w", author: "sleep" });
    expect((await sam.del(`/api/u/${rt.sam.id}/proposals/${another.id}`)).status).toBe(200);
    expect((await sam.get<ProposalDraft[]>(`/api/u/${rt.sam.id}/proposals`)).body).toEqual([]);
    t.view.close();
    lt.view.close();
  });

  it("come only from the user's own thread view", async () => {
    const { rt, base, d } = await setup();
    await login(base, "sam", "pw2");
    const t = threadOf(d, rt.sam.id);
    const p = { path: "persona_topics/friends.md", text: "x", reason: "y", author: "sleep" };
    expect(() => d.services!.proposals.propose(t.view, "web/nope", p)).toThrow(/own threads/);
    expect(() => d.services!.proposals.propose({ ...t.view } as never, t.threadId, p)).toThrow(/own threads/);
    t.view.close();
  });

  it("aren't approved over newer changes to the file without overwrite", async () => {
    const { rt, base, d } = await setup();
    const li = await login(base, "li", "pw");
    const lt = threadOf(d, rt.li.id);
    const { id } = d.services!.proposals.propose(lt.view, lt.threadId, { path: "SOUL.md", text: "a new soul", reason: "growth", author: "sleep" });
    d.services!.persona.apply(d.services!.users.get(rt.li.id)!, "SOUL.md", "an edit made since");
    const url = `/api/u/${rt.li.id}/admin/proposals`;
    expect((await li.get<PersonaProposal[]>(url)).body[0]).toMatchObject({ id, stale: true });
    const refused = await li.post<{ error: string }>(`${url}/${id}`, { approve: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/changed since/);
    expect((await li.post(`${url}/${id}`, { approve: true, overwrite: true })).status).toBe(200);
    expect(d.services!.persona.files().get("SOUL.md")).toBe("a new soul");
    lt.view.close();
  });
});
