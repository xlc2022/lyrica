import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isThreadView, Memory, projectSlug, readView, searchView, Users, type PoolStore } from "../src/index.ts";
import { stem } from "../src/store/refs.ts";
import { freshKeyring, profile } from "./helpers.ts";

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Al"), { admin: true });
  await users.authenticate("ada", "pw");
  return { keyring, users, ada, memory: new Memory(keyring, users) };
}

/** A logged thread with one user message, for notes to cite. */
function said(store: PoolStore, text: string, opts: { unlogged?: boolean } = {}) {
  const thread = store.createThread({ interface: "cli", unlogged: opts.unlogged });
  const entry = store.appendEntry(thread.id, { piId: "a1", role: "user", data: { type: "message" }, text });
  return { thread: thread.id, entry };
}

describe("the privacy boundary", () => {
  it("never lets a general view read, search or cite private memory", async () => {
    const { memory, ada } = await setup();
    const priv = memory.openThreadView(ada.id, "private");
    const p = said(priv.own, "the diagnosis came back");
    const [secret] = priv.own.addNotes([{ text: "{user} has a quiet diagnosis", source: p.entry }], { author: "lyrica", thread: p.thread });

    const general = memory.openThreadView(ada.id, "general");
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
    const { memory, ada } = await setup();
    const general = memory.openThreadView(ada.id, "general");
    const g = said(general.own, "Satie on the piano");
    const [note] = general.own.addNotes([{ text: "{user} plays Satie", source: g.entry }], { author: "lyrica", thread: g.thread });

    const priv = memory.openThreadView(ada.id, "private");
    expect(priv.reads.map((r) => r.pool)).toEqual(["general"]);
    expect(searchView(priv, "Satie").map((h) => h.id)).toContain(`general/${note}`);
    expect(readView(priv, `general/${note}`)?.item?.text).toMatch(/^Al plays Satie/);

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
    const { memory, ada } = await setup();
    const owner = memory.openOwnerView(ada.id);
    const view = memory.openThreadView(ada.id, "general");
    expect(isThreadView(view)).toBe(true);
    expect(isThreadView(owner)).toBe(false);
    expect(isThreadView({ ...view })).toBe(false);
    expect(() => owner.general.addNotes([{ text: "x" }], { author: "lyrica" })).toThrow(/owner view/);
    expect(() => view.own.addNotes([{ text: "x" }], { author: `user:${ada.id}` })).toThrow(/thread view/);
    owner.close();
    view.close();
  });
});

