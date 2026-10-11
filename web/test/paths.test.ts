// Which paths in a message become links (web/src/paths.tsx).
import { describe, expect, it } from "vitest";
import { findPaths } from "../src/paths.tsx";

const paths = (text: string) => findPaths(text).map((p) => p.path);

describe("paths named in a message", () => {
  it("finds a path under the thread's folder, bare or in brackets, quotes or code, without trailing punctuation", () => {
    expect(paths("see /workspace/notes.md.")).toEqual(["/workspace/notes.md"]);
    expect(paths("(/workspace/x) and `/workspace/y`, then \"/workspace/z\"!")).toEqual(["/workspace/x", "/workspace/y", "/workspace/z"]);
    expect(paths("the folder /workspace itself and /workspace/uploads/a b.png")).toEqual(["/workspace", "/workspace/uploads/a"]);
    expect(paths("![tray](/workspace/uploads/tray-a.png)")).toEqual(["/workspace/uploads/tray-a.png"]);
  });
  it("leaves another folder's workspace and a URL alone", () => {
    expect(paths("my code is in /home/li/workspace/app")).toEqual([]);
    expect(paths("~/workspace/notes.md and https://git.example/org/workspace/readme")).toEqual([]);
    expect(paths("/workspaces/app and /workspace-old/x")).toEqual([]);
  });
});
