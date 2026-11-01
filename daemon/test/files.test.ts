// The Files panel's routes, over a stand-in for the sandboxed operations
// (core/test/sandbox.test.ts covers those where bubblewrap runs): shapes,
// refusals, who may reach a thread's files, and the served bytes and zip.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FilesRefused, Workspace, type Sandbox, type ThreadFiles } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileListing, ThreadSummary, UploadResponse } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

afterEach(() => { vi.restoreAllMocks(); });

const enc = encodeURIComponent;

/** A panel over an in-memory folder, with the real refusals. */
function fakeFiles() {
  const calls: unknown[][] = [];
  const entry = (path: string, kind: "file" | "folder" = "file") => ({ name: path.split("/").pop()!, path, kind, size: 3, modified: "2026-10-11T20:00:00.000Z" });
  const files = {
    roots: () => [{ path: "/workspace", writable: true, kind: "thread" as const }, { path: "/srv/docs", writable: false, kind: "grant" as const }],
    list: async (dir: string) => {
      calls.push(["list", dir]);
      if (dir.startsWith("/etc")) throw new FilesRefused(`${dir} is outside this thread's folders`);
      return { entries: [entry(`${dir}/notes`, "folder"), entry(`${dir}/a.txt`)], more: false };
    },
    search: async (root: string, q: string) => ({ entries: q ? [entry(`${root}/${q}.txt`)] : [], more: false }),
    images: async () => [{ ...entry("/workspace/uploads/cat.png"), source: "uploaded" as const }],
    videos: async () => [{ ...entry("/workspace/videos/fox.mp4"), source: "made" as const }],
    read: async (path: string, range?: { start: number; end?: number }) => {
      if (path === "/workspace/missing") throw new Error("/workspace/missing is not a file");
      if (range && range.start >= 5) throw new RangeError("the range is outside the file");
      if (range) return { stream: Readable.from([Buffer.from("hello".slice(range.start, (range.end ?? 4) + 1))]), size: 5, type: "video/mp4" };
      return { stream: Readable.from([Buffer.from("hel"), Buffer.from("lo")]), size: 5, type: "text/plain; charset=utf-8" };
    },
    upload: async (dir: string, name: string, bytes: Buffer) => {
      calls.push(["upload", dir, name, bytes.toString()]);
      if (!dir.startsWith("/workspace")) throw new FilesRefused(`${dir} is read-only in this thread`);
      return `${dir}/${name}`;
    },
    mkdir: async (path: string) => { calls.push(["mkdir", path]); },
    rename: async (from: string, to: string) => { calls.push(["rename", from, to]); if (to.endsWith("taken")) throw new Error(`${to} is already there`); return { from, to }; },
    remove: async (paths: string[]) => { calls.push(["remove", paths]); },
    thumb: async (path: string) => (path.startsWith("/workspace/") ? { bytes: Buffer.from("tiny"), type: "image/png" } : undefined),
    zip: async (paths: string[]) => {
      calls.push(["zip", paths]);
      return Readable.from([Buffer.from("PK\u0003\u0004zipbytes")]);
    },
  };
  vi.spyOn(Workspace.prototype, "files").mockReturnValue(files as unknown as ThreadFiles);
  return { files, calls };
}

