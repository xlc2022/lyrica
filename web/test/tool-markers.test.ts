import { describe, expect, it } from "vitest";
import { isPoll, readImage, readText, summarizeArgs } from "../src/Messages.tsx";

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

describe("a call that only waits", () => {
  const bash = (command: string, result?: string, isError = false) => isPoll({ type: "tool", toolCallId: "c1", name: "bash", args: { command }, result, isError });
  const read = (result?: string, isError = false) => isPoll({ type: "tool", toolCallId: "c1", name: "threads", args: { action: "read", id: "t1" }, result, isError });
  it("is a sleep that printed only its echo, running or done, and a thread read or the guard's refusal of one", () => {
    expect(bash("sleep 120 && echo \"done\"", "done\n")).toBe(true);
    expect(bash("sleep 60; echo 'still waiting'", "still waiting")).toBe(true);
    expect(bash("sleep 5m", "")).toBe(true);
    expect(bash("sleep 180 && echo done")).toBe(true);
    expect(read("Working: step 2 of 4")).toBe(true);
    expect(read("You already read this thread twice with these arguments. If it is still working: ...", true)).toBe(true);
  });
  it("is not a sleep that printed something else or failed, a sleep with more after it, or a read that failed otherwise", () => {
    expect(bash("sleep 60 && echo done", "done\nTerminated")).toBe(false);
    expect(bash("sleep 60 && echo done", "done", true)).toBe(false);
    expect(bash("sleep 60 && tail -5 build.log", "ok")).toBe(false);
    expect(bash("sleep 60 && echo $(cat status)", "ready")).toBe(false);
    expect(read("No thread t1.", true)).toBe(false);
    expect(isPoll({ type: "thinking", text: "Let me wait." })).toBe(false);
  });
});
