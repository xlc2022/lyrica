import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Me, PersonaProposal, ProposalDraft, State, UserCard } from "../src/api.ts";
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
    expect((await b.post("/api/login", { login: "sam", password: "pw2" })).status).toBe(200);
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
    await a.post("/api/logout", {});
    expect(d.keyring.hasUserKey(rt.li.id)).toBe(true); // still held in the other browser
    await b.post("/api/logout", { userId: rt.li.id });
    expect(d.keyring.hasUserKey(rt.li.id)).toBe(false);
  });
});

describe("persona proposals", () => {
  it("wait in the originating user's user.db, unseen by administrators, until that user sends them on", async () => {
    const { rt, base, d } = await setup();
    const li = await login(base, "li", "pw");
    const sam = await login(base, "sam", "pw2");
    const secret = "Sam told her about the surprise party for Li";
    const sams = d.services!.proposals.propose(d.services!.users.get(rt.sam.id)!, { path: "persona_topics/friends.md", text: secret, reason: "a dream", author: "sleep" });
    expect(sams.sent).toBe(false);

    // The administrator can't list or read it.
    expect((await li.get<PersonaProposal[]>(`/api/u/${rt.li.id}/admin/proposals`)).body).toEqual([]);
    expect((await li.get(`/api/u/${rt.sam.id}/proposals`)).status).toBe(401);
    // It's in Sam's encrypted user.db, not in self.db.
    for (const f of readdirSync(rt.home).filter((x) => x.startsWith("self.db"))) expect(readFileSync(join(rt.home, f)).includes(secret)).toBe(false);

    // Sam edits it, then sends it on.
    const drafts = (await sam.get<ProposalDraft[]>(`/api/u/${rt.sam.id}/proposals`)).body;
    expect(drafts).toEqual([expect.objectContaining({ id: sams.id, text: secret })]);
    const edited = (await sam.patch<ProposalDraft>(`/api/u/${rt.sam.id}/proposals/${sams.id}`, { text: "Friends plan surprises for each other." })).body;
    expect(edited.text).toBe("Friends plan surprises for each other.");
    await sam.post(`/api/u/${rt.sam.id}/proposals/${sams.id}/send`);
    expect((await sam.get<ProposalDraft[]>(`/api/u/${rt.sam.id}/proposals`)).body).toEqual([]);
    expect((await li.get<PersonaProposal[]>(`/api/u/${rt.li.id}/admin/proposals`)).body.map((p) => p.text)).toEqual(["Friends plan surprises for each other."]);

    // An administrator's own goes straight to review.
    expect(d.services!.proposals.propose(d.services!.users.get(rt.li.id)!, { path: "persona_topics/music.md", text: "x", reason: "y", author: "sleep" }).sent).toBe(true);
    expect((await li.get<PersonaProposal[]>(`/api/u/${rt.li.id}/admin/proposals`)).body).toHaveLength(2);

    // Dropping a draft.
    const another = d.services!.proposals.propose(d.services!.users.get(rt.sam.id)!, { path: "persona_topics/friends.md", text: "z", reason: "w", author: "sleep" });
    expect((await sam.del(`/api/u/${rt.sam.id}/proposals/${another.id}`)).status).toBe(200);
    expect((await sam.get<ProposalDraft[]>(`/api/u/${rt.sam.id}/proposals`)).body).toEqual([]);
  });
});
