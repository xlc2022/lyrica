import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_LIMIT, coreText, Forbidden, MATRIX, PersonaStore, setSelfName, Users } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

const SEED = fileURLToPath(new URL("../../persona", import.meta.url));

describe("persona", () => {
  it("imports the seed once", async () => {
    const store = new PersonaStore((await freshKeyring()).self());
    expect(store.importSeed(SEED)).toBe(true);
    expect(store.importSeed(SEED)).toBe(false);

    const persona = store.read();
    expect(persona.core.map((f) => f.path)).toEqual(["SOUL.md", "STYLE.md", "REGISTER.md"]);
    expect(persona.topics.map((t) => t.id)).toEqual(["engineering", "leadership", "literature", "music", "language", "narrative", "organization", "memory"]);
    expect(persona.topics.every((t) => t.text.length > 0 && t.triggers.length > 0)).toBe(true);
    expect(store.revisions("SOUL.md")).toHaveLength(1);
  });

  it("keeps every change as a revision, and only administrators can change it", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
    const mina = await users.createUser("Mina", "pw", profile("Mina"), { admin: false });
    const store = new PersonaStore(keyring.self());
    store.importSeed(SEED);
    const original = store.files().get("STYLE.md")!;

    expect(() => store.apply(mina, "STYLE.md", "changed")).toThrow(Forbidden);
    store.apply(li, "STYLE.md", `${original}\nShe likes footnotes.`);
    store.apply(li, "STYLE.md", `${original}\nShe likes footnotes.`); // unchanged: no new revision

    expect(store.files().get("STYLE.md")).toContain("footnotes");
    const revs = store.revisions("STYLE.md");
    expect(revs.map((r) => r.author)).toEqual(["seed", `user:${li.id}`]);
    expect(revs[0]!.text).toBe(original);
  });

  it("refuses a core over its limit with her longest possible name, so no rename makes her prompt cut it", async () => {
    const keyring = await freshKeyring();
    const self = keyring.self();
    const owner = await new Users(keyring).createUser("owner", "pw", profile("Owner"), { admin: true });
    const store = new PersonaStore(self);
    store.importSeed(SEED);
    // Measured as if she were called 40 characters, against "Lyrica"'s 6.
    const room = CORE_LIMIT - coreText(store.read().core).length - (40 - "Lyrica".length);
    const style = store.files().get("STYLE.md")!.trim();
    expect(() => store.apply(owner, "STYLE.md", `${style}${"x".repeat(room + 1)}`)).toThrow(/over 12,000/);
    store.apply(owner, "STYLE.md", `${style}${"x".repeat(room)}`);
    setSelfName(self, "y".repeat(40));
    expect(coreText(store.read().core)).toHaveLength(CORE_LIMIT);
    // Topics have no such limit.
    store.apply(owner, "persona_topics/music.md", "y".repeat(CORE_LIMIT + 1));
  });

  it("rejects a matrix it can't parse", async () => {
    const keyring = await freshKeyring();
    const li = await new Users(keyring).createUser("li", "pw", profile("Li"), { admin: true });
    const store = new PersonaStore(keyring.self());
    store.importSeed(SEED);
    expect(() => store.apply(li, MATRIX, "no front matter")).toThrow(/front matter/);
    expect(() => store.apply(li, "../etc/passwd", "x")).toThrow(/not a persona file/);
  });
});