describe("unlogged threads", () => {
  it("are never indexed, can't write notes, and pass that on to daughters", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
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
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
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
    const { memory, users, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "I love Satie");
    const [id] = own.addNotes([{ text: "{user} loves Satie; play {user:obj} Gymnopédies", about: ["music"], source: s.entry }], { author: "lyrica", thread: s.thread });
    expect(own.get(id!, { raw: true })!.text).toBe(`[[u:${ada.id}]] loves Satie; play [[u:${ada.id}:obj]] Gymnopédies [${s.entry}]`);
    expect(own.get(id!)!.text).toBe(`Al loves Satie; play her Gymnopédies [${s.entry}]`);
    expect(own.cameFrom(id!)).toEqual([s.entry]);
    expect(own.search("Al").map((h) => h.id)).toContain(id);

    users.updateProfile(ada, ada, { displayName: "Lin", pronouns: { subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themself" } });
    expect(own.get(id!)!.text).toBe(`Lin loves Satie; play them Gymnopédies [${s.entry}]`);
    expect(own.search("Lin").map((h) => h.id)).toContain(id);
    expect(own.search("Al").map((h) => h.id)).toContain(id); // a previous name
    expect(own.revisions(id!)).toHaveLength(1);
  });

  it("finds 'Al-ion' literally as well as by name", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "batteries");
    const [battery, tea] = own.addNotes([
      { text: "The drone uses an Al-ion battery", source: s.entry },
      { text: "{user} drinks green tea", source: s.entry },
    ], { author: "lyrica", thread: s.thread });
    expect(own.search("Al-ion")[0]!.id).toBe(battery);
    expect(own.search("what does Al drink?").map((h) => h.id)).toContain(tea);
  });

  it("automatic recall leaves out her name and needs more than one shared word", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "branches");
    const [branch, body, tea] = own.addNotes([
      { text: "The test repo's default branch is still lyrica-relay-test", source: s.entry },
      { text: "{user} asked whether Lyrica has a body", source: s.entry },
      { text: "{user} drinks green tea in the morning", source: s.entry },
    ], { author: "lyrica", thread: s.thread });
    const auto = { minWords: 2, skip: ["Lyrica"] };
    // Before: her name alone brought up the branch.
    expect(own.search("Hi Lyrica, do you have a body?").map((h) => h.id)).toContain(branch);
    expect(own.search("Hi Lyrica, do you have a body?", auto).map((h) => h.id)).toEqual([body]);
    // One shared word out of several isn't enough; a name counts once, by its mention token.
    expect(own.search("what test should we run in the morning", auto)).toEqual([]);
    expect(own.search("what does Al drink these days?", auto).map((h) => h.id)).toEqual([tea]);
    expect(own.search("Lyrica", auto)).toEqual([]);
    expect(own.search("tea", auto)[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("automatic recall finds what was said, not tool calls or their results", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const thread = own.createThread({ interface: "cli" }).id;
    const add = (role: string, content: unknown, text: string) =>
      own.appendEntry(thread, { piId: `p${text.length}`, role, data: { type: "message", message: { role, content } }, text });
    const call = add("assistant", [{ type: "toolCall", name: "threads", arguments: { task: "paint the garden fence green" } }], 'threads({"task":"paint the garden fence green"})');
    const result = add("toolResult", [{ type: "text", text: "garden fence painted green" }], "threads: garden fence painted green");
    const spoken = add("assistant", [{ type: "text", text: "The garden fence is green now." }, { type: "toolCall", name: "bash", arguments: { command: "paint" } }], "The garden fence is green now.\nbash({\"command\":\"paint\"})");
    const auto = { minWords: 2, said: true };
    expect(own.search("garden fence green").map((h) => h.id).sort()).toEqual([call, result, spoken].sort());
    expect(own.search("garden fence green", auto).map((h) => h.id)).toEqual([spoken]);
    expect(own.search("garden fence green", auto)[0]!.snippet).toBe("The garden fence is green now.");
    // A message that matches only through its tool call isn't recalled.
    expect(own.search("paint command").map((h) => h.id)).toContain(spoken);
    expect(own.search("paint command", auto)).toEqual([]);
  });

  it("automatic recall matches on what a message is about, not its filler, and a word by its stem", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "notes");
    const [, trying, , , dentist, recipe] = own.addNotes([
      { text: "{user} sometimes skips breakfast", source: s.entry },
      { text: "{user} is trying to read more fiction this year", source: s.entry },
      { text: "{user} doesn't like cilantro", source: s.entry },
      { text: "{user} grows thyme on the balcony", source: s.entry },
      { text: "{user} should call the dentist about something", source: s.entry },
      { text: "{user}'s favourite recipe is mushroom risotto", source: s.entry },
    ], { author: "lyrica", thread: s.thread });
    const auto = { minWords: 2, skip: ["Lyrica"], said: true, current: true, limit: 5 };
    // "some", "should" and "try" say nothing about the question, and "some" isn't the start of "something".
    expect(own.search("Hi! What are some interesting recipes I should try?", auto).map((h) => h.id)).toEqual([recipe]);
    expect(own.search("Should I try something new?", auto)).toEqual([]);
    // A deliberate search (the browser, the recall tool) for filler alone still searches it.
    expect(own.search("something").map((h) => h.id)).toEqual([dentist]);
    // A word with an ending finds its stem: "recipes" finds "recipe", "tried" finds "trying" only by a word that isn't filler.
    expect(own.search("mushroom recipes", auto).map((h) => h.id)).toEqual([recipe]);
    expect(own.search("fiction books", auto).map((h) => h.id)).toEqual([trying]);
    expect(own.search("dentist appointments", auto).map((h) => h.id)).toEqual([dentist]);
    expect(["recipes", "dishes", "shapes", "classes", "interesting", "roasted", "batteries", "try", "some", "glass"].map(stem))
      .toEqual(["recipe", "dish", "shape", "class", "interest", "roast", "batteri", undefined, undefined, undefined]);
  });

  it("recalls by meaning as well as by words: rank fusion, the keyword rules kept, one model's index", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "notes");
    const [cilantro, thyme, trains, recipe] = own.addNotes([
      { text: "{user} doesn't like cilantro", source: s.entry },
      { text: "{user} grows thyme on the balcony", source: s.entry },
      { text: "{user} finds trains interesting", source: s.entry },
      { text: "{user}'s favourite recipe is mushroom risotto", source: s.entry },
    ], { author: "lyrica", thread: s.thread });
    const vec = (xs: number[]) => Float32Array.from(xs);
    const food = vec([1, 0, 0, 0]), rail = vec([0, 1, 0, 0]), other = vec([0, 0, 0, 1]);
    const model = "toy-embed";
    // What the embedder would list: every indexed item, the message by its spoken words.
    const pending = own.unembedded(model, 10);
    expect(pending.map((p) => p.id).sort()).toEqual([cilantro, thyme, trains, recipe, s.entry].sort());
    // The fixture's message carries no content, so it is listed with no text, for the embedder to mark skipped.
    expect(pending.find((p) => p.id === s.entry)!.text).toBe("");
    own.putVectors(model, [
      { id: cilantro!, kind: "note", vec: food }, { id: thyme!, kind: "note", vec: food }, { id: trains!, kind: "note", vec: rail },
      { id: recipe!, kind: "note", vec: food }, { id: s.entry, kind: "entry" },
    ]);
    expect(own.unembedded(model, 10)).toEqual([]);
    expect(own.vectorCount(model)).toEqual({ done: 5, left: 0 });
    const auto = { minWords: 2, said: true, current: true, limit: 5 };
    const query = "Hi! What are some interesting recipes I should try?";
    // Words alone: "recipes" and "interesting". With the vector: the recipe first, found both ways, then the food notes that share no word with the question beside the trains.
    expect(own.search(query, auto).map((h) => h.id).sort()).toEqual([recipe, trains].sort());
    const fused = own.search(query, { ...auto, vector: { model, values: food } }).map((h) => h.id);
    expect(fused[0]).toBe(recipe);
    expect(fused.slice(1).sort()).toEqual([cilantro, thyme, trains].sort());
    // A vector below the floor brings nothing by meaning; a message of only filler recalls nothing by words.
    expect(own.search("Should I try something new?", { ...auto, vector: { model, values: other } })).toEqual([]);
    expect(own.search("Should I try something new?", { ...auto, vector: { model, values: vec([0.6, 0, 0, 0.8]) } }).map((h) => h.id).sort()).toEqual([cilantro, thyme, recipe].sort());
    // Another model's vector finds nothing in this index; storing its vectors replaces the index.
    expect(own.search(query, { ...auto, vector: { model: "other-embed", values: food } }).map((h) => h.id).sort()).toEqual([recipe, trains].sort());
    own.putVectors("other-embed", [{ id: trains!, kind: "note", vec: rail }]);
    expect(own.vectorCount("other-embed")).toEqual({ done: 1, left: 4 });
    expect(own.unembedded(model, 10)).toHaveLength(5);
    // A deleted or rewritten memory loses its vector.
    own.putVectors(model, [{ id: cilantro!, kind: "note", vec: food }, { id: thyme!, kind: "note", vec: food }]);
    own.delete(cilantro!, "lyrica");
    own.edit(thyme!, { text: "{user} grows thyme and basil on the balcony" }, "lyrica");
    expect(own.nearest(model, food, 10).map((n) => n.id)).toEqual([]);
    expect(own.unembedded(model, 10).map((p) => p.id)).toContain(thyme);
  });

  it("automatic recall doesn't count words common in her memory", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "plans");
    for (let i = 0; i < 30; i++) said(own, `create one more thing, number ${i}`);
    const [brief, fox] = own.addNotes([
      { text: "Create another one: a brief for the sidebar fix", source: s.entry },
      { text: "{user} wants another picture of the red fox", source: s.entry },
    ], { author: "lyrica", thread: s.thread });
    const auto = { minWords: 2 };
    // "create" and "one" are in most of her memory: they can't carry a match on their own.
    expect(own.search("Create another one of a fox").map((h) => h.id)).toContain(brief);
    expect(own.search("Create another one of a fox", auto).map((h) => h.id)).toEqual([fox]);
    expect(own.search("Create one", auto)).toEqual([]);
  });

  it("counts a message from another of her threads as hers, not the person's", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const brief = said(own, "[From t:web/1a2b3c4d]\n\nImplement the zebra crossing fix");
    const theirs = said(own, "Please look at the zebra crossing");
    expect(own.get(brief.entry)!.origin).toBe("lyrica");
    expect(own.get(theirs.entry)!.origin).toBe("user");
    expect(Object.fromEntries(own.search("zebra crossing").map((h) => [h.id, h.origin]))).toEqual({ [brief.entry]: "lyrica", [theirs.entry]: "user" });
  });

  it("supersedes without losing the old note", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "moving");
    const [old] = own.addNotes([{ text: "{user} lives in Vienna", source: s.entry }], { author: "lyrica", thread: s.thread });
    const [fresh] = own.addNotes([{ text: "{user} lives in Graz now", supersedes: [old!], source: s.entry }], { author: "lyrica", thread: s.thread });
    expect(own.get(old!)!.supersededBy).toBe(fresh);
    expect(own.search("lives", { current: true }).map((h) => h.id)).toEqual([fresh]);
    expect(own.search("lives").map((h) => h.id).sort()).toEqual([fresh, old].sort());
  });

  it("removes superseded notes nothing cites once their replacement is old enough, with no tombstone, keeping cited and user notes", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "pull requests");
    const add = (text: string, supersedes?: string[]) => own.addNotes([{ text, source: s.entry, supersedes }], { author: "lyrica", thread: s.thread })[0]!;
    const step1 = add("PR 12 is waiting on CI");
    const step2 = add("PR 12 has review findings");
    const cited = add("PR 12 taught that e2e needs a built web");
    own.putPage({ slug: "lessons", title: "Lessons", summary: "what PRs taught", text: `Build first [${cited}].` }, "sleep");
    const owner = memory.openOwnerView(ada.id);
    const mine = owner.general.addNotes([{ text: "PR 12 is mine to merge" }], { author: `user:${ada.id}` })[0]!;
    owner.close();
    const folded = add(`PR 12 merged; e2e needs a built web [${step1}]`);
    own.supersede([step2], step1, "sleep");
    expect(() => own.supersede([mine], folded, "sleep")).toThrow(/added by a user/);
    own.supersede([step1, cited], folded, "sleep");
    expect(own.get("p:lessons")).toMatchObject({ flagged: true });

    // Too recent: nothing goes.
    expect(own.pruneSuperseded("2000-01-01T00:00:00Z")).toBe(0);
    expect(own.pruneSuperseded(new Date(Date.now() + 1000).toISOString())).toBe(2);
    expect(own.get(step1)).toBeUndefined();
    expect(own.get(step2)).toBeUndefined();
    expect(own.isTombstoned(s.entry)).toBe(false);
    expect(own.search("waiting review", {}).map((h) => h.id)).toEqual([]);
    // Still cited by a page, so it stays until the page cites the folded note.
    expect(own.get(cited)).toMatchObject({ supersededBy: folded });
    expect(own.get(folded)!.supersededBy).toBeUndefined();
    own.putPage({ slug: "lessons", title: "Lessons", summary: "what PRs taught", text: `Build first [${folded}].` }, "sleep");
    expect(own.pruneSuperseded(new Date(Date.now() + 1000).toISOString())).toBe(1);
    expect(own.get(cited)).toBeUndefined();
  });
});