async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "seeds" })).body;
  const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}/files`;
  return { rt, ...dm, ada, thread, path };
}

describe("the Files panel's routes", () => {
  it("lists a folder with the roots, searches, and lists images and videos", async () => {
    const { ada, path } = await setup();
    const { calls } = fakeFiles();
    const list = await ada.get<FileListing>(path);
    expect(list.status).toBe(200);
    expect(list.body.roots.map((r) => r.path)).toEqual(["/workspace", "/srv/docs"]);
    expect(list.body.dir).toBe("/workspace");
    expect(list.body.entries.map((e) => e.name)).toEqual(["notes", "a.txt"]);
    expect((await ada.get<FileListing>(`${path}?dir=${enc("/srv/docs")}`)).body.dir).toBe("/srv/docs");
    expect(calls).toEqual([["list", "/workspace"], ["list", "/srv/docs"]]);
    expect((await ada.get<{ entries: { path: string }[] }>(`${path}/search?root=${enc("/workspace")}&q=plan`)).body.entries[0]!.path).toBe("/workspace/plan.txt");
    expect((await ada.get<{ source: string }[]>(`${path}/images`)).body[0]!.source).toBe("uploaded");
    expect((await ada.get<{ path: string; source: string }[]>(`${path}/videos`)).body[0]).toMatchObject({ path: "/workspace/videos/fox.mp4", source: "made" });
  });

  it("refuses a path outside the thread's folders and a change in a read-only grant with 403, and a failed change with 400", async () => {
    const { ada, path } = await setup();
    fakeFiles();
    expect((await ada.get(`${path}?dir=${enc("/etc")}`)).status).toBe(403);
    const up = await ada.call<UploadResponse>("POST", `${path}/upload?dir=${enc("/srv/docs")}&name=x.txt`, Buffer.from("x"), { "content-type": "application/octet-stream" });
    expect(up.status).toBe(403);
    expect((await ada.post(`${path}/rename`, { from: "/workspace/a", to: "/workspace/taken" })).status).toBe(400);
    expect((await ada.post(`${path}/delete`, { paths: "not a list" })).status).toBe(400);
  });

  it("uploads into a folder, makes folders, renames and deletes", async () => {
    const { ada, path } = await setup();
    const { calls } = fakeFiles();
    const up = await ada.call<UploadResponse>("POST", `${path}/upload?dir=${enc("/workspace/notes")}&name=plan.md`, Buffer.from("# plan"), { "content-type": "application/octet-stream" });
    expect(up.body).toEqual({ path: "/workspace/notes/plan.md" });
    expect((await ada.post(`${path}/folder`, { path: "/workspace/out" })).body).toEqual({ ok: true });
    expect((await ada.post(`${path}/rename`, { from: "/workspace/a.txt", to: "/workspace/b.txt" })).body).toEqual({ ok: true });
    expect((await ada.post(`${path}/delete`, { paths: ["/workspace/b.txt", "/workspace/out"] })).body).toEqual({ ok: true });
    expect(calls).toEqual([
      ["upload", "/workspace/notes", "plan.md", "# plan"], ["mkdir", "/workspace/out"],
      ["rename", "/workspace/a.txt", "/workspace/b.txt"], ["remove", ["/workspace/b.txt", "/workspace/out"]],
    ]);
  });

  it("rewrites the stored mentions of a renamed file in the thread and its family, and leaves other threads and similar names alone", async () => {
    const { ada, d, rt, thread, path } = await setup();
    fakeFiles();
    const view = d.services!.memory.openThreadView(rt.ada.id, "general");
    let other = "";
    try {
      const said = "Here: /workspace/uploads/cat.png, and [the same](uploads/cat.png). Not /workspace/uploads/cat.png.bak.";
      view.own.appendEntry(thread.id, { piId: "u1", role: "user", data: { type: "message", message: { role: "user", content: said } }, text: said });
      const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "file /workspace/uploads/cat.png" } };
      view.own.appendEntry(thread.id, { piId: "a1", role: "assistant", text: `bash(${JSON.stringify(call.arguments)})`,
        data: { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "/workspace/uploads/cat.png", thinkingSignature: "sig" }, call] } } });
      view.own.setDraft(thread.id, "/workspace/uploads/cat.png\nlook");
      other = view.own.createThread({ interface: "web", title: "elsewhere" }).id;
      view.own.appendEntry(other, { piId: "o1", role: "user", data: { type: "message", message: { role: "user", content: "/workspace/uploads/cat.png" } }, text: "/workspace/uploads/cat.png" });
    } finally { view.close(); }
    expect((await ada.post(`${path}/rename`, { from: "/workspace/uploads/cat.png", to: "/workspace/uploads/tabby.png" })).body).toEqual({ ok: true });
    const after = d.services!.memory.openThreadView(rt.ada.id, "general");
    try {
      const [user, reply] = after.own.loadEntries(thread.id) as { message: { content: unknown } }[];
      expect(user!.message.content).toBe("Here: /workspace/uploads/tabby.png, and [the same](uploads/tabby.png). Not /workspace/uploads/cat.png.bak.");
      // Her tool call follows the file; her reasoning is left word for word (a provider checks it against its signature).
      expect(reply!.message.content).toEqual([{ type: "thinking", thinking: "/workspace/uploads/cat.png", thinkingSignature: "sig" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "file /workspace/uploads/tabby.png" } }]);
      expect(after.own.draft(thread.id)?.text).toBe("/workspace/uploads/tabby.png\nlook");
      // Another thread's /workspace is another folder.
      expect((after.own.loadEntries(other)[0] as { message: { content: string } }).message.content).toBe("/workspace/uploads/cat.png");
    } finally { after.close(); }
    // Search finds the new name.
    expect((await ada.get<{ snippet: string }[]>(`/api/u/${rt.ada.id}/memory/search?kinds=entry&q=tabby`)).body.length).toBeGreaterThan(0);
  });

  it("serves a file's bytes with its type, inline or as a download, never to be run, and streams a zip", async () => {
    const { ada, base, path } = await setup();
    fakeFiles();
    const get = (p: string) => fetch(base + p, { headers: { cookie: ada.cookie! } });
    const res = await get(`${path}/content?path=${enc("/workspace/a.txt")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''a.txt");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("hello");
    const thumb = await get(`${path}/thumb?path=${enc("/workspace/uploads/cat.png")}`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/png");
    expect(thumb.headers.get("content-security-policy")).toContain("sandbox");
    expect(await thumb.text()).toBe("tiny");
    expect((await get(`${path}/thumb?path=${enc("/srv/docs/cat.png")}`)).status).toBe(404);
    const down = await get(`${path}/content?path=${enc("/workspace/a.txt")}&download=1`);
    expect(down.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''a.txt");
    expect((await get(`${path}/content?path=${enc("/workspace/missing")}`)).status).toBe(400);
    // A clip opened from Files seeks with one byte range, as on `…/file`.
    const part = await fetch(`${base}${path}/content?path=${enc("/workspace/videos/a.mp4")}`, { headers: { cookie: ada.cookie!, range: "bytes=1-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(part.headers.get("content-length")).toBe("3");
    expect(await part.text()).toBe("ell");
    expect((await fetch(`${base}${path}/content?path=${enc("/workspace/videos/a.mp4")}`, { headers: { cookie: ada.cookie!, range: "bytes=9-" } })).status).toBe(416);

    const zip = await fetch(`${base}${path}/zip`, {
      method: "POST", headers: { cookie: ada.cookie!, origin: base, "content-type": "application/json" }, body: JSON.stringify({ paths: ["/workspace/notes"] }),
    });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.zip");
    expect(Buffer.from(await zip.arrayBuffer()).toString()).toBe("PK\u0003\u0004zipbytes");
  });

  it("serves HTML as a sandboxed page with its console bridge, SVG with nothing run, and only a real PDF", async () => {
    const { ada, base, path } = await setup();
    const { files } = fakeFiles();
    const bodies: Record<string, string> = {
      "/workspace/site/index.html": "<!DOCTYPE html><html><body><script>console.log(1)</script></body></html>",
      "/workspace/bare.htm": "<p>hi</p>",
      "/workspace/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
      "/workspace/paper.pdf": "%PDF-1.7 rest",
      "/workspace/fake.pdf": "<script>alert(1)</script>",
    };
    files.read = async (p: string) => ({ stream: Readable.from([Buffer.from(bodies[p] ?? "")]), size: Buffer.byteLength(bodies[p] ?? ""), type: "text/plain; charset=utf-8" });
    const get = (p: string) => fetch(`${base}${path}/view?path=${enc(p)}`, { headers: { cookie: ada.cookie! } });

    const html = await get("/workspace/site/index.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = html.headers.get("content-security-policy")!;
    // An opaque origin: never allow-same-origin, top navigation or forms.
    expect(csp).toMatch(/^sandbox allow-scripts allow-popups;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(html.headers.get("x-frame-options")).toBeNull();
    const text = await html.text();
    expect(text.startsWith("<!DOCTYPE html><script>")).toBe(true);
    expect(text).toContain("lyricaConsole");
    expect(text.endsWith("<script>console.log(1)</script></body></html>")).toBe(true);
    expect((await (await get("/workspace/bare.htm")).text())).toMatch(/^<script>.*<\/script><p>hi<\/p>$/s);

    const svg = await get("/workspace/logo.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    expect(await svg.text()).toBe(bodies["/workspace/logo.svg"]);

    const pdf = await get("/workspace/paper.pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect((await get("/workspace/fake.pdf")).status).toBe(415);
    expect((await get("/workspace/a.txt")).status).toBe(415);
  });

  it("serves HTML with nothing run and nothing fetched when the thread's internet is off", async () => {
    const { ada, base, path } = await setup();
    const { files } = fakeFiles();
    const page = "<!DOCTYPE html><img src=\"https://example.com/x?d=1\"><script>fetch('https://example.com')</script>";
    files.read = async () => ({ stream: Readable.from([Buffer.from(page)]), size: Buffer.byteLength(page), type: "text/plain; charset=utf-8" });
    vi.spyOn(Workspace.prototype, "network").mockReturnValue({ internet: false, services: false, hosts: [] });
    const res = await fetch(`${base}${path}/view?path=${enc("/workspace/page.html")}`, { headers: { cookie: ada.cookie! } });
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe("sandbox; default-src data: blob: 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).not.toContain("https:");
    // No console bridge: it couldn't run.
    expect(await res.text()).toBe(page);
  });

  it("names the thread that wrote each file, and a whole listing forgets what is gone", async () => {
    const { ada, path, thread, rt, d } = await setup();
    fakeFiles();
    const t = { userId: rt.ada.id, pool: "general" as const, threadId: thread.id };
    d.services!.workspace.madeFiles(t, ["/workspace/a.txt", "/workspace/gone.txt"]);
    const list = await ada.get<FileListing>(path);
    expect(list.body.entries.map((e) => [e.name, e.madeBy])).toEqual([["notes", undefined], ["a.txt", thread.id]]);
    // gone.txt wasn't in the listing, so its record went.
    expect(d.services!.workspace.settings(rt.ada.id).origins(thread.id, ["a.txt", "gone.txt"]).size).toBe(1);
    expect((await ada.get<{ entries: { madeBy?: string }[] }>(`${path}/search?root=${enc("/workspace")}&q=a`)).body.entries[0]!.madeBy).toBe(thread.id);
  });

  it("is only the thread owner's, like the rest of a thread", async () => {
    const { base, path } = await setup();
    fakeFiles();
    const sam = await login(base, "sam", "pw2");
    expect((await sam.get(path)).status).toBe(401);
  });
});

/** The real zip writer, over a real sandbox where one runs; elsewhere the bytes are checked with a tiny parse. */
describe("the zip the panel streams", () => {
  it("is a zip unzip can read, made without a temp file", async () => {
    const { ThreadFiles } = await import("@lyrica/core");
    const dir = mkdtempSync(join(tmpdir(), "lyrica-zip-"));
    try {
      writeFileSync(join(dir, "a.txt"), "alpha");
      // A stand-in sandbox that runs cat and find on the host, so the writer itself is checked here.
      const box = {
        allow: (p: string) => p,
        run: async (argv: string[]) => {
          const out = execFileSync(argv[0]!, argv.slice(1));
          return { code: 0, signal: null, stdout: out, stderr: Buffer.alloc(0) };
        },
        start: async (argv: string[]) => {
          const { spawn } = await import("node:child_process");
          return spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
        },
      };
      const files = new ThreadFiles(box as unknown as Sandbox, []);
      const chunks: Buffer[] = [];
      for await (const c of await files.zip([join(dir, "a.txt")])) chunks.push(c as Buffer);
      const zip = Buffer.concat(chunks);
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(readdirSync(dir)).toEqual(["a.txt"]);
      const zipPath = join(dir, "out.zip");
      writeFileSync(zipPath, zip);
      let listed = "";
      try { listed = execFileSync("unzip", ["-l", zipPath]).toString(); } catch { return; /* no unzip here */ }
      expect(listed).toContain("a.txt");
      expect(execFileSync("unzip", ["-p", zipPath, "a.txt"]).toString()).toBe("alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A clip's thumbnail is the poster saved with it (ThreadImages.saveVideo): served, moved and deleted with it, never made. */
describe("a clip's poster", () => {
  it("is served as the clip's thumbnail, moves when the clip is renamed and goes when it is deleted", async () => {
    const { ThreadFiles } = await import("@lyrica/core");
    const dir = mkdtempSync(join(tmpdir(), "lyrica-clip-thumbs-"));
    try {
      const box = { allow: (p: string) => p, run: async (argv: string[]) => {
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync(argv[0]!, argv.slice(1));
        return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
      } };
      const files = new ThreadFiles(box as unknown as Sandbox, [], () => {}, dir);
      mkdirSync(join(dir, "videos")); mkdirSync(join(dir, ".lyrica", "thumbs", "videos"), { recursive: true });
      writeFileSync(join(dir, "videos", "a.mp4"), "clip");
      expect(await files.thumb(join(dir, "videos", "a.mp4"))).toBeUndefined();
      writeFileSync(join(dir, ".lyrica", "thumbs", "videos", "a.mp4.png"), "poster");
      expect(await files.thumb(join(dir, "videos", "a.mp4"))).toEqual({ bytes: Buffer.from("poster"), type: "image/png" });
      await files.rename(join(dir, "videos"), join(dir, "clips"));
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual(["clips"]);
      expect((await files.thumb(join(dir, "clips", "a.mp4")))?.bytes.toString()).toBe("poster");
      await files.remove([join(dir, "clips", "a.mp4")]);
      expect(readdirSync(join(dir, ".lyrica", "thumbs", "clips"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a ranged read in the thread's sandbox", () => {
  it("sends only the asked bytes and refuses a range past the end", async () => {
    const { ThreadFiles } = await import("@lyrica/core");
    const dir = mkdtempSync(join(tmpdir(), "lyrica-range-"));
    try {
      writeFileSync(join(dir, "a.mp4"), "0123456789");
      const { spawn, spawnSync } = await import("node:child_process");
      const box = {
        allow: (p: string) => p,
        run: async (argv: string[]) => { const r = spawnSync(argv[0]!, argv.slice(1)); return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr }; },
        start: async (argv: string[]) => spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] }),
      };
      const files = new ThreadFiles(box as unknown as Sandbox, [], () => {}, dir);
      const text = async (r: { stream: Readable }) => { const c: Buffer[] = []; for await (const b of r.stream) c.push(b as Buffer); return Buffer.concat(c).toString(); };
      const middle = await files.read(join(dir, "a.mp4"), { start: 2, end: 5 });
      expect([middle.size, await text(middle)]).toEqual([10, "2345"]);
      expect(await text(await files.read(join(dir, "a.mp4"), { start: 7 }))).toBe("789");
      expect(await text(await files.read(join(dir, "a.mp4"), { start: 8, end: 99 }))).toBe("89");
      await expect(files.read(join(dir, "a.mp4"), { start: 10 })).rejects.toThrow(RangeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Thumbnails over the same stand-in, where ImageMagick is on the host; made in the sandbox, kept beside the thread's files, gone with them. */
describe("the thumbnails the panel serves", () => {
  it("makes a small copy once, keeps it until the image changes, and deletes it with the image, however it goes", async () => {
    try { execFileSync("convert", ["-version"]); } catch { return; /* no ImageMagick here */ }
    const { ThreadFiles } = await import("@lyrica/core");
    const dir = mkdtempSync(join(tmpdir(), "lyrica-thumbs-"));
    try {
      const box = {
        allow: (p: string) => p,
        run: async (argv: string[]) => {
          const { spawnSync } = await import("node:child_process");
          const r = spawnSync(argv[0]!, argv.slice(1));
          return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
        },
      };
      const files = new ThreadFiles(box as unknown as Sandbox, [], () => {}, dir);
      execFileSync("convert", ["-size", "900x600", "xc:green", join(dir, "big.png")]);
      const first = await files.thumb(join(dir, "big.png"));
      expect(first?.type).toBe("image/png");
      // A PNG's width and height sit at bytes 16 and 20 of its header.
      expect([first!.bytes.readUInt32BE(16), first!.bytes.readUInt32BE(20)]).toEqual([320, 213]);
      const cache = join(dir, ".lyrica", "thumbs", "big.png.png");
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual(["big.png.png"]);
      const again = await files.thumb(join(dir, "big.png"));
      expect(again!.bytes.equals(first!.bytes)).toBe(true);
      // Outside the thread's folder, or not named like an image, there is no copy; a missing file is an error.
      expect(await files.thumb("/srv/docs/x.png")).toBeUndefined();
      writeFileSync(join(dir, "notes.txt"), "push 'viewbox 0 0 9 9'");
      expect(await files.thumb(join(dir, "notes.txt"))).toBeUndefined();
      await expect(files.thumb(join(dir, "none.png"))).rejects.toThrow("is not a file");
      // A .png that holds something else (here MVG drawing commands, which can read and write files) is decoded as PNG and fails.
      writeFileSync(join(dir, "fake.png"), "push graphic-context\nviewbox 0 0 9 9\nfill red\nrectangle 0,0 8,8\npop graphic-context\n");
      await expect(files.thumb(join(dir, "fake.png"))).rejects.toThrow();
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual(["big.png.png"]);
      // Deleting the image deletes the copy; renaming it moves the copy along.
      await files.remove([join(dir, "big.png")]);
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual([]);
      execFileSync("convert", ["-size", "40x40", "xc:blue", join(dir, "small.jpg")]);
      expect((await files.thumb(join(dir, "small.jpg")))?.type).toBe("image/jpeg");
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual(["small.jpg.jpg"]);
      await files.rename(join(dir, "small.jpg"), join(dir, "moved.jpg"));
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual(["moved.jpg.jpg"]);
      await files.remove([join(dir, "moved.jpg")]);
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual([".lyrica", "fake.png", "notes.txt"]);
      // An image deleted or moved by a command, outside the panel: its copy goes when the panel next lists or asks.
      mkdirSync(join(dir, "art"));
      execFileSync("convert", ["-size", "40x40", "xc:red", join(dir, "art", "a.png")]);
      execFileSync("convert", ["-size", "40x40", "xc:red", join(dir, "kept.png")]);
      await files.thumb(join(dir, "art", "a.png"));
      await files.thumb(join(dir, "kept.png"));
      rmSync(join(dir, "art"), { recursive: true });
      await files.pruneThumbs();
      // Its emptied folder stays a minute, since a thumbnail being made may have just made it.
      expect(readdirSync(join(dir, ".lyrica", "thumbs")).sort()).toEqual(["art", "kept.png.png"]);
      expect(readdirSync(join(dir, ".lyrica", "thumbs", "art"))).toEqual([]);
      rmSync(join(dir, "kept.png"));
      await expect(files.thumb(join(dir, "kept.png"))).rejects.toThrow("is not a file");
      expect(readdirSync(join(dir, ".lyrica", "thumbs"))).toEqual(["art"]);
      void cache;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
