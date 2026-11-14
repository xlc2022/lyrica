// The Images and Videos grids' Sort and Auto-name's suggestions kept apart (docs/ux.md §6).
import { describe, expect, it } from "vitest";
import { apart, sortMedia } from "../src/MediaTools.tsx";

const e = (name: string, modified: string) => ({ name, path: `/workspace/${name}`, modified });
const list = [e("b.png", "2026-11-02T10:00:00Z"), e("a10.png", "2026-11-03T10:00:00Z"), e("a2.png", "2026-11-01T10:00:00Z")];

describe("media sort", () => {
  it("orders by date either way, or by name with numbers read as numbers", () => {
    expect(sortMedia(list, "newest").map((x) => x.name)).toEqual(["a10.png", "b.png", "a2.png"]);
    expect(sortMedia(list, "oldest").map((x) => x.name)).toEqual(["a2.png", "b.png", "a10.png"]);
    expect(sortMedia(list, "name").map((x) => x.name)).toEqual(["a2.png", "a10.png", "b.png"]);
  });

  it("keeps a suggestion apart from another row's in the same folder only", () => {
    const rows = [{ path: "/workspace/x.png", draft: "cat.png" }, { path: "/workspace/sub/y.png", draft: "dog.png" }];
    expect(apart("cat.png", "/workspace", rows)).toBe("cat-2.png");
    expect(apart("dog.png", "/workspace", rows)).toBe("dog.png");
  });
});