describe("editing", () => {
  it("keeps tokens, updates citations and search, and restores from revisions", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "homelab");
    const [a, b] = own.addNotes([{ text: "three nodes", source: s.entry }, { text: "node two backups", source: s.entry }], { author: "lyrica", thread: s.thread });
    own.putPage({ slug: "homelab", title: "Homelab", summary: "{user}'s Proxmox cluster", text: `Three nodes [${a}].` }, "sleep");

    const owner = memory.openOwnerView(ada.id);
    const stored = owner.general.get("p:homelab", { raw: true })!;
    owner.general.edit("p:homelab", { text: `[[u:${ada.id}]] runs three nodes [${b}]; {user:poss} NAS is old.` }, `user:${ada.id}`);
    const edited = owner.general.get("p:homelab", { raw: true })!;
    expect(edited.text).toBe(`[[u:${ada.id}]] runs three nodes [${b}]; [[u:${ada.id}:poss]] NAS is old.`);
    expect(edited.summary).toBe(stored.summary);
    expect(own.cameFrom("p:homelab")).toEqual([b]);
    expect(own.usedIn(a!)).toEqual([]);
    expect(own.usedIn(b!)).toEqual(["p:homelab"]);
    expect(own.search("NAS").map((h) => h.id)).toEqual(["p:homelab"]);
    expect(owner.general.editedSince("2000-01-01").map((e) => e.id)).toEqual(["p:homelab"]);

    const [first, second] = own.revisions("p:homelab");
    expect([first!.author, second!.author]).toEqual(["sleep", `user:${ada.id}`]);
    owner.general.restore("p:homelab", first!.id, `user:${ada.id}`);
    expect(own.get("p:homelab")!.text).toBe(`Three nodes [${a}].`);
    expect(own.revisions("p:homelab")).toHaveLength(3);
    expect(own.usedIn(a!)).toEqual(["p:homelab"]);
    expect(own.search("NAS")).toEqual([]);
    owner.close();
  });

  it("lets WAKE and the journal be edited too", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    own.putWake("Al is moving next week.", "sleep");
    const j = own.addJournal("A dream about trains.", "sleep");
    const owner = memory.openOwnerView(ada.id);
    owner.general.edit("wake", { text: "Al moved last week." }, `user:${ada.id}`);
    owner.general.edit(j, { text: "A dream about boats." }, `user:${ada.id}`);
    expect(own.getWake()).toBe("Al moved last week.");
    expect(own.listJournal()[0]!.text).toBe("A dream about boats.");
    expect(own.revisions("wake")).toHaveLength(2);
    owner.close();
  });
});

describe("user-introduced memories", () => {
  it("are recalled with their author and show up in lineage", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "about the garden");
    const owner = memory.openOwnerView(ada.id);
    const [linked, free] = owner.general.addNotes([
      { text: `The tomatoes went in on 3 May [t:${s.thread}]` },
      { text: "My grandmother's tomato soup recipe uses fennel" },
    ], { author: `user:${ada.id}` });

    const hits = own.search("tomato tomatoes");
    expect(hits.map((h) => h.id).sort()).toEqual([linked, free].sort());
    expect(hits.every((h) => h.origin === "user" && h.author === `user:${ada.id}`)).toBe(true);
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
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
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
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const a = said(own, "first");
    const b = said(own, "second");
    const [only, both] = own.addNotes([
      { text: "only from a", source: a.entry },
      { text: `from both [${b.entry}]`, source: a.entry },
    ], { author: "lyrica", thread: a.thread });
    const sub = own.createThread({ interface: "cli", parent: a.thread, subagent: true });
    const copy = own.exportThread(a.thread, "web");
    own.setDraft(a.thread, "unsent words");
    own.forgetThread(a.thread, "lyrica");
    expect(own.getThread(a.thread)).toBeUndefined();
    expect(own.draft(a.thread)).toBeUndefined();
    expect(own.getThread(sub.id)).toBeUndefined();
    expect(own.getThread(copy.id)).toBeDefined();
    expect(own.get(only!)).toBeUndefined();
    expect(own.get(both!)).toBeDefined();
    expect(own.search("first")).toEqual([]);
    expect(own.isTombstoned(a.entry)).toBe(true);
  });

  it("keeps the notes of a thread forgotten with keepMemories, and leaves a text-free thread tombstone", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const a = said(own, "the harbour at dawn");
    const [kept] = own.addNotes([{ text: "{user} likes the harbour", source: a.entry }], { author: "lyrica", thread: a.thread });
    const sub = own.createThread({ interface: "cli", parent: a.thread, subagent: true });
    own.forgetThread(a.thread, "lyrica", { keepMemories: true });
    expect(own.getThread(a.thread)).toBeUndefined();
    expect(own.getThread(sub.id)).toBeUndefined();
    expect(own.loadEntries(a.thread)).toEqual([]);
    expect(own.get(kept!)).toBeDefined();
    expect(own.search("harbour").map((h) => h.id)).toEqual([kept]);
    expect(own.getThreadTombstone(a.thread)).toEqual({ deletedAt: expect.any(String) });
    expect(own.getThreadTombstone(sub.id)).toBeDefined();
    expect(own.citingThread(a.thread)).toEqual([kept]);
    const db = (own as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
    const tomb = db.prepare("SELECT * FROM tombstones WHERE id = ?").get(`t:${a.thread}`) as Record<string, string>;
    expect(tomb.kind).toBe("thread");
    expect(tomb.sources).toBe("[]");
    expect(Object.keys(tomb).sort()).toEqual(["deleted_at", "deleted_by", "id", "kind", "sources"]);
    expect(own.isTombstoned(a.entry)).toBe(false);
  });

  it("a thread forgotten without keepMemories leaves no thread tombstone", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const a = said(own, "first");
    own.forgetThread(a.thread, "lyrica");
    expect(own.getThreadTombstone(a.thread)).toBeUndefined();
  });

  it("deletes the matches of a search in bulk", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "ex");
    own.addNotes([{ text: "Sam likes jazz", source: s.entry }, { text: "Sam moved away", source: s.entry }, { text: "jazz is fine" }], { author: "lyrica", thread: s.thread });
    own.deleteMany(own.search("Sam").map((h) => h.id), "lyrica");
    expect(own.search("Sam")).toEqual([]);
    expect(own.search("jazz")).toHaveLength(1);
  });
});

