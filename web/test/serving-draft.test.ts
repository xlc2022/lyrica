// An open copy's serving draft (web/src/library.ts reseedDraft): a change from elsewhere replaces it only while it is untouched.
import { describe, expect, it } from "vitest";
import { reseedDraft } from "../src/library.ts";

describe("a copy's serving draft", () => {
  it("starts from the saved settings", () => {
    expect(reseedDraft(undefined, undefined, { contextLength: 65536 })).toEqual({ contextLength: 65536 });
  });

  it("takes a new saved value while untouched, so Save stays off and can't put the old one back", () => {
    const old = { contextLength: 65536, kvCacheType: "q8_0" };
    expect(reseedDraft({ kvCacheType: "q8_0", contextLength: 65536 }, old, { contextLength: 131072, kvCacheType: "q8_0" })).toEqual({ contextLength: 131072, kvCacheType: "q8_0" });
  });

  it("keeps what the user typed", () => {
    const draft = { contextLength: 65536, flashAttention: "on" };
    expect(reseedDraft(draft, { contextLength: 65536 }, { contextLength: 131072 })).toBe(draft);
  });
});
