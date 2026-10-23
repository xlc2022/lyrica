import { describe, expect, it } from "vitest";
import { readImage, readText, summarizeArgs } from "../src/Messages.tsx";

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

describe("the text a read call shows", () => {
  const read = (path: string, result: string, extra: Record<string, unknown> = {}) =>
    readText({ type: "tool", toolCallId: "c1", name: "read", args: { path, ...extra }, result, isError: false });
  it("keeps the file's text as it is, takes pi's note off the end, and picks a layout by the name", () => {
    expect(read("src/a.ts", "  if (x) {\n\treturn 1;\n  }")).toEqual({ path: "src/a.ts", text: "  if (x) {\n\treturn 1;\n  }", note: undefined, kind: "code", local: true });
    expect(read("/workspace/notes.md", "# Notes\n\n[Showing lines 1-60 of 900. Use offset=61 to continue.]")).toMatchObject({ text: "# Notes", note: "Showing lines 1-60 of 900", kind: "markdown" });
    expect(read("/workspace/page.html", "<p>hi</p>\n\n[12 more lines in file. Use offset=40 to continue.]")).toMatchObject({ text: "<p>hi</p>", note: "12 more lines in file", kind: "code" });
    expect(read("/var/log/app.log", "line", { machine: "nas" })).toMatchObject({ kind: "wrapped", local: false });
  });
  it("is nothing for an image, a failed read or another tool", () => {
    expect(read("/workspace/a.png", "Read image file [image/png]")).toBeUndefined();
    expect(readText({ type: "tool", toolCallId: "c1", name: "read", args: { path: "a.ts" }, result: "ENOENT", isError: true })).toBeUndefined();
    expect(readText({ type: "tool", toolCallId: "c1", name: "bash", args: { path: "a.ts" }, result: "x" })).toBeUndefined();
  });
});
