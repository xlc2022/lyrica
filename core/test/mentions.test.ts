import { describe, expect, it } from "vitest";
import { PRONOUN_PRESETS, pronounLabel, queryTokens, render, toStored, type Profile } from "../src/index.ts";

const profiles = new Map<string, Profile>([
  ["u1", { displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] }],
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
    expect(render(stored, lookup)).toBe("Li wants the cluster finished; ask her about her backup.");
  });

  it("re-renders stored text after a rename and pronoun change, without rewriting it", () => {
    const stored = toStored("{user} bought a piano for {user:refl}. It is {user:poss-pro}.", "u1");
    const renamed = new Map(profiles);
    renamed.set("u1", { displayName: "Lin", pronouns: PRONOUN_PRESETS.they, previousNames: [{ name: "Li", until: "2026-10-09" }] });
    expect(render(stored, (id) => renamed.get(id))).toBe("Lin bought a piano for themself. It is theirs.");
    expect(render(stored, lookup)).toBe("Li bought a piano for herself. It is hers.");
  });

  it("renders custom pronouns", () => {
    const custom: Profile = { displayName: "Ash", pronouns: { subj: "xe", obj: "xem", poss: "xyr", possPro: "xyrs", refl: "xemself" }, previousNames: [] };
    const stored = toStored("I gave {user:obj} {user:poss} notes back. {user:poss} handwriting is neat.", "u3");
    expect(render(stored, (id) => (id === "u3" ? custom : undefined))).toBe("I gave xem xyr notes back. Xyr handwriting is neat.");
    expect(pronounLabel(custom.pronouns)).toBe("xe/xem/xyr/xyrs/xemself");
    expect(pronounLabel(PRONOUN_PRESETS.she)).toBe("she/her");
  });

  it("keeps different users apart and leaves unknown users as tokens", () => {
    const text = `${toStored("{user} met", "u1")} ${toStored("{user} and thanked {user:obj}.", "u2")} [[u:gone]] too.`;
    expect(render(text, lookup)).toBe("Li met Mina and thanked them. [[u:gone]] too.");
  });

  it("turns current and previous names in a query into tokens", () => {
    expect(queryTokens("what did li say about Mia's piano", profiles)).toBe("what did [[u:u1]] say about [[u:u2]]'s piano");
    expect(queryTokens("Mina", profiles)).toBe("[[u:u2]]");
    expect(queryTokens("Lisbon and Miami", profiles)).toBe("Lisbon and Miami");
  });

  it("prefers a current name over someone else's previous one", () => {
    const clash = new Map(profiles);
    clash.set("u3", { displayName: "Ash", pronouns: PRONOUN_PRESETS.he, previousNames: [{ name: "Li", until: "2026-01-01" }] });
    expect(queryTokens("Li", clash)).toBe("[[u:u1]]");
    expect(queryTokens("Ash", clash)).toBe("[[u:u3]]");
  });
});
