import { describe, expect, it } from "vitest";
import { typeByName } from "../src/workspace/files.ts";
import { looksLikeText } from "../src/workspace/ops.ts";

// The file viewer shows a file as text when its type is text (docs/ux.md, A file opened from a library).
describe("a served file's type", () => {
  const header = Buffer.from("#pragma once\nnamespace nzxt::api { struct Frame; }\n");
  it("is plain text for a source file whatever its extension", () => {
    expect(typeByName("/workspace/include/protocol.hpp", header)).toBe("text/plain; charset=utf-8");
    expect(typeByName("/workspace/Makefile", Buffer.from("all:\n\tcc main.c\n"))).toBe("text/plain; charset=utf-8");
    expect(typeByName("/workspace/empty.cfg", Buffer.alloc(0))).toBe("text/plain; charset=utf-8");
  });
  it("stays a download for binary bytes", () => {
    expect(typeByName("/workspace/model.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00]))).toBe("application/octet-stream");
    expect(typeByName("/workspace/blob.dat", Buffer.from([0xc3, 0x28, 0x41]))).toBe("application/octet-stream");
  });
  it("keeps the types it knows by name", () => {
    expect(typeByName("/workspace/a.json", header)).toBe("application/json");
    expect(typeByName("/workspace/a.mp4", header)).toBe("video/mp4");
    expect(typeByName("/workspace/page.html")).toBe("text/plain; charset=utf-8");
  });
  it("allows a character cut off at the end of the sample", () => {
    const sample = Buffer.from("café ☕");
    expect(looksLikeText(sample.subarray(0, sample.length - 1))).toBe(true);
    expect(looksLikeText(Buffer.from("a\0b"))).toBe(false);
  });
});
