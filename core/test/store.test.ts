import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isThreadView, Memory, readView, searchView, Users, type PoolStore } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
  await users.authenticate("li", "pw");
  return { keyring, users, li, memory: new Memory(keyring, users) };
}

/** A logged thread with one user message, for notes to cite. */
function said(store: PoolStore, text: string, opts: { unlogged?: boolean } = {}) {
  const thread = store.createThread({ interface: "cli", unlogged: opts.unlogged });
  const entry = store.appendEntry(thread.id, { piId: "a1", role: "user", data: { type: "message" }, text });
  return { thread: thread.id, entry };
}

describe("the privacy boundary", () => {
  it("never lets a general view read, search or cite private memory", async () => {
    const { memory, li } = await setup();
    const priv = memory.openThreadView(li.id, "private");
    const p = said(priv.own, "the diagnosis came back");
    const [secret] = priv.own.addNotes([{ text: "{user} has a quiet diagnosis", source: p.entry }], { author: "lyrica", thread: p.thread });

    const general = memory.openThreadView(li.id, "general");
    expect(general.pool).toBe("general");
    expect(general.own.pool).toBe("general");
    expect(general.reads).toEqual([]);
    expect(searchView(general, "diagnosis")).toEqual([]);
    expect(readView(general, `private/${secret}`)).toBeUndefined();
    expect(readView(general, secret!)).toBeUndefined();
    expect(readView(general, `private/${p.entry}`)).toBeUndefined();
    const g = said(general.own, "hello");
    expect(() => general.own.addNotes([{ text: `see [private/${secret}]` }], { author: "lyrica", thread: g.thread }))
      .toThrow(/can't cite private/);
    general.close();
    priv.close();
  });

  it("lets private read general but write only private", async () => {
    const { memory, li } = await setup();
    const general = memory.openThreadView(li.id, "general");
    const g = said(general.own, "Satie on the piano");
    const [note] = general.own.addNotes([{ text: "{user} plays Satie", source: g.entry }], { author: "lyrica", thread: g.thread });

    const priv = memory.openThreadView(li.id, "private");
    expect(priv.reads.map((r) => r.pool)).toEqual(["general"]);
    expect(searchView(priv, "Satie").map((h) => h.id)).toContain(`general/${note}`);
    expect(readView(priv, `general/${note}`)?.item?.text).toMatch(/^Li plays Satie/);

    const p = said(priv.own, "private aside");
    const [mine] = priv.own.addNotes([{ text: `builds on [general/${note}]`, source: p.entry }], { author: "lyrica", thread: p.thread });
    expect(priv.own.cameFrom(mine!)).toContain(`general/${note}`);
    expect(general.own.get(mine!)).toBeUndefined();
    // The general handle in a private view is a read-only connection.
    const raw = (priv.reads[0] as unknown as { db: { exec(sql: string): void } }).db;
    expect(() => raw.exec("DELETE FROM notes")).toThrow(/readonly/);
    expect(general.own.get(note!)).toBeDefined();
    priv.close();
    general.close();
  });

  it("keeps the owner view out of sessions", async () => {
    const { memory, li } = await setup();
    const owner = memory.openOwnerView(li.id);
    const view = memory.openThreadView(li.id, "general");
    expect(isThreadView(view)).toBe(true);
    expect(isThreadView(owner)).toBe(false);
    expect(isThreadView({ ...view })).toBe(false);
    expect(() => owner.general.addNotes([{ text: "x" }], { author: "lyrica" })).toThrow(/owner view/);
    expect(() => view.own.addNotes([{ text: "x" }], { author: `user:${li.id}` })).toThrow(/thread view/);
    owner.close();
    view.close();
  });
});

describe("unlogged threads", () => {
  it("are never indexed, can't write notes, and pass that on to daughters", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const u = said(own, "the zeppelin surprise party", { unlogged: true });
    expect(own.search("zeppelin")).toEqual([]);
    expect(() => own.addNotes([{ text: "party", source: u.entry }], { author: "lyrica", thread: u.thread })).toThrow(/isn't logged/);

    const daughter = own.createThread({ interface: "cli", parent: u.thread });
    expect(daughter.unlogged).toBe(true);
    expect(() => own.setUnlogged(daughter.id, false)).toThrow(/parent/);
    own.appendEntry(daughter.id, { piId: "d1", role: "user", data: {}, text: "zeppelin again" });
    expect(own.search("zeppelin")).toEqual([]);
    expect(own.exportThread(u.thread, "web").unlogged).toBe(true);
  });

  it("don't expose earlier entries when logging is turned on later", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const u = said(own, "the zeppelin surprise party", { unlogged: true });
    own.setUnlogged(u.thread, false);
    const later = own.appendEntry(u.thread, { piId: "a2", role: "user", data: {}, text: "the zeppelin cake" });
    expect(own.search("zeppelin").map((h) => h.id)).toEqual([later]);
    expect(own.entryWindow(u.entry, 4, "elsewhere").map((e) => e.id)).toEqual([later]);
    expect(own.entryWindow(u.entry, 4, u.thread)).toHaveLength(2);
  });
});

