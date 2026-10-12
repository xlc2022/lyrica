import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Forbidden, MATRIX, PersonaStore, Users } from "../src/index.ts";
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

  it("rejects a matrix it can't parse", async () => {
    const keyring = await freshKeyring();
    const li = await new Users(keyring).createUser("li", "pw", profile("Li"), { admin: true });
    const store = new PersonaStore(keyring.self());
    store.importSeed(SEED);
    expect(() => store.apply(li, MATRIX, "no front matter")).toThrow(/front matter/);
    expect(() => store.apply(li, "../etc/passwd", "x")).toThrow(/not a persona file/);
  });
});
