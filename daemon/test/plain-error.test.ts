import { describe, expect, it } from "vitest";
import { plainError } from "../src/messages.ts";

describe("a reply's error in plain words", () => {
  it("shows a server's JSON error as its message alone", () => {
    expect(plainError('503: {"code":"busy","message":"The GPU is busy with a chat model."}')).toBe("The GPU is busy with a chat model.");
    expect(plainError('400 {"error":{"code":"invalid","message":"messages is missing."}}')).toBe("messages is missing.");
    expect(plainError("500: {not json}")).toBe("500: {not json}");
    expect(plainError("Something else went wrong.")).toBe("Something else went wrong.");
  });
});
