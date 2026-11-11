import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_LIMIT, artifactKind, ArtifactLibrary, migrate, openEncrypted, titleFromName } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function library() {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-artifacts-"));
  dirs.push(dir);
  const db = openEncrypted(join(dir, "general.db"), { raw: Buffer.alloc(32, 7) });
  migrate(db, "pool");
  let tick = 0;
  return new ArtifactLibrary(db, "general", () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
}
const page = (text: string) => Buffer.from(`<!doctype html><p>${text}</p>`);

describe("artifacts", () => {
  it("keep every version: a publish from the same path adds one, an unchanged page adds none, and an old version never changes", () => {
    const a = library();
    const first = a.publish({ thread: "web/t1", path: "/thread/site/index.html", kind: "html", bytes: page("one"), author: "lyrica" });
    expect(first).toMatchObject({ created: true, artifact: { title: "index", version: 1, thread: "web/t1", pool: "general" } });
    const second = a.publish({ thread: "web/t1", path: "/thread/site/index.html", kind: "html", bytes: page("two"), title: "The site", author: "lyrica" });
    expect(second).toMatchObject({ created: false, artifact: { id: first.artifact.id, title: "The site", version: 2 } });
    expect(a.publish({ thread: "web/t1", path: "/thread/site/index.html", kind: "html", bytes: page("two"), author: "lyrica" }).artifact.version).toBe(2);
    expect(a.read(first.artifact.id, 1)?.bytes.toString()).toContain("one");
    expect(a.read(first.artifact.id)?.bytes.toString()).toContain("two");
    expect(a.versions(first.artifact.id).map((v) => [v.n, v.author])).toEqual([[2, "lyrica"], [1, "lyrica"]]);
    // Another thread's page at the same path is its own artifact.
    expect(a.publish({ thread: "web/t2", path: "/thread/site/index.html", kind: "html", bytes: page("other"), author: "lyrica" }).created).toBe(true);
    expect(a.list({ threads: ["web/t1"] })).toHaveLength(1);
    expect(a.list()).toHaveLength(2);
  });

  it("restore an old version as a new one, by the person, and rename", () => {
    const a = library();
    const { artifact } = a.publish({ thread: "web/t1", path: "/thread/a.html", kind: "html", bytes: page("one"), author: "lyrica" });
    a.addVersion(artifact.id, { bytes: page("two"), author: "user" });
    const restored = a.restore(artifact.id, 1, "user");
    expect(restored.version).toBe(3);
    expect(a.read(artifact.id)?.bytes.toString()).toContain("one");
    expect(a.versions(artifact.id)[0]).toMatchObject({ n: 3, author: "user" });
    expect(a.rename(artifact.id, "  A  name ").title).toBe("A name");
    expect(() => a.rename(artifact.id, " ")).toThrow(/needs a title/);
    expect(() => a.restore(artifact.id, 9, "user")).toThrow(/No version 9/);
  });

  it("let her add a version by an artifact's id only in her own thread or its project, and never change its kind", () => {
    const a = library();
    const { artifact } = a.publish({ thread: "web/t1", path: "/thread/a.html", kind: "html", bytes: page("one"), author: "lyrica" });
    expect(() => a.publish({ thread: "web/t9", path: "/thread/b.html", kind: "html", artifact: artifact.id, bytes: page("x"), author: "lyrica" })).toThrow(/No artifact/);
    expect(a.publish({ thread: "web/t2", threads: ["web/t1"], path: "/thread/b.html", kind: "html", artifact: artifact.id, bytes: page("x"), author: "lyrica" }).artifact.version).toBe(2);
    expect(() => a.publish({ thread: "web/t1", path: "/thread/a.svg", kind: "svg", artifact: artifact.id, bytes: Buffer.from("<svg/>"), author: "lyrica" })).toThrow(/is html/);
  });

  it("refuse an empty page and one over the limit", () => {
    const a = library();
    expect(() => a.create({ title: "Empty", kind: "html", bytes: Buffer.alloc(0), author: "user" })).toThrow(/empty/);
    expect(() => a.create({ title: "Big", kind: "html", bytes: Buffer.alloc(ARTIFACT_LIMIT + 1), author: "user" })).toThrow(/16 MiB/);
  });

  it("go with a deleted thread; delete takes every version", () => {
    const a = library();
    const one = a.publish({ thread: "web/t1", path: "/thread/a.html", kind: "html", bytes: page("one"), author: "lyrica" }).artifact;
    const two = a.publish({ thread: "web/t2", path: "/thread/a.html", kind: "html", bytes: page("two"), author: "lyrica" }).artifact;
    const own = a.create({ title: "Imported", kind: "markdown", thread: "web/t2", bytes: Buffer.from("# Hi"), author: "user" });
    a.forgetThread("web/t1");
    expect(a.get(one.id)).toBeUndefined();
    expect(a.read(one.id)).toBeUndefined();
    a.delete(own.id);
    expect(a.list().map((x) => x.id)).toEqual([two.id]);
  });

  it("know a file's kind and title from its name", () => {
    expect(["a.html", "a.HTM", "a.svg", "a.md", "a.jsx", "a.tsx", "a.png"].map(artifactKind)).toEqual(["html", "html", "svg", "markdown", "react", "react", undefined]);
    expect(titleFromName("/thread/status-model_picker.single.html")).toBe("status model picker");
  });
});
