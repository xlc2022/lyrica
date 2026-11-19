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
  });

  it("says why a model couldn't load, not that the request was too large, from a host before 507 too", () => {
    const reason = "This model needs about 30.0 GB on GPU 0; it has 48.0 GB, of which 0.0 GB is pinned and 24.0 GB is used by other programs and 0.5 GB is kept free.";
    for (const m of [`413 ${reason}`, `507 ${reason}`, `507 {"error":{"code":"too_big","message":"${reason}"}}`]) expect(replyError(m)).toBe(`The model couldn't load: ${reason}`);
    expect(replyError("413 A context of 131072 tokens needs about 2.1 GB more than GPU 1 has; lower the context length."))
      .toBe("The model couldn't load: A context of 131072 tokens needs about 2.1 GB more than GPU 1 has; lower the context length.");
    expect(replyError("413 This model's weights need about 87.5 GB on GPU 0, more than vLLM's share of 60.2 GB; raise the memory share or use more GPUs."))
      .toBe("The model couldn't load: This model's weights need about 87.5 GB on GPU 0, more than vLLM's share of 60.2 GB; raise the memory share or use more GPUs.");
  });
});
