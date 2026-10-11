// The Files panel's routes, over a stand-in for the sandboxed operations
// (core/test/sandbox.test.ts covers those where bubblewrap runs): shapes,
// refusals, who may reach a thread's files, and the served bytes and zip.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    read: async (path: string) => {
      if (path === "/workspace/missing") throw new Error("/workspace/missing is not a file");
      return { stream: Readable.from([Buffer.from("hel"), Buffer.from("lo")]), size: 5, type: "text/plain; charset=utf-8" };
    },
    upload: async (dir: string, name: string, bytes: Buffer) => {
      calls.push(["upload", dir, name, bytes.toString()]);
      if (!dir.startsWith("/workspace")) throw new FilesRefused(`${dir} is read-only in this thread`);
      return `${dir}/${name}`;
    },
    mkdir: async (path: string) => { calls.push(["mkdir", path]); },
    rename: async (from: string, to: string) => { calls.push(["rename", from, to]); if (to.endsWith("taken")) throw new Error(`${to} is already there`); },
    remove: async (paths: string[]) => { calls.push(["remove", paths]); },
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
  const li = await login(dm.base, "li", "pw");
  const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "seeds" })).body;
  const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}/files`;
  return { rt, ...dm, li, thread, path };
}

describe("the Files panel's routes", () => {
  it("lists a folder with the roots, searches, and lists images", async () => {
    const { li, path } = await setup();
    const { calls } = fakeFiles();
    const list = await li.get<FileListing>(path);
    expect(list.status).toBe(200);
    expect(list.body.roots.map((r) => r.path)).toEqual(["/workspace", "/srv/docs"]);
    expect(list.body.dir).toBe("/workspace");
    expect(list.body.entries.map((e) => e.name)).toEqual(["notes", "a.txt"]);
    expect((await li.get<FileListing>(`${path}?dir=${enc("/srv/docs")}`)).body.dir).toBe("/srv/docs");
    expect(calls).toEqual([["list", "/workspace"], ["list", "/srv/docs"]]);
    expect((await li.get<{ entries: { path: string }[] }>(`${path}/search?root=${enc("/workspace")}&q=plan`)).body.entries[0]!.path).toBe("/workspace/plan.txt");
    expect((await li.get<{ source: string }[]>(`${path}/images`)).body[0]!.source).toBe("uploaded");
  });

  it("refuses a path outside the thread's folders and a change in a read-only grant with 403, and a failed change with 400", async () => {
    const { li, path } = await setup();
    fakeFiles();
    expect((await li.get(`${path}?dir=${enc("/etc")}`)).status).toBe(403);
    const up = await li.call<UploadResponse>("POST", `${path}/upload?dir=${enc("/srv/docs")}&name=x.txt`, Buffer.from("x"), { "content-type": "application/octet-stream" });
    expect(up.status).toBe(403);
    expect((await li.post(`${path}/rename`, { from: "/workspace/a", to: "/workspace/taken" })).status).toBe(400);
    expect((await li.post(`${path}/delete`, { paths: "not a list" })).status).toBe(400);
  });

  it("uploads into a folder, makes folders, renames and deletes", async () => {
    const { li, path } = await setup();
    const { calls } = fakeFiles();
    const up = await li.call<UploadResponse>("POST", `${path}/upload?dir=${enc("/workspace/notes")}&name=plan.md`, Buffer.from("# plan"), { "content-type": "application/octet-stream" });
    expect(up.body).toEqual({ path: "/workspace/notes/plan.md" });
    expect((await li.post(`${path}/folder`, { path: "/workspace/out" })).body).toEqual({ ok: true });
    expect((await li.post(`${path}/rename`, { from: "/workspace/a.txt", to: "/workspace/b.txt" })).body).toEqual({ ok: true });
    expect((await li.post(`${path}/delete`, { paths: ["/workspace/b.txt", "/workspace/out"] })).body).toEqual({ ok: true });
    expect(calls).toEqual([
      ["upload", "/workspace/notes", "plan.md", "# plan"], ["mkdir", "/workspace/out"],
      ["rename", "/workspace/a.txt", "/workspace/b.txt"], ["remove", ["/workspace/b.txt", "/workspace/out"]],
    ]);
  });

  it("serves a file's bytes with its type, inline or as a download, never to be run, and streams a zip", async () => {
    const { li, base, path } = await setup();
    fakeFiles();
    const get = (p: string) => fetch(base + p, { headers: { cookie: li.cookie! } });
    const res = await get(`${path}/content?path=${enc("/workspace/a.txt")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''a.txt");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("hello");
    const down = await get(`${path}/content?path=${enc("/workspace/a.txt")}&download=1`);
    expect(down.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''a.txt");
    expect((await get(`${path}/content?path=${enc("/workspace/missing")}`)).status).toBe(400);

    const zip = await fetch(`${base}${path}/zip`, {
      method: "POST", headers: { cookie: li.cookie!, origin: base, "content-type": "application/json" }, body: JSON.stringify({ paths: ["/workspace/notes"] }),
    });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.zip");
    expect(Buffer.from(await zip.arrayBuffer()).toString()).toBe("PK\u0003\u0004zipbytes");
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
