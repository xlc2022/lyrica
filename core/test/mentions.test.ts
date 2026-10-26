import { describe, expect, it } from "vitest";
import { PRONOUN_PRESETS, pronounLabel, queryTokens, render, renderThreadMentions, toStored, type Profile } from "../src/index.ts";

const profiles = new Map<string, Profile>([
  ["u1", { displayName: "Al", pronouns: PRONOUN_PRESETS.she, previousNames: [] }],
  ["u2", { displayName: "Mina", pronouns: PRONOUN_PRESETS.they, previousNames: [{ name: "Mia", until: "2026-09-01" }] }],
]);
const lookup = (id: string) => profiles.get(id);

describe("mentions", () => {
  it("stores every written form as a token", () => {
    expect(toStored("{user} lent {user:obj} {user:poss} book; it is {user:poss-pro}. {user} did it {user:refl}.", "u1"))
      .toBe("[[u:u1]] lent [[u:u1:obj]] [[u:u1:poss]] book; it is [[u:u1:poss-pro]]. [[u:u1]] did it [[u:u1:refl]].");
  });

  it("refuses a subject pronoun and unknown forms", () => {
    expect(() => toStored("{user:subj} likes tea", "u1")).toThrow(/write \{user\}/);
    expect(() => toStored("{user:dative}", "u1")).toThrow(/unknown/);
  });

  it("round-trips through storage and rendering", () => {
    const stored = toStored("{user} wants the cluster finished; ask {user:obj} about {user:poss} backup.", "u1");
    expect(render(stored, lookup)).toBe("Al wants the cluster finished; ask her about her backup.");
  });

  it("re-renders stored text after a rename and pronoun change, without rewriting it", () => {
    const stored = toStored("{user} bought a piano for {user:refl}. It is {user:poss-pro}.", "u1");
    const renamed = new Map(profiles);
    renamed.set("u1", { displayName: "Alba", pronouns: PRONOUN_PRESETS.they, previousNames: [{ name: "Al", until: "2026-10-09" }] });
    expect(render(stored, (id) => renamed.get(id))).toBe("Alba bought a piano for themself. It is theirs.");
    expect(render(stored, lookup)).toBe("Al bought a piano for herself. It is hers.");
  });

  it("renders custom pronouns", () => {
    const custom: Profile = { displayName: "Ash", pronouns: { subj: "xe", obj: "xem", poss: "xyr", possPro: "xyrs", refl: "xemself" }, previousNames: [] };
    const stored = toStored("I gave {user:obj} {user:poss} notes back. {user:poss} handwriting is neat.", "u3");
    expect(render(stored, (id) => (id === "u3" ? custom : undefined))).toBe("I gave xem xyr notes back. Xyr handwriting is neat.");
    expect(pronounLabel(custom.pronouns)).toBe("xe/xem/xyr/xyrs/xemself");
    expect(pronounLabel(PRONOUN_PRESETS.she)).toBe("she/her");
  });

  it("keeps different users apart and names a deleted user only as a former user, never by ID", () => {
    const text = `${toStored("{user} met", "u1")} ${toStored("{user} and thanked {user:obj}.", "u2")} [[u:gone]] too, with [[u:gone:poss]] dog. [[u:gone:poss]] dog barked.`;
    expect(render(text, lookup)).toBe("Al met Mina and thanked them. A former user too, with their dog. Their dog barked.");
  });

  it("finds current and previous names in a query without changing it", () => {
    expect(queryTokens("what did al say about Mia's piano, and Al again", profiles)).toEqual([
      { name: "al", userId: "u1" },
      { name: "Mia", userId: "u2" },
    ]);
    expect(queryTokens("Mina", profiles)).toEqual([{ name: "Mina", userId: "u2" }]);
    expect(queryTokens("Alpine and Miami", profiles)).toEqual([]);
  });

  it("reports a name inside a hyphenated word, so the caller can keep the literal word", () => {
    // The Memory thread searches for "Al" OR [[u:u1]]; notes about "Al-ion" still match the word.
    expect(queryTokens("Al-ion battery", profiles)).toEqual([{ name: "Al", userId: "u1" }]);
  });

  it("prefers a current name over someone else's previous one", () => {
    const clash = new Map(profiles);
    clash.set("u3", { displayName: "Ash", pronouns: PRONOUN_PRESETS.he, previousNames: [{ name: "Al", until: "2026-01-01" }] });
    expect(queryTokens("Al", clash)).toEqual([{ name: "Al", userId: "u1" }]);
    expect(queryTokens("Ash", clash)).toEqual([{ name: "Ash", userId: "u3" }]);
  });

  it("renders thread mentions by the thread's current title, wherever there is no chip", () => {
    const titles = new Map([["web/aa11", "Homelab"], ["cli/bb22", "Taxes"]]);
    const titleOf = (id: string, pool?: string) => (pool === "private" ? undefined : titles.get(id));
    expect(renderThreadMentions("Moved to [t:web/aa11], see [e:cli/bb22#4] and [general/t:cli/bb22].", titleOf))
      .toBe("Moved to Homelab, see Taxes and Taxes.");
    expect(renderThreadMentions("[t:web/zz99] and [private/t:web/aa11]; t:web/aa11 stays", titleOf))
      .toBe("a forgotten thread and a forgotten thread; t:web/aa11 stays");
  });
});