describe("threads", () => {
  it("export copies keep entry IDs and aren't indexed twice", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const s = said(own, "the harbour at dawn");
    const copy = own.exportThread(s.thread, "web");
    expect(copy.parent).toBe(s.thread);
    expect(own.loadEntries(copy.id)).toEqual(own.loadEntries(s.thread));
    expect(own.lastEntry(copy.id)!.id).toBe(s.entry);
    expect(own.search("harbour").map((h) => h.id)).toEqual([s.entry]);
  });

  it("branches: the turns up to the chosen one, copied, with the source unchanged", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const t = own.createThread({ interface: "web", title: "Garden", unlogged: false });
    const add = (piId: string, role: string, text: string) => own.appendEntry(t.id, { piId, role, data: { id: piId }, text });
    add("u1", "user", "plant tulips");
    const reply = add("a1", "assistant", "read(\"beds.md\")");
    add("r1", "toolResult", "read: beds.md");
    add("a2", "assistant", "tulips in bed two");
    add("u2", "user", "and roses?");
    const [note] = own.addNotes([{ text: "{user} plants tulips", source: reply }], { author: "lyrica", thread: t.id });
    const before = own.loadEntries(t.id);

    // From a reply that called a tool: its result comes along, nothing after it.
    const branch = own.branchThread(t.id, 2);
    expect(branch).toMatchObject({ parent: t.id, subagent: false, title: "Garden (branch)" });
    expect(own.loadEntries(branch.id)).toEqual(before.slice(0, 3));
    expect(own.loadEntries(t.id)).toEqual(before);
    // Copies keep their originals' IDs: a note citing one resolves, and search and sleep see it once.
    expect(own.lastEntry(branch.id)!.id).toBe(`e:${t.id}#3`);
    expect(own.cameFrom(note!)).toContain(reply);
    expect(own.entryWindow(reply, 0).map((e) => e.text)).toEqual(['read("beds.md")']);
    expect(own.search("tulips").filter((h) => h.kind === "entry").map((h) => h.id).sort()).toEqual([`e:${t.id}#1`, `e:${t.id}#4`]);
    expect(own.sleepMaterial(undefined, new Date(Date.now() + 1000).toISOString()).threads.map((x) => x.id)).toEqual([t.id]);
    // It goes on from there as a thread of its own.
    own.appendEntry(branch.id, { piId: "u9", role: "user", data: {}, text: "lilies instead" });
    expect(own.lastEntry(branch.id)!.id).toBe(`e:${branch.id}#4`);

    const quiet = own.createThread({ interface: "web", unlogged: true });
    own.appendEntry(quiet.id, { piId: "q", role: "user", data: {}, text: "hush" });
    expect(own.branchThread(quiet.id, 1, { title: "Mine" })).toMatchObject({ unlogged: true, title: "Mine" });
    expect(() => own.branchThread(t.id, 99)).toThrow(/no entry 99/);
  });

  it("rewinds: removed turns go as forgotten ones do, and their numbers aren't reused", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const t = own.createThread({ interface: "web" });
    const keep = own.appendEntry(t.id, { piId: "u1", role: "user", data: {}, text: "the boat is blue" });
    own.appendEntry(t.id, { piId: "a1", role: "assistant", data: {}, text: "lovely" });
    // A subagent started before the removed turn, and one started in it.
    const earlier = own.createThread({ interface: "web", parent: t.id, subagent: true });
    const at = new Date(Date.now() + 50).toISOString();
    const gone = own.appendEntry(t.id, { piId: "u2", role: "user", data: {}, text: "the shed is red" }, at);
    own.appendEntry(t.id, { piId: "a2", role: "assistant", data: {}, text: "noted" }, at);
    await new Promise((r) => setTimeout(r, 80));
    const later = own.createThread({ interface: "web", parent: t.id, subagent: true });
    const [kept, removed, mixed] = own.addNotes([
      { text: "the boat is blue", source: keep },
      { text: "the shed is red", source: gone },
      { text: `both [${keep}]`, source: gone },
    ], { author: "lyrica", thread: t.id });
    own.putPage({ slug: "home", title: "Home", summary: "x", text: `Red shed [${removed}].` }, "sleep");
    own.putPage({ slug: "talk", title: "Talk", summary: "x", text: `Said so [${gone}].` }, "sleep");
    own.putPage({ slug: "boat", title: "Boat", summary: "x", text: `Blue [${kept}].` }, "sleep");

    expect(own.subagentsSince(t.id, 3)).toEqual([later.id]);
    expect(own.truncateThread(t.id, 3, "lyrica")).toEqual({ removed: 2, pins: 0, subagents: [later.id] });
    expect(own.loadEntries(t.id)).toHaveLength(2);
    expect(own.get(removed!)).toBeUndefined();
    expect(own.isTombstoned(gone)).toBe(true);
    expect(own.get(kept!)).toBeDefined();
    expect(own.get(mixed!)).toBeDefined();
    expect(own.search("shed").filter((h) => h.kind === "entry")).toEqual([]);
    expect(own.get("p:home")!.flagged).toBe(true);
    expect(own.get("p:talk")!.flagged).toBe(true);
    expect(own.get("p:boat")!.flagged).toBe(false);
    expect(own.getThread(later.id)).toBeUndefined();
    expect(own.getThread(earlier.id)).toBeDefined();
    const material = own.sleepMaterial(undefined, new Date(Date.now() + 1000).toISOString());
    expect(material.threads.find((x) => x.id === t.id)).toMatchObject({ entries: 2, last: `e:${t.id}#2` });
    // The next entry is #5, never #3 again: a tombstone for #3 can't mean the new one.
    expect(own.appendEntry(t.id, { piId: "u3", role: "user", data: {}, text: "try again" })).toBe(`e:${t.id}#5`);
    expect(own.isTombstoned(`e:${t.id}#5`)).toBe(false);
    // Delete from the end, again and again.
    expect(own.truncateThread(t.id, 5, "lyrica").removed).toBe(1);
    expect(own.truncateThread(t.id, 2, "lyrica").removed).toBe(1);
    expect(own.truncateThread(t.id, 2, "lyrica").removed).toBe(0);
    expect(own.loadEntries(t.id)).toHaveLength(1);
  });

  it("keeps child threads one level deep, and forgets them with their parent only when asked", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const parent = own.createThread({ interface: "web", unlogged: true });
    const child = own.createThread({ interface: "web", parent: parent.id, child: true, title: "Child" });
    expect(child).toMatchObject({ child: true, unlogged: true, parent: parent.id });
    expect(() => own.createThread({ interface: "web", parent: child.id, child: true })).toThrow(/can't start child threads/);
    expect(() => own.createThread({ interface: "web", child: true })).toThrow(/needs its parent/);
    const sub = own.createThread({ interface: "web", parent: parent.id, subagent: true });
    expect(own.listThreads({ includeHidden: true, parent: parent.id, children: true }).map((t) => t.id)).toEqual([child.id]);

    own.forgetThread(parent.id, "lyrica");
    expect(own.getThread(sub.id)).toBeUndefined();
    // Kept, it is a thread of its own, so it may start children.
    expect(own.getThread(child.id)).toMatchObject({ parent: undefined, child: false, unlogged: true });
    expect(own.createThread({ interface: "web", parent: child.id, child: true })).toMatchObject({ child: true, parent: child.id });

    const p2 = own.createThread({ interface: "web" });
    const c2 = own.createThread({ interface: "web", parent: p2.id, child: true });
    const b2 = own.createThread({ interface: "web", parent: c2.id });
    own.forgetThread(p2.id, "lyrica", { children: true });
    expect([own.getThread(c2.id), own.getThread(b2.id)]).toEqual([undefined, undefined]);
  });

  it("makes projects of top-level threads only, and keeps their branches in the project", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const project = own.createThread({ interface: "web", project: true, goal: "move the homelab", title: "Homelab" });
    expect(project).toMatchObject({ project: true, goal: "move the homelab" });
    const thread = own.createThread({ interface: "web", parent: project.id, child: true, title: "DNS" });
    expect(() => own.setProject(thread.id)).toThrow(/top-level/);
    expect(() => own.createThread({ interface: "web", parent: project.id, child: true, project: true })).toThrow(/top-level/);
    expect(() => own.setGoal(thread.id, "x")).toThrow(/only a project/);
    expect([own.projectOf(project.id), own.projectOf(thread.id)]).toEqual([project.id, project.id]);
    // A child of a project's thread is refused, as for any child thread.
    expect(() => own.createThread({ interface: "web", parent: thread.id, child: true })).toThrow(/can't start child threads/);

    own.appendEntry(thread.id, { piId: "u1", role: "user", data: {}, text: "use the router for DNS" });
    const branch = own.branchThread(thread.id, 1);
    expect(branch).toMatchObject({ parent: project.id, child: true });
    own.appendEntry(project.id, { piId: "u1", role: "user", data: {}, text: "two at a time" });
    expect(own.branchThread(project.id, 1)).toMatchObject({ parent: project.id, child: true });
    expect(own.projectThreads(project.id)).toHaveLength(4);

    // Making a project of a thread that has children makes them the project's threads.
    const plain = own.createThread({ interface: "web" });
    const kid = own.createThread({ interface: "web", parent: plain.id, child: true });
    expect(own.projectOf(kid.id)).toBeUndefined();
    own.setProject(plain.id);
    expect(own.projectOf(kid.id)).toBe(plain.id);
  });

  it("ranks a project's own memories higher when recalling from inside it, without hiding the rest", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const project = own.createThread({ interface: "web", project: true });
    const thread = own.createThread({ interface: "web", parent: project.id, child: true });
    const a = own.appendEntry(project.id, { piId: "u1", role: "user", data: {}, text: "set it up" });
    const other = said(own, "something else");
    const [ours] = own.addNotes([{ text: "the backup job runs nightly", source: a }], { author: "lyrica", thread: project.id });
    const [theirs] = own.addNotes([{ text: "the backup job runs nightly at two, the backup job", source: other.entry }], { author: "lyrica", thread: other.thread });
    const ids = (opts: Parameters<PoolStore["search"]>[1]) => own.search("backup job", { kinds: ["note"], ...opts }).map((h) => h.id);
    expect(ids({ fromThread: other.thread })).toEqual([theirs, ours]);
    expect(ids({ fromThread: thread.id })).toEqual([ours, theirs]);
    expect(ids({ fromThread: thread.id, limit: 1 })).toEqual([ours]);
    expect(ids({ limit: 1 })).toEqual([theirs]);
    // The project's page counts as its own too.
    own.putPage({ slug: projectSlug(project.id), title: "Backups", summary: "the backup job", text: `nightly [${ours}]` }, "sleep");
    own.putPage({ slug: "jobs", title: "Backup jobs", summary: "the backup job, every backup job", text: `at two [${theirs}]` }, "sleep");
    const pages = (fromThread: string) => own.search("backup job", { kinds: ["page"], fromThread }).map((h) => h.id);
    expect(pages(other.thread)).toEqual(["p:jobs", `p:${projectSlug(project.id)}`]);
    expect(pages(thread.id)).toEqual([`p:${projectSlug(project.id)}`, "p:jobs"]);
    // A project thread that isn't logged stays out of recall, boost or not; a logged one comes up.
    const quiet = own.createThread({ interface: "web", parent: project.id, child: true, unlogged: true });
    own.appendEntry(quiet.id, { piId: "u1", role: "user", data: {}, text: "the backup job failed again" });
    const loud = own.appendEntry(project.id, { piId: "u2", role: "user", data: {}, text: "the backup job failed once" });
    const entries = own.search("backup job failed", { kinds: ["entry"], fromThread: thread.id }).map((h) => h.id);
    expect(entries).toEqual([loud]);
  });

  it("finds a project's notes by citation, and forgets its page and notes with it", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const project = own.createThread({ interface: "web", project: true });
    const thread = own.createThread({ interface: "web", parent: project.id, child: true });
    const a = own.appendEntry(project.id, { piId: "u1", role: "user", data: {}, text: "run two at a time" });
    const b = own.appendEntry(thread.id, { piId: "u1", role: "user", data: {}, text: "the router does DNS" });
    const other = said(own, "unrelated");
    const [n1] = own.addNotes([{ text: "Al wants two threads at a time", source: a }], { author: "lyrica", thread: project.id });
    const [n2] = own.addNotes([{ text: "DNS is on the router", source: b }], { author: "lyrica", thread: thread.id });
    const [mixed] = own.addNotes([{ text: `DNS also came up [${other.entry}]`, source: b }], { author: "lyrica", thread: thread.id });
    const [elsewhere] = own.addNotes([{ text: "unrelated note", source: other.entry }], { author: "lyrica", thread: other.thread });
    expect(own.projectNotes(thread.id).map((n) => n.id)).toEqual([n1, n2, mixed]);
    expect(own.projectNotes(project.id, "9999")).toEqual([]);
    const [n3] = own.addNotes([{ text: "DNS is on the NAS now", source: b, supersedes: [n2!] }], { author: "lyrica", thread: thread.id });
    expect(own.projectNotes(project.id).map((n) => n.id)).toEqual([n1, mixed, n3]);
    expect(own.projectNotes(other.thread)).toEqual([]);

    const page = `p:${projectSlug(project.id)}`;
    expect(page).toMatch(/^p:project-web-[0-9a-f]+$/);
    expect(own.pageForProject(thread.id)).toBeUndefined();
    own.putPage({ slug: projectSlug(project.id), title: "Homelab", summary: "the move", text: `two at a time [${n1}]` }, "sleep");
    expect(own.pageForProject(thread.id)?.id).toBe(page);
    expect(own.sleepMaterial(undefined, "9999").threads.find((t) => t.id === thread.id)?.project).toBe(project.id);
    expect(own.sleepMaterial(undefined, "9999").threads.find((t) => t.id === other.thread)?.project).toBeUndefined();
    own.setUnlogged(project.id, true);
    expect(own.sleepMaterial(undefined, "9999").threads.find((t) => t.id === thread.id)?.project).toBeUndefined();
    own.setUnlogged(project.id, false);

    own.forgetThread(project.id, "lyrica", { children: true });
    expect([own.get(n1!), own.get(n2!), own.get(n3!), own.get(mixed!), own.get(page)].map((x) => x?.id)).toEqual([undefined, undefined, undefined, mixed, undefined]);
    expect(own.get(elsewhere!)?.id).toBe(elsewhere);
  });

  it("keeps a project's instructions apart from what sleep writes on its page", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const project = own.createThread({ interface: "web", project: true, title: "Homelab" });
    const owner = memory.openOwnerView(ada.id);
    const me = `user:${ada.id}` as const;
    expect(() => own.setProjectInstructions(project.id, "x", "sleep")).toThrow(/only be changed by the user/);
    owner.general.setProjectInstructions(project.id, "Ask before buying anything.", me);
    const page = `p:${projectSlug(project.id)}`;
    expect(own.get(page)).toMatchObject({ instructions: "Ask before buying anything.", text: "" });

    // Sleep writes and rewrites the text; the instructions stay.
    own.putPage({ slug: projectSlug(project.id), title: "Homelab", summary: "the move", text: "DNS moved first." }, "sleep");
    owner.general.setProjectInstructions(project.id, "Ask before buying anything over $50.", me);
    own.putPage({ slug: projectSlug(project.id), title: "Homelab", summary: "the move", text: "DNS is done; rack next." }, "sleep");
    expect(own.pageForProject(project.id)).toMatchObject({ instructions: "Ask before buying anything over $50.", text: "DNS is done; rack next." });
    expect(() => own.edit(page, { instructions: "Buy anything." }, "sleep")).toThrow(/only be changed by the user/);

    // Text the user wrote on the page is still kept word for word.
    owner.general.edit(page, { text: "DNS is done; rack next. Al: the rails are on order." }, me);
    expect(() => own.edit(page, { text: "Rack next." }, "sleep")).toThrow(/text a user wrote/);
    owner.close();
  });

  it("rewinds turns a branch still holds: their notes stay, and citations resolve through the copy", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const t = own.createThread({ interface: "web" });
    own.appendEntry(t.id, { piId: "u1", role: "user", data: {}, text: "the kettle is copper" });
    const kept = own.appendEntry(t.id, { piId: "a1", role: "assistant", data: {}, text: "a copper kettle" });
    const branch = own.branchThread(t.id, 2);
    const [note] = own.addNotes([{ text: "{user} has a copper kettle", source: kept }], { author: "lyrica", thread: t.id });
    own.setUnlogged(branch.id, true);
    own.appendEntry(branch.id, { piId: "u2", role: "user", data: {}, text: "off the record" });

    expect(own.truncateThread(t.id, 1, "lyrica").removed).toBe(2);
    expect(own.get(note!)).toBeDefined();
    expect(own.isTombstoned(kept)).toBe(false);
    expect(own.entryWindow(kept, 0).map((e) => [e.id, e.text])).toEqual([[kept, "a copper kettle"]]);
    expect(own.entryWindow(kept, 4, t.id).map((e) => e.text)).toEqual(["the kettle is copper", "a copper kettle"]);
    expect(own.search("copper").filter((h) => h.kind === "entry").map((h) => h.id).sort()).toEqual([`e:${t.id}#1`, kept]);
    expect(own.loadEntries(branch.id)).toHaveLength(3);
  });

  it("brings back pages about granted folders", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    own.putPage({ slug: "site", title: "Website", summary: "Al's site", text: "Astro.", folders: ["/srv/site"] }, "sleep");
    own.putPage({ slug: "other", title: "Other", summary: "x", text: "y" }, "sleep");
    expect(own.forFolders(["/srv/site/src"]).map((p) => p.id)).toEqual(["p:site"]);
    expect(own.forFolders(["/srv/site/"]).map((p) => p.id)).toEqual(["p:site"]);
    expect(own.forFolders(["/srv"])).toEqual([]);
    expect(own.pageIndex().map((p) => p.id).sort()).toEqual(["p:other", "p:site"]);
  });

  it("brings back pages about folders on an SSH machine, never the host's or another machine's", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    own.putPage({ slug: "nas-site", title: "Site on the NAS", summary: "x", text: "y", folders: ["nas:/srv/site"] }, "sleep");
    own.putPage({ slug: "host-site", title: "Site here", summary: "x", text: "y", folders: ["/srv/site"] }, "sleep");
    own.putPage({ slug: "nas", title: "The NAS", summary: "x", text: "y", folders: ["nas:/"] }, "sleep");
    const ids = (paths: string[]) => own.forFolders(paths).map((p) => p.id).sort();
    expect(ids(["nas:/srv/site"])).toEqual(["p:nas", "p:nas-site"]);
    expect(ids(["nas:/srv/site/src/"])).toEqual(["p:nas", "p:nas-site"]);
    expect(ids(["nas:/srv/site-old"])).toEqual(["p:nas"]);
    expect(ids(["/srv/site"])).toEqual(["p:host-site"]);
    expect(ids(["backup:/srv/site"])).toEqual([]);
  });
});