describe("notes", () => {
  it("round-trip mentions, and a rename changes rendering and search with no rewrite", async () => {
    const { memory, users, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "I love Satie");
    const [id] = own.addNotes([{ text: "{user} loves Satie; play {user:obj} Gymnopédies", about: ["music"], source: s.entry }], { author: "lyrica", thread: s.thread });
    expect(own.get(id!, { raw: true })!.text).toBe(`[[u:${li.id}]] loves Satie; play [[u:${li.id}:obj]] Gymnopédies [${s.entry}]`);
    expect(own.get(id!)!.text).toBe(`Li loves Satie; play her Gymnopédies [${s.entry}]`);
    expect(own.cameFrom(id!)).toEqual([s.entry]);
    expect(own.search("Li").map((h) => h.id)).toContain(id);

    users.updateProfile(li, li, { displayName: "Lin", pronouns: { subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themself" } });
    expect(own.get(id!)!.text).toBe(`Lin loves Satie; play them Gymnopédies [${s.entry}]`);
    expect(own.search("Lin").map((h) => h.id)).toContain(id);
    expect(own.search("Li").map((h) => h.id)).toContain(id); // a previous name
    expect(own.revisions(id!)).toHaveLength(1);
  });

  it("finds 'Li-ion' literally as well as by name", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "batteries");
    const [battery, tea] = own.addNotes([
      { text: "The drone uses a Li-ion battery", source: s.entry },
      { text: "{user} drinks green tea", source: s.entry },
    ], { author: "lyrica", thread: s.thread });
    expect(own.search("Li-ion")[0]!.id).toBe(battery);
    expect(own.search("what does Li drink?").map((h) => h.id)).toContain(tea);
  });

  it("supersedes without losing the old note", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "moving");
    const [old] = own.addNotes([{ text: "{user} lives in Vienna", source: s.entry }], { author: "lyrica", thread: s.thread });
    const [fresh] = own.addNotes([{ text: "{user} lives in Graz now", supersedes: [old!], source: s.entry }], { author: "lyrica", thread: s.thread });
    expect(own.get(old!)!.supersededBy).toBe(fresh);
    expect(own.search("lives", { current: true }).map((h) => h.id)).toEqual([fresh]);
    expect(own.search("lives").map((h) => h.id).sort()).toEqual([fresh, old].sort());
  });
});

