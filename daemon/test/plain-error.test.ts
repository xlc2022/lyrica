import { describe, expect, it } from "vitest";
import { plainError, replyError, TOO_LARGE_ERROR } from "../src/messages.ts";

describe("a reply's error in plain words", () => {
  it("shows a server's JSON error as its message alone", () => {
    expect(plainError('503: {"code":"busy","message":"The GPU is busy with a chat model."}')).toBe("The GPU is busy with a chat model.");
    expect(plainError('400 {"error":{"code":"invalid","message":"messages is missing."}}')).toBe("messages is missing.");
    expect(plainError("500: {not json}")).toBe("500: {not json}");
    expect(plainError("Something else went wrong.")).toBe("Something else went wrong.");
  });

  it("says what to do when a reply's request was too large for the server, whoever refused it", () => {
    // The model host's refusal before 413, its 413, Anthropic's and a proxy's.
    for (const m of ['400 {"error":{"code":"invalid","message":"The request is too large."}}', "413 The request is larger than the model host takes (64 MiB).",
      "413 status code (no body)", '{"type":"error","error":{"type":"request_too_large"}}', "Request Entity Too Large"]) expect(replyError(m)).toBe(TOO_LARGE_ERROR);
    expect(replyError('400 {"error":{"code":"invalid","message":"messages is missing."}}')).toBe("messages is missing.");
    // Other errors keep their own words: an image host's 413 for a model too big for its GPU isn't about the request.
    expect(plainError("413 This model needs about 30 GB on GPU 0.")).toBe("413 This model needs about 30 GB on GPU 0.");
  });
});