describe("on disk", () => {
  it("holds no memory or thread text in plaintext", async () => {
    const { memory, users, ada } = await setup();
    const view = memory.openThreadView(ada.id, "private");
    const s = said(view.own, "MARKERTHREADTEXT");
    view.own.setCodeTask(s.thread, "MARKERCODETASK", "MARKERCODEDONE");
    view.own.addNotes([{ text: "MARKERNOTETEXT", source: s.entry }], { author: "lyrica", thread: s.thread });
    view.own.putPage({ slug: "p", title: "MARKERPAGE", summary: "s", text: "t" }, "sleep");
    const general = memory.openThreadView(ada.id, "general");
    said(general.own, "MARKERGENERAL");
    const dir = users.userDir(ada.id);
    const files = readdirSync(dir);
    expect(files).toEqual(expect.arrayContaining(["general.db", "private.db"]));
    for (const f of files) expect(readFileSync(join(dir, f)).toString("latin1")).not.toMatch(/MARKER/);
    view.close();
    general.close();
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).toString("latin1")).not.toMatch(/MARKER/);
  });
});

describe("watches", () => {
  it("round-trips the record a relay makes, a poll's state and a webhook's mark, and settles a watch to its end", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const t = own.createThread({ interface: "cli" });
    const at = "2026-01-01T00:00:00.000Z";
    const id = own.addWatch(t.id, { repo: "ada/lyrica", kind: "forgejo", host: "forge.lan", account: "forge", number: 12 }, at);
    expect(own.watches(t.id)).toEqual([
      { id, thread: t.id, repo: "ada/lyrica", kind: "forgejo", host: "forge.lan", account: "forge", number: 12, head: null, headSince: at, notifiedHeads: [], seenReviews: [], createdAt: at },
    ]);

    // A poll saves decision state, and a signed webhook marks its arrival.
    const state = { head: "abc123", headSince: "2026-01-02T00:00:00.000Z", notifiedHeads: ["abc123"], seenReviews: ["ada:approved"] };
    expect(own.updateWatch(id, state)).toBe(true);
    own.markWatchWebhook(id, "2026-01-03T00:00:00.000Z");
    expect(own.watches()[0]).toMatchObject({ ...state, webhookAt: "2026-01-03T00:00:00.000Z" });

    // Settling the end removes the watch and records the wake-up once.
    const wakeId = own.settleWatch(id, state, true, { thread: t.id, dueAt: "2026-01-03T00:00:00.000Z", text: "PR #12: checks finished." });
    expect(typeof wakeId).toBe("number");
    expect(own.watches()).toEqual([]);
    expect(own.wakeups(t.id)).toEqual([{ id: wakeId, thread: t.id, dueAt: "2026-01-03T00:00:00.000Z", note: "PR #12: checks finished.", setAt: "2026-01-03T00:00:00.000Z", source: "forge" }]);
    // Settling a watch that is gone changes nothing.
    expect(own.settleWatch(id, state, false, null)).toBeUndefined();

    // A kept watch saves the state and adds no wake-up; it can then be removed.
    const id2 = own.addWatch(t.id, { repo: "ada/notes", kind: "github", host: "github.com", account: "gh", number: 3 }, at);
    expect(own.settleWatch(id2, state, false, null)).toBeUndefined();
    expect(own.watches(t.id)).toHaveLength(1);
    expect(own.watches(t.id)[0]).toMatchObject(state);
    expect(own.removeWatch(id2)).toBe(true);
    expect(own.removeWatch(id2)).toBe(false);
  });

  it("removes a watch with its thread", async () => {
    const { memory, ada } = await setup();
    const { own } = memory.openThreadView(ada.id, "general");
    const t = own.createThread({ interface: "cli" });
    own.addWatch(t.id, { repo: "ada/lyrica", kind: "forgejo", host: "forge.lan", account: "forge", number: 1 }, "2026-01-01T00:00:00.000Z");
    own.forgetThread(t.id, "lyrica");
    expect(own.watches()).toEqual([]);
  });
});


