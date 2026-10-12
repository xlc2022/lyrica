// The warn lines under a text model's group (web/src/library.ts): one per way its copies differ, word for word.
import { describe, expect, it } from "vitest";
import { groupWarnings } from "../src/library.ts";

const copy = (kind: "local" | "cloud", contextWindow?: number, vision?: boolean) => ({ kind, capabilities: { ...(contextWindow ? { contextWindow } : {}), ...(vision ? { vision } : {}) } });

describe("a group's warn lines", () => {
  it("says nothing when the copies match", () => {
    expect(groupWarnings([copy("local", 32768), copy("local", 32768)])).toEqual([]);
    expect(groupWarnings([copy("cloud", 131072, true)])).toEqual([]);
  });

  it("says when local and cloud copies mix", () => {
    expect(groupWarnings([copy("local", 32768), copy("cloud", 32768)])).toEqual([
      "Mixes local and cloud: Local and Cloud profiles use only the matching copies, Custom uses all of them.",
    ]);
  });

  it("says when context windows differ, counting an unknown one as different", () => {
    expect(groupWarnings([copy("local", 32768), copy("local", 131072)])).toEqual(["Context windows differ: long conversations skip the smaller copies."]);
    expect(groupWarnings([copy("local", 32768), copy("local")])).toEqual(["Context windows differ: long conversations skip the smaller copies."]);
  });

  it("says when only some copies see images", () => {
    expect(groupWarnings([copy("local", 32768, true), copy("local", 32768)])).toEqual(["Only some copies can see images: calls with images skip the others."]);
  });

  it("gives every line that applies, in order", () => {
    expect(groupWarnings([copy("local", 32768, true), copy("cloud", 131072)])).toEqual([
      "Mixes local and cloud: Local and Cloud profiles use only the matching copies, Custom uses all of them.",
      "Context windows differ: long conversations skip the smaller copies.",
      "Only some copies can see images: calls with images skip the others.",
    ]);
  });
});
