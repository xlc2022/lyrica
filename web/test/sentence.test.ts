import { describe, expect, it } from "vitest";
import { sentence } from "../src/api.ts";

describe("lyricad's reasons as sentences", () => {
  it("capitalizes a phrase, but never a host or other name it starts with", () => {
    expect(sentence("this server has no route to git.example.net")).toBe("This server has no route to git.example.net.");
    expect(sentence("git.example.net didn't answer")).toBe("git.example.net didn't answer.");
    expect(sentence("git.example.net's certificate isn't valid: it has expired")).toBe("git.example.net's certificate isn't valid: it has expired.");
    expect(sentence("100.66.1.2 didn't answer")).toBe("100.66.1.2 didn't answer.");
    expect(sentence("/usr/bin/env runs anything, so it can't be allowed")).toBe("/usr/bin/env runs anything, so it can't be allowed.");
    expect(sentence("that token is sam's, not ada's.")).toBe("That token is sam's, not ada's.");
  });
});