describe("credentials stay out of memory", () => {
  it("redacts every memory layer and edit, keeps revisions clean, and leaves conversation intact", async () => {
    const { memory, ada } = await setup();
    const view = memory.openThreadView(ada.id, "general");
    const token = "ghp_" + "a".repeat(40);
    const text = `Ada uses GH_TOKEN: ${token}`;
    const clean = "Ada uses GH_TOKEN: [secret removed]";
    const source = said(view.own, text);
    const [note] = view.own.addNotes([{ text, about: [token], source: source.entry }], { author: "lyrica" });
    const page = view.own.putPage({ slug: "fiction", title: token, summary: token, text }, "sleep");
    const journal = view.own.addJournal(text, "sleep");
    view.own.putWake(text, "sleep");
    const run = view.own.startSleepRun("manual", new Date().toISOString());
    const item = view.own.addItem(run, { kind: "question", text });
    const project = view.own.createThread({ interface: "cli", project: true });
    view.close();
    const owner = memory.openOwnerView(ada.id);
    try {
      expect(owner.general.get(note!)?.text).toBe(`${clean} [${source.entry}]`);
      expect(owner.general.get(page)).toMatchObject({ text: clean, title: "[secret removed]", summary: "[secret removed]" });
      expect(owner.general.getItem(item)?.text).toBe(clean);
      owner.general.setProjectInstructions(project.id, text, `user:${ada.id}`);
      expect(owner.general.get(`p:${projectSlug(project.id)}`)?.instructions).toBe(clean);
      expect(owner.general.get(journal)?.text).toBe(clean);
      expect(owner.general.get("wake")?.text).toBe(clean);
      expect(owner.general.entryWindow(source.entry, 0)[0]?.text).toBe(text);
      for (const id of [note!, page, journal, "wake"]) {
        owner.general.edit(id, { text: `password="fictional value" ${text}` }, `user:${ada.id}`);
        expect(owner.general.get(id)?.text).toBe(`password=[secret removed] ${clean}`);
        expect(JSON.stringify(owner.general.revisions(id))).not.toContain(token);
      }
      expect(owner.general.get(note!)?.about).toEqual(["[secret removed]"]);
    } finally { owner.close(); }
  });
});