describe("editing", () => {
  it("keeps tokens, updates citations and search, and restores from revisions", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "homelab");
    const [a, b] = own.addNotes([{ text: "three nodes", source: s.entry }, { text: "node two backups", source: s.entry }], { author: "lyrica", thread: s.thread });
    own.putPage({ slug: "homelab", title: "Homelab", summary: "{user}'s Proxmox cluster", text: `Three nodes [${a}].` }, "sleep");

    const owner = memory.openOwnerView(li.id);
    const stored = owner.general.get("p:homelab", { raw: true })!;
    owner.general.edit("p:homelab", { text: `[[u:${li.id}]] runs three nodes [${b}]; {user:poss} NAS is old.` }, `user:${li.id}`);
    const edited = owner.general.get("p:homelab", { raw: true })!;
    expect(edited.text).toBe(`[[u:${li.id}]] runs three nodes [${b}]; [[u:${li.id}:poss]] NAS is old.`);
    expect(edited.summary).toBe(stored.summary);
    expect(own.cameFrom("p:homelab")).toEqual([b]);
    expect(own.usedIn(a!)).toEqual([]);
    expect(own.usedIn(b!)).toEqual(["p:homelab"]);
    expect(own.search("NAS").map((h) => h.id)).toEqual(["p:homelab"]);
    expect(owner.general.editedSince("2000-01-01").map((e) => e.id)).toEqual(["p:homelab"]);

    const [first, second] = own.revisions("p:homelab");
    expect([first!.author, second!.author]).toEqual(["sleep", `user:${li.id}`]);
    owner.general.restore("p:homelab", first!.id, `user:${li.id}`);
    expect(own.get("p:homelab")!.text).toBe(`Three nodes [${a}].`);
    expect(own.revisions("p:homelab")).toHaveLength(3);
    expect(own.usedIn(a!)).toEqual(["p:homelab"]);
    expect(own.search("NAS")).toEqual([]);
    owner.close();
  });

  it("lets WAKE and the journal be edited too", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    own.putWake("Li is moving next week.", "sleep");
    const j = own.addJournal("A dream about trains.", "sleep");
    const owner = memory.openOwnerView(li.id);
    owner.general.edit("wake", { text: "Li moved last week." }, `user:${li.id}`);
    owner.general.edit(j, { text: "A dream about boats." }, `user:${li.id}`);
    expect(own.getWake()).toBe("Li moved last week.");
    expect(own.listJournal()[0]!.text).toBe("A dream about boats.");
    expect(own.revisions("wake")).toHaveLength(2);
    owner.close();
  });
});

describe("user-introduced memories", () => {
  it("are recalled with their author and show up in lineage", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "about the garden");
    const owner = memory.openOwnerView(li.id);
    const [linked, free] = owner.general.addNotes([
      { text: `The tomatoes went in on 3 May [t:${s.thread}]` },
      { text: "My grandmother's tomato soup recipe uses fennel" },
    ], { author: `user:${li.id}` });

    const hits = own.search("tomato tomatoes");
    expect(hits.map((h) => h.id).sort()).toEqual([linked, free].sort());
    expect(hits.every((h) => h.origin === "user" && h.author === `user:${li.id}`)).toBe(true);
    expect(own.cameFrom(linked!)).toEqual([`t:${s.thread}`]);
    expect(own.usedIn(`t:${s.thread}`)).toEqual([linked]);
    expect(own.cameFrom(free!)).toEqual([]);
    expect(owner.general.userIntroduced().sort()).toEqual([linked, free].sort());

    expect(() => own.edit(free!, { text: "changed" }, "sleep")).toThrow(/only be changed by the user/);
    expect(() => own.delete(free!, "sleep")).toThrow(/only be deleted by the user/);
    owner.close();
  });
});

