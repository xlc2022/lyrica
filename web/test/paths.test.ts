// Which paths in a message become links (web/src/paths.tsx).
import { describe, expect, it } from "vitest";
import { fileTarget, findPaths } from "../src/paths.tsx";

const paths = (text: string) => findPaths(text).map((p) => p.path);

describe("paths named in a message", () => {
  it("finds a path under the thread's folder, bare or in brackets, quotes or code, without trailing punctuation", () => {
    expect(paths("see /workspace/notes.md.")).toEqual(["/workspace/notes.md"]);
    expect(paths("(/workspace/x) and `/workspace/y`, then \"/workspace/z\"!")).toEqual(["/workspace/x", "/workspace/y", "/workspace/z"]);
    expect(paths("the folder /workspace itself and /workspace/uploads/a b.png")).toEqual(["/workspace", "/workspace/uploads/a"]);
    expect(paths("![tray](/workspace/uploads/tray-a.png)")).toEqual(["/workspace/uploads/tray-a.png"]);
    expect(paths("notes in /shared/sf2-d/build-notes.md.")).toEqual(["/shared/sf2-d/build-notes.md"]);
  });
  it("leaves another folder's workspace and a URL alone", () => {
    expect(paths("my code is in /home/ada/workspace/app")).toEqual([]);
    expect(paths("~/workspace/notes.md and https://git.example/org/workspace/readme")).toEqual([]);
    expect(paths("/workspaces/app and /workspace-old/x")).toEqual([]);
    expect(paths("/home/ada/shared/x and /shared-old/y")).toEqual([]);
  });
});

describe("a markdown link to a file", () => {
  it("opens the file it names: absolute as it is, relative against the thread's folder", () => {
    expect(fileTarget("/shared/sf2-d/moonbridge-garden.html")).toBe("/shared/sf2-d/moonbridge-garden.html");
    expect(fileTarget("./sf2-d/build-notes.md")).toBe("/workspace/sf2-d/build-notes.md");
    expect(fileTarget("site/a%20b.html#top")).toBe("/workspace/site/a b.html");
    expect(fileTarget("../../shared/x.png")).toBe("/shared/x.png");
    expect(fileTarget("file:///home/ada/notes.md")).toBe("/home/ada/notes.md");
  });
  it("leaves a URL, an anchor and Lyrica's own links alone", () => {
    for (const h of ["https://example.com/a.html", "mailto:ada@example.com", "#/u/1/t/general/x", "#top", "//cdn.example/x.js", "", undefined]) expect(fileTarget(h)).toBeUndefined();
  });
});