describe("code-mode core storage", () => {
  it("filters before the candidate cut, keeping project items or whole working tags only", async () => {
    const { memory, ada } = await setup();
    const view = memory.openThreadView(ada.id, "general");
    const { own } = view;
    const project = own.createThread({ interface: "web", project: true });
    const source = own.appendEntry(project.id, { piId: "a", role: "user", data: {}, text: "fixture instructions" });
    const other = said(own, "elsewhere");
    const [projectNote] = own.addNotes([{ text: "cobalt " + "details ".repeat(80), source }], { author: "lyrica", thread: project.id });
    const [working, partial] = own.addNotes([
      { text: "cobalt workflow", about: ["working"] },
      { text: "cobalt", about: ["networking", "working-hard"] },
      ...Array.from({ length: 24 }, () => ({ text: "cobalt" })),
    ], { author: "lyrica", thread: other.thread });
    expect(own.search("cobalt", { limit: 4, kinds: ["note"] }).map(h => h.id)).not.toContain(projectNote);
    const only = { project: true, about: "working" };
    const ids = own.search("cobalt", { limit: 2, only, fromThread: project.id }).map(h => h.id);
    expect(new Set(ids)).toEqual(new Set([projectNote, working]));
    expect(ids).not.toContain(partial);
    own.putPage({ slug: projectSlug(project.id), title: "Cobalt", summary: "fixture", text: "cobalt" }, "sleep");
    own.putPage({ slug: "working", title: "Cobalt", summary: "working", text: "cobalt" }, "sleep");
    const entry = own.appendEntry(project.id, { piId: "b", role: "user", data: {}, text: "cobalt" });
    expect(own.search("cobalt", { only, fromThread: project.id }).map(h => h.id)).toEqual(expect.arrayContaining([`p:${projectSlug(project.id)}`, entry]));
    expect(own.search("cobalt", { only }).map(h => h.id)).toEqual([working]);
    const priv = memory.openThreadView(ada.id, "private");
    const privateProject = priv.own.createThread({ interface: "web", project: true });
    expect(searchView(priv, "cobalt", { only, fromThread: privateProject.id }).map(h => h.id)).toEqual([`general/${working}`]);
    priv.close();
    view.close();
  });

  it("finds a working note ranked deep below unrelated hits", async () => {
    const { memory, ada } = await setup();
    const view = memory.openThreadView(ada.id, "general");
    const other = said(view.own, "elsewhere");
    view.own.addNotes(Array.from({ length: 600 }, () => ({ text: "zircon zircon zircon" })), { author: "lyrica", thread: other.thread });
    const [deep] = view.own.addNotes([{ text: "zircon " + "padding ".repeat(80), about: ["working"] }], { author: "lyrica", thread: other.thread });
    expect(view.own.search("zircon", { only: { project: true, about: "working" } }).map(h => h.id)).toEqual([deep]);
    view.close();
  });

  it("round trips and replaces code tasks in the encrypted pool, with limits and thread deletion", async () => {
    const { memory, ada } = await setup();
    let view = memory.openThreadView(ada.id, "general");
    const thread = view.own.createThread({ interface: "web" });
    expect(view.own.codeTask(thread.id)).toBeUndefined();
    view.own.setCodeTask(thread.id, "Fix fixture", "Read checks");
    view.close();
    view = memory.openThreadView(ada.id, "general");
    expect(view.own.codeTask(thread.id)).toMatchObject({ task: "Fix fixture", done: "Read checks", at: expect.any(String) });
    view.own.setCodeTask(thread.id, "Run checks");
    expect(view.own.codeTask(thread.id)).toMatchObject({ task: "Run checks", done: "" });
    expect(() => view.own.setCodeTask(thread.id, "x".repeat(301))).toThrow(/300/);
    expect(() => view.own.setCodeTask(thread.id, "ok", "x".repeat(1201))).toThrow(/1200/);
    view.own.forgetThread(thread.id, "lyrica");
    expect(view.own.codeTask(thread.id)).toBeUndefined();
    view.close();
  });
});

