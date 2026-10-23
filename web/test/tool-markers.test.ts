import { describe, expect, it } from "vitest";
import { readImage, summarizeArgs } from "../src/Messages.tsx";

describe("a tool call's marker line", () => {
  it("is empty for a call she is still writing, and the main argument once it runs", () => {
    expect(summarizeArgs({})).toBe("");
    expect(summarizeArgs({ machine: "nas" })).toBe("");
    expect(summarizeArgs({ command: "ls -la\nmore" })).toBe("ls -la");
    expect(summarizeArgs({ action: "start", vm: "101" })).toBe("start 101");
  });
});

describe("the image a read call previews", () => {
  const read = (args: unknown, result = "Read image file [image/png]", isError = false) =>
    readImage({ type: "tool", toolCallId: "c1", name: "read", args, result, isError });
  it("is the file she read as an image, a relative path against the thread's folder", () => {
    expect(read({ path: "/workspace/view2/final_z.png" })).toBe("/workspace/view2/final_z.png");
    expect(read({ path: "view2/final_z.png" })).toBe("/workspace/view2/final_z.png");
    expect(read({ path: "/shared/a.jpg" }, "Read image file [image/jpeg]\n[Current model does not support images.]")).toBe("/shared/a.jpg");
  });
  it("is nothing for text, a failed or running read, a machine's file, a home path or another tool", () => {
    expect(read({ path: "/workspace/notes.md" }, "hello")).toBeUndefined();
    expect(read({ path: "/workspace/a.png" }, "ENOENT", true)).toBeUndefined();
    expect(readImage({ type: "tool", toolCallId: "c1", name: "read", args: { path: "/workspace/a.png" } })).toBeUndefined();
    expect(read({ path: "/home/ada/a.png", machine: "nas" })).toBeUndefined();
    expect(read({ path: "~/a.png" })).toBeUndefined();
    expect(readImage({ type: "tool", toolCallId: "c1", name: "bash", args: { path: "/workspace/a.png" }, result: "Read image file [image/png]" })).toBeUndefined();
  });
});