describe("deletion", () => {
  it("removes text and revisions, leaves a text-free tombstone and flags citing pages", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "the gift");
    const [gift] = own.addNotes([{ text: "{user} is getting a red bicycle", source: s.entry }], { author: "lyrica", thread: s.thread });
    own.putPage({ slug: "gifts", title: "Gifts", summary: "ideas", text: `A bicycle [${gift}].` }, "sleep");
    own.edit(gift!, { text: "{user} is getting a blue bicycle" }, "lyrica");

    own.delete(gift!, "lyrica");
    expect(own.get(gift!)).toBeUndefined();
    expect(own.revisions(gift!)).toEqual([]);
    expect(own.search("bicycle").map((h) => h.id)).toEqual(["p:gifts"]);
    expect(own.get("p:gifts")!.flagged).toBe(true);
    expect(own.isTombstoned(s.entry)).toBe(true);
    const db = (own as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
    const tomb = db.prepare("SELECT * FROM tombstones WHERE id = ?").get(gift) as Record<string, string>;
    expect(Object.keys(tomb).sort()).toEqual(["deleted_at", "deleted_by", "id", "kind", "sources"]);
    expect(JSON.stringify(tomb)).not.toMatch(/bicycle/);
  });

  it("forgets a thread with the notes that came only from it", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const a = said(own, "first");
    const b = said(own, "second");
    const [only, both] = own.addNotes([
      { text: "only from a", source: a.entry },
      { text: `from both [${b.entry}]`, source: a.entry },
    ], { author: "lyrica", thread: a.thread });
    own.forgetThread(a.thread, "lyrica");
    expect(own.getThread(a.thread)).toBeUndefined();
    expect(own.get(only!)).toBeUndefined();
    expect(own.get(both!)).toBeDefined();
    expect(own.search("first")).toEqual([]);
    expect(own.isTombstoned(a.entry)).toBe(true);
  });

  it("deletes the matches of a search in bulk", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "ex");
    own.addNotes([{ text: "Sam likes jazz", source: s.entry }, { text: "Sam moved away", source: s.entry }, { text: "jazz is fine" }], { author: "lyrica", thread: s.thread });
    own.deleteMany(own.search("Sam").map((h) => h.id), "lyrica");
    expect(own.search("Sam")).toEqual([]);
    expect(own.search("jazz")).toHaveLength(1);
  });
});

describe("threads", () => {
  it("export copies keep entry IDs and aren't indexed twice", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    const s = said(own, "the harbour at dawn");
    const copy = own.exportThread(s.thread, "web");
    expect(copy.parent).toBe(s.thread);
    expect(own.loadEntries(copy.id)).toEqual(own.loadEntries(s.thread));
    expect(own.lastEntry(copy.id)!.id).toBe(s.entry);
    expect(own.search("harbour").map((h) => h.id)).toEqual([s.entry]);
  });

  it("brings back pages about granted folders", async () => {
    const { memory, li } = await setup();
    const { own } = memory.openThreadView(li.id, "general");
    own.putPage({ slug: "site", title: "Website", summary: "Li's site", text: "Astro.", folders: ["/srv/site"] }, "sleep");
    own.putPage({ slug: "other", title: "Other", summary: "x", text: "y" }, "sleep");
    expect(own.forFolders(["/srv/site/src"]).map((p) => p.id)).toEqual(["p:site"]);
    expect(own.forFolders(["/srv/site/"]).map((p) => p.id)).toEqual(["p:site"]);
    expect(own.forFolders(["/srv"])).toEqual([]);
    expect(own.pageIndex().map((p) => p.id).sort()).toEqual(["p:other", "p:site"]);
  });
});

describe("on disk", () => {
  it("holds no memory or thread text in plaintext", async () => {
    const { memory, users, li } = await setup();
    const view = memory.openThreadView(li.id, "private");
    const s = said(view.own, "MARKERTHREADTEXT");
    view.own.addNotes([{ text: "MARKERNOTETEXT", source: s.entry }], { author: "lyrica", thread: s.thread });
    view.own.putPage({ slug: "p", title: "MARKERPAGE", summary: "s", text: "t" }, "sleep");
    const general = memory.openThreadView(li.id, "general");
    said(general.own, "MARKERGENERAL");
    const dir = users.userDir(li.id);
    const files = readdirSync(dir);
    expect(files).toEqual(expect.arrayContaining(["general.db", "private.db"]));
    for (const f of files) expect(readFileSync(join(dir, f)).toString("latin1")).not.toMatch(/MARKER/);
    view.close();
    general.close();
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).toString("latin1")).not.toMatch(/MARKER/);
  });
});
