import { describe, expect, it } from "vitest";
import { exportMemories, importMemories, Memory, parseMemories, Users, type PoolStore } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  const sam = await users.createUser("sam", "pw", profile("Sam"), { admin: false });
  await users.authenticate("ada", "pw");
  await users.authenticate("sam", "pw");
  return { ada, sam, memory: new Memory(keyring, users) };
}

function said(store: PoolStore, text: string, title?: string) {
  const thread = store.createThread({ interface: "cli", title });
  const entry = store.appendEntry(thread.id, { piId: "a1", role: "user", data: { type: "message" }, text });
  return { thread: thread.id, entry };
}

describe("memory export and import", () => {
  it("exports notes and pages with words for each link, and nothing else", async () => {
    const { memory, ada } = await setup();
    const o = memory.openOwnerView(ada.id);
    const s = said(o.general, "the cluster", "Homelab");
    const [note] = o.general.addNotes([{ text: `{user} keeps three nodes [${s.entry}]`, about: ["proxmox"] }], { author: `user:${ada.id}` });
    o.general.putPage({ slug: "homelab", title: "Proxmox homelab", summary: "the cluster", text: `Three nodes [${note}].` }, `user:${ada.id}`);
    o.general.putWake("awake", `user:${ada.id}`);
    const out = exportMemories(o, [{ pool: "general", id: "p:homelab" }, { pool: "general", id: note! }, { pool: "general", id: "wake" }]);
    expect(out).toMatchObject({ count: 2, skipped: 1 });
    expect(out.markdown).toContain("{user} keeps three nodes");
    expect(out.markdown).not.toMatch(/\[\[u:/);
    expect(out.markdown).toContain(`${s.entry}: "a message in the conversation “Homelab”`);
    const parsed = parseMemories(out.markdown);
    expect(parsed.map((p) => [p.kind, p.id, p.title])).toEqual([["page", "p:homelab", "Proxmox homelab"], ["note", note, undefined]]);
    expect(parsed[1]!.about).toEqual(["proxmox"]);
    expect(parsed[0]!.cites[note!]).toMatch(/^a note, .*: “Ada keeps three nodes”|^a note, .*: “\{user\} keeps three nodes”/);
    o.close();
  });

  it("re-imports into the same pools as duplicates, keeping nothing twice", async () => {
    const { memory, ada } = await setup();
    const o = memory.openOwnerView(ada.id);
    const [note] = o.private.addNotes([{ text: "a private thing" }], { author: `user:${ada.id}` });
    const out = exportMemories(o, [{ pool: "private", id: note! }]);
    const r = importMemories(o, [{ text: out.markdown }, { text: out.markdown }], { author: `user:${ada.id}` });
    expect(r).toMatchObject({ imported: [], duplicates: 2 });
    o.close();
  });

  it("imports into another user's own pools as their memories, keeping links that resolve and wording the rest", async () => {
    const { memory, ada, sam } = await setup();
    const a = memory.openOwnerView(ada.id);
    const s = said(a.general, "the cluster", "Homelab");
    const [gone] = a.general.addNotes([{ text: "the old NAS" }], { author: `user:${ada.id}` });
    const [kept] = a.general.addNotes([{ text: `{user} keeps three nodes, off [${gone}] [${s.entry}]` }], { author: `user:${ada.id}` });
    a.general.putPage({ slug: "homelab", title: "Proxmox homelab", summary: "", text: `Three nodes [${kept}].` }, `user:${ada.id}`);
    const out = exportMemories(a, [{ pool: "general", id: "p:homelab" }, { pool: "general", id: kept! }]);
    a.close();

    const o = memory.openOwnerView(sam.id);
    const r = importMemories(o, [{ name: "x.md", text: out.markdown }], { author: `user:${sam.id}` });
    expect(r).toMatchObject({ duplicates: 0, renamed: 0, skipped: 0 });
    expect(r.imported).toEqual([{ pool: "general", id: "p:homelab" }, { pool: "general", id: kept }]);
    const page = o.general.get("p:homelab", { raw: true })!;
    expect(page.origin).toBe("user");
    expect(page.text).toBe(`Three nodes [${kept}].`);
    const note = o.general.get(kept!)!;
    expect(note.origin).toBe("user");
    // Sam's import names Sam, and the links that aren't here read as words.
    expect(note.text).toMatch(/^Sam keeps three nodes, off \(from a note, .*“the old NAS”\) \(from a message in the conversation “Homelab”, /);
    expect(o.general.cameFrom(kept!)).toEqual([]);
    expect(r).toMatchObject({ linksKept: 1, linksWorded: 2 });
    // The same file again: its worded links don't make it new.
    expect(importMemories(o, [{ text: out.markdown }], { author: `user:${sam.id}` })).toMatchObject({ imported: [], duplicates: 2 });
    o.close();
  });

  it("renames on a clash and follows the rename in links from the same import", async () => {
    const { memory, ada } = await setup();
    const o = memory.openOwnerView(ada.id);
    o.general.putPage({ slug: "garden", title: "Garden", summary: "", text: "tomatoes" }, `user:${ada.id}`);
    const md = [
      "---", "lyrica: memory 1", "kind: page", "pool: general", "id: p:garden", 'title: "Garden"', "---", "", "roses", "",
      "---", "lyrica: memory 1", "kind: note", "pool: general", "id: n:20261001-aaaa", "---", "", "pruned in March [p:garden]", "",
    ].join("\n");
    const r = importMemories(o, [{ text: md }], { author: `user:${ada.id}` });
    expect(r.renamed).toBe(1);
    expect(o.general.get("p:garden-2")?.text).toBe("roses");
    expect(o.general.get("n:20261001-aaaa")?.text).toBe("pruned in March [p:garden-2]");
    o.close();
  });

  it("never puts private words in a general memory, and keeps general links from private", async () => {
    const { memory, ada } = await setup();
    const o = memory.openOwnerView(ada.id);
    const [g] = o.general.addNotes([{ text: "plays Satie" }], { author: `user:${ada.id}` });
    const [p] = o.private.addNotes([{ text: "a quiet diagnosis" }], { author: `user:${ada.id}` });
    const [both] = o.private.addNotes([{ text: `builds on [general/${g}] and [${p}]` }], { author: `user:${ada.id}` });
    const out = exportMemories(o, [{ pool: "private", id: both! }]);
    const r = importMemories(o, [{ text: out.markdown }], { pool: "general", author: `user:${ada.id}` });
    const [id] = r.imported;
    expect(id!.pool).toBe("general");
    const text = o.general.get(id!.id)!.text;
    expect(text).toBe(`builds on [${g}] and (from a private note)`);
    expect(text).not.toContain("diagnosis");
    o.close();
  });

  it("gives a hand-edited ID that no link could name a fresh one", async () => {
    const { memory, ada } = await setup();
    const o = memory.openOwnerView(ada.id);
    const md = [
      "---", "lyrica: memory 1", "kind: note", "pool: general", "id: n:my note", "---", "", "seeds in jars", "",
      "---", "lyrica: memory 1", "kind: page", "pool: general", "id: p:My Garden", 'title: "My Garden"', "---", "", "roses", "",
    ].join("\n");
    const r = importMemories(o, [{ text: md }], { author: `user:${ada.id}` });
    expect(r.imported.map((x) => x.id)).toEqual([expect.stringMatching(/^n:\d{8}-[0-9a-f]{8}$/), "p:my-garden"]);
    o.close();
  });

  it("imports a plain Markdown file as one private note", async () => {
    const { memory, ada } = await setup();
    const o = memory.openOwnerView(ada.id);
    const r = importMemories(o, [{ text: "# Seeds\n\n{user} saves seeds in jars." }], { author: `user:${ada.id}` });
    expect(r.imported).toHaveLength(1);
    expect(r.imported[0]!.pool).toBe("private");
    expect(o.private.get(r.imported[0]!.id)?.text).toBe("# Seeds\n\nAda saves seeds in jars.");
    o.close();
  });
});