describe("renamed files at sleep", () => {
  it("respells the memories citing a thread with a waiting rename, the user's own words too, as sleep, and leaves another folder alone", async () => {
    const { memory, ada } = await setup();
    const view = memory.openThreadView(ada.id, "general");
    try {
      const a = said(view.own, "here is the cat photo");
      const b = said(view.own, "another thread");
      const [cat] = view.own.addNotes([{ text: "{user}'s cat is in /workspace/uploads/cat.png", source: a.entry }], { author: "lyrica", thread: a.thread });
      const [other] = view.own.addNotes([{ text: "Also /workspace/uploads/cat.png, but another folder", source: b.entry }], { author: "lyrica", thread: b.thread });
      const page = view.own.putPage({ slug: "pets", title: "Pets", summary: "The cat, /workspace/uploads/cat.png", text: `See /workspace/uploads/cat.png [${cat}]` }, "sleep");
      const owner = memory.openOwnerView(ada.id);
      const [theirs] = owner.general.addNotes([{ text: "Mine: /workspace/uploads/cat.png", source: a.entry }], { author: `user:${ada.id}`, thread: a.thread });
      // The user's own words on the page, which sleep otherwise keeps word for word.
      owner.general.edit(page, { text: `My cat: /workspace/uploads/cat.png [${cat}]` }, `user:${ada.id}`);
      owner.close();
      view.own.recordRename([{ thread: a.thread, swaps: [{ from: "/workspace/uploads/cat.png", to: "/workspace/uploads/tabby.png" }] }]);
      expect(view.own.pendingRenames()).toBe(1);

      expect(view.own.applyRenames().sort()).toEqual([cat, page, theirs].sort());
      expect(view.own.get(cat!)?.text).toBe(`Al's cat is in /workspace/uploads/tabby.png [${a.entry}]`);
      expect(view.own.get(theirs!)?.text).toContain("/workspace/uploads/tabby.png");
      // Through the note it cites, the page follows too; the old text stays a revision, written by sleep, never as the user's.
      expect(view.own.get(page)).toMatchObject({ text: `My cat: /workspace/uploads/tabby.png [${cat}]`, summary: "The cat, /workspace/uploads/tabby.png" });
      expect(view.own.revisions(theirs!).at(-1)?.author).toBe("sleep");
      expect(view.own.revisions(cat!)[0]?.body.text).toContain("cat.png");
      expect(view.own.revisions(page).at(-1)?.body).not.toHaveProperty("renamed");
      // Their words now stand in the new spelling: sleep may add around them, and still not drop them.
      view.own.edit(page, { text: `My cat: /workspace/uploads/tabby.png [${cat}]. Grey.` }, "sleep");
      expect(() => view.own.edit(page, { text: `A cat [${cat}]` }, "sleep")).toThrow(/text a user wrote/);
      // The renamed-files exception covers only the respelling itself, and only for sleep.
      const swap = [[{ from: "/workspace/uploads/tabby.png", to: "/workspace/uploads/grey.png" }]];
      expect(() => view.own.edit(theirs!, { text: "Something else" }, "sleep", swap)).toThrow(/may only respell/);
      expect(() => view.own.edit(theirs!, { text: view.own.get(theirs!)!.text.replace("tabby", "grey") }, "lyrica", swap)).toThrow(/may only respell/);
      // Another thread's folder keeps the old path.
      expect(view.own.get(other!)?.text).toContain("/workspace/uploads/cat.png");
      expect(view.own.pendingRenames()).toBe(0);
      expect(view.own.applyRenames()).toEqual([]);
    } finally { view.close(); }
  });
});
