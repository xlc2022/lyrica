import { describe, expect, it, vi } from "vitest";
import { Workspace } from "@lyrica/core";
import type { ArtifactDetail, ArtifactInfo, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const u = `/api/u/${rt.ada.id}`;
  const page = (text: string) => Buffer.from(`<!DOCTYPE html><html><body><script>console.log("${text}")</script></body></html>`);
  const raw = (path: string) => fetch(`${dm.base}${path}`, { headers: { cookie: ada.cookie! } });
  return { ...dm, rt, ada, u, page, raw };
}

describe("artifacts", () => {
  it("import a page, keep each version, restore one, rename and delete", async () => {
    const s = await setup();
    const made = await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/general?name=${enc("status-picker.html")}`, s.page("one"));
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ pool: "general", title: "status picker", kind: "html", version: 1 });
    expect(made.body.thread).toBeUndefined();
    const at = `${s.u}/artifacts/general/${made.body.id}`;

    const two = await s.ada.post<ArtifactDetail>(`${at}/versions?name=x.html`, s.page("two"));
    expect(two.body.versions.map((v) => [v.n, v.author])).toEqual([[2, "user"], [1, "user"]]);
    expect((await s.ada.post(`${at}/versions?name=x.svg`, Buffer.from("<svg/>"))).status).toBe(400);
    const back = await s.ada.post<ArtifactDetail>(`${at}/restore`, { version: 1 });
    expect(back.body.artifact.version).toBe(3);
    expect(await (await s.raw(`${at}/content`)).text()).toContain('"one"');
    expect(await (await s.raw(`${at}/content?v=2`)).text()).toContain('"two"');
    expect((await s.raw(`${at}/content?v=9`)).status).toBe(404);

    expect((await s.ada.patch<ArtifactInfo>(at, { title: "Status model picker" })).body.title).toBe("Status model picker");
    const download = await s.raw(`${at}/content?download=1`);
    expect(download.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Status%20model%20picker.html");
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts`)).body.map((a) => a.title)).toEqual(["Status model picker"]);

    expect((await s.ada.del(at)).status).toBe(200);
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts`)).body).toEqual([]);
    expect((await s.raw(`${at}/view`)).status).toBe(404);
  });

  it("serve a page in the file viewer's sandbox: an opaque origin, nothing run with the internet off, an SVG with nothing run, Markdown only as text", async () => {
    const s = await setup();
    const html = (await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/general?name=a.html`, s.page("hi"))).body;
    const view = await s.raw(`${s.u}/artifacts/general/${html.id}/view`);
    const csp = view.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^sandbox allow-scripts allow-popups;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(view.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await view.text()).startsWith("<!DOCTYPE html><script>")).toBe(true);

    const svg = (await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/general?name=logo.svg`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).body;
    const drawn = await s.raw(`${s.u}/artifacts/general/${svg.id}/view`);
    expect(drawn.headers.get("content-type")).toBe("image/svg+xml");
    expect(drawn.headers.get("content-security-policy")).toContain("default-src 'none'");

    const md = (await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/general?name=notes.md&title=Notes`, Buffer.from("# Notes"))).body;
    expect(md).toMatchObject({ kind: "markdown", title: "Notes" });
    expect((await s.raw(`${s.u}/artifacts/general/${md.id}/view`)).status).toBe(415);

    vi.spyOn(Workspace.prototype, "network").mockReturnValue({ internet: false, services: false, hosts: [] });
    const off = await s.raw(`${s.u}/artifacts/general/${html.id}/view`);
    expect(off.headers.get("content-security-policy")).toMatch(/^sandbox; default-src data: blob: 'unsafe-inline'/);
    expect(await off.text()).not.toContain("lyricaConsole");
    vi.restoreAllMocks();
  });

  it("refuse what isn't an artifact: another kind of file, bytes that aren't text, an empty page, a thread that doesn't exist", async () => {
    const s = await setup();
    expect((await s.ada.post(`${s.u}/artifacts/general?name=photo.png`, Buffer.from("x"))).status).toBe(415);
    expect((await s.ada.post(`${s.u}/artifacts/general?name=a.html`, Buffer.from([60, 0, 62]))).status).toBe(415);
    expect((await s.ada.post(`${s.u}/artifacts/general?name=a.html`, Buffer.alloc(0))).status).toBe(400);
    expect((await s.ada.post(`${s.u}/artifacts/general?name=a.html&thread=web%2Fnone`, s.page("x"))).status).toBe(404);
    expect((await s.ada.post(`${s.u}/artifacts/shared?name=a.html`, s.page("x"))).status).toBe(404);
  });

  it("keep a Private artifact in Private: never listed under General, and gone from every route while the display hides Private", async () => {
    const s = await setup();
    const secret = (await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/private?name=diary.html`, s.page("secret"))).body;
    expect(secret.pool).toBe("private");
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts?pool=general`)).body).toEqual([]);
    expect((await s.raw(`${s.u}/artifacts/general/${secret.id}/view`)).status).toBe(404);
    expect((await s.raw(`${s.u}/artifacts/private/${secret.id}/content`)).status).toBe(200);

    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts`)).body).toEqual([]);
    expect((await s.raw(`${s.u}/artifacts/private/${secret.id}/view`)).status).toBe(404);
    expect((await s.raw(`${s.u}/artifacts/private/${secret.id}/content`)).status).toBe(404);
    expect((await s.ada.del(`${s.u}/artifacts/private/${secret.id}`)).status).toBe(404);
  });

  it("belong to a thread when imported into one, and go when the thread is deleted", async () => {
    const s = await setup();
    const thread = (await s.ada.post<ThreadSummary>(`${s.u}/threads`, { pool: "general", title: "Mockups" })).body;
    const made = (await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/general?name=a.html&thread=${enc(thread.id)}`, s.page("x"))).body;
    expect(made.thread).toBe(thread.id);
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts?thread=${enc(thread.id)}`)).body).toHaveLength(1);
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts?thread=web%2Fother`)).body).toEqual([]);
    expect((await s.ada.del(`${s.u}/threads/general/${enc(thread.id)}`)).status).toBe(200);
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts`)).body).toEqual([]);
  });

  it("go with every thread a delete covers: a child thread's artifact goes when its parent is deleted with its children", async () => {
    const s = await setup();
    const view = s.d.services!.memory.openThreadView(s.rt.ada.id, "general");
    let parent: string, child: string;
    try {
      parent = view.own.createThread({ interface: "web", title: "Parent" }).id;
      child = view.own.createThread({ interface: "web", parent, child: true, title: "Child" }).id;
    } finally { view.close(); }
    const made = (await s.ada.post<ArtifactInfo>(`${s.u}/artifacts/general?name=a.html&thread=${enc(child)}`, s.page("x"))).body;
    expect(made.thread).toBe(child);
    expect((await s.ada.del(`${s.u}/threads/general/${enc(parent)}`, { children: true })).status).toBe(200);
    expect((await s.ada.get<ArtifactInfo[]>(`${s.u}/artifacts`)).body).toEqual([]);
  });
});
