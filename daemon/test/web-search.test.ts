import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadSettings, WebSearch } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

// Administration → Web search: the server's SearXNG address, and the kiwix-serve with its offline copy of Wikipedia.

const NO_KIWIX = { kiwix: null, kiwixState: "unset", books: [] };

/** A kiwix-serve whose catalog has one book. */
async function kiwix() {
  const srv = createServer((req, res) => {
    if (req.url === "/raw/wikipedia_en_all_nopic_2026-06/content/I/Lute.webp") { res.writeHead(200, { "content-type": "image/webp" }); return res.end("RIFF....WEBPVP8 "); }
    if (req.url === "/raw/wikipedia_en_all_nopic_2026-06/content/A/Lute") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<p>Lute</p>"); }
    if (req.url !== "/catalog/v2/entries") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/atom+xml" });
    res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Wikipedia</title><updated>2026-06-01T00:00:00Z</updated><language>eng</language><name>wikipedia_en_all_nopic</name><link type="text/html" href="/content/wikipedia_en_all_nopic_2026-06" /></entry></feed>`);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A SearXNG that answers JSON, or 403 as one with the json format off does; with `auth`, only to that basic auth. */
async function searxng(o: { json?: boolean; auth?: string } = {}) {
  const srv = createServer((req, res) => {
    if (o.auth && req.headers.authorization !== `Basic ${Buffer.from(o.auth).toString("base64")}`) { res.writeHead(401); return res.end(); }
    if (o.json === false || !req.url?.startsWith("/search")) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ title: "SearXNG", url: "https://docs.searxng.org", content: "A metasearch engine." }] }));
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

async function setup() {
  const rt = await runtime();
  const { base, logs } = await daemon(rt);
  await browser(base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(base, "ada", "pw");
  return { rt, base, logs, ada, url: `/api/u/${rt.ada.id}/admin/web-search` };
}

describe("web search", () => {
  it("saves the address, says whether SearXNG answers, and is for administrators only", async () => {
    const { rt, base, ada, url } = await setup();
    expect((await ada.get<WebSearch>(url)).body).toEqual({ searxng: null, auth: false, state: "unset", ...NO_KIWIX });

    const good = `http://${await searxng()}`;
    expect((await ada.put<WebSearch>(url, { searxng: `${good}/` })).body).toEqual({ searxng: good, auth: false, state: "reachable", ...NO_KIWIX });
    const bad = (await ada.put<WebSearch>(url, { searxng: `http://${await searxng({ json: false })}` })).body;
    expect(bad).toMatchObject({ state: "unreachable" });
    expect(bad.reason).toContain("json format");
    expect((await ada.put(url, { searxng: "ftp://x" })).status).toBe(400);

    const sam = await login(base, "sam", "pw2");
    const samUrl = url.replace(rt.ada.id, rt.sam.id);
    expect((await sam.get(samUrl)).status).toBe(403);
    expect((await sam.put(samUrl, { searxng: good })).status).toBe(403);
    expect((await sam.get(url)).status).toBe(401);

    // A thread's settings say whether search has a provider, for the switch's tooltip.
    const thread = (await ada.post<{ id: string }>(`/api/u/${rt.ada.id}/threads`, { pool: "general" })).body;
    const settings = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}/settings`;
    expect((await ada.get<ThreadSettings>(settings)).body.searchProvider).toBe(true);
    await ada.put(url, { searxng: "" });
    expect((await ada.get<ThreadSettings>(settings)).body.searchProvider).toBe(false);

    // The Kiwix address, saved on its own, names the books; it counts as a provider too.
    const k = await kiwix();
    const withKiwix = (await ada.put<WebSearch>(url, { kiwix: `${k}/` })).body;
    expect(withKiwix).toEqual({ searxng: null, auth: false, state: "unset", kiwix: k, kiwixState: "reachable", books: [{ name: "wikipedia_en_all_nopic", title: "Wikipedia", language: "eng", date: "2026-06-01" }] });
    expect((await ada.get<ThreadSettings>(settings)).body.searchProvider).toBe(true);
    expect((await ada.put<WebSearch>(url, { searxng: good })).body).toMatchObject({ searxng: good, kiwix: k });
    expect((await ada.put<WebSearch>(url, { kiwix: `http://${await searxng()}` })).body).toMatchObject({ kiwixState: "unreachable", kiwixReason: expect.stringContaining("catalog") });
    expect((await ada.put(url, { kiwix: "ftp://x" })).status).toBe(400);
    expect((await ada.put<WebSearch>(url, { kiwix: null })).body).toMatchObject({ searxng: good, ...NO_KIWIX });
  });

  it("shows a picture of the offline copy to a signed-in user, and nothing else", async () => {
    const { rt, base, ada, url } = await setup();
    const k = await kiwix();
    const picture = (u: string, cookie = ada.cookie) => fetch(`${base}/api/u/${rt.ada.id}/web/picture?url=${encodeURIComponent(u)}`, { headers: cookie ? { cookie } : {} });
    const lute = `${k}/content/wikipedia_en_all_nopic_2026-06/I/Lute.webp`;
    expect((await picture(lute)).status).toBe(404);
    await ada.put(url, { kiwix: k });
    const res = await picture(lute);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("RIFF....WEBPVP8 ");
    for (const u of [`${k}/content/wikipedia_en_all_nopic_2026-06/A/Lute`, "https://upload.wikimedia.org/x.png", `${k}/catalog/v2/entries`]) expect((await picture(u)).status).toBe(404);
    expect((await picture(lute, "")).status).not.toBe(200);
  });

  it("gives a signed-in user an article of the offline copy, and nothing else", async () => {
    const { rt, base, ada, url } = await setup();
    const k = await kiwix();
    const page = (u: string, cookie = ada.cookie) => fetch(`${base}/api/u/${rt.ada.id}/web/page?url=${encodeURIComponent(u)}`, { headers: cookie ? { cookie } : {} });
    expect((await page("https://en.wikipedia.org/wiki/Lute")).status).toBe(404);
    await ada.put(url, { kiwix: k });
    const res = await page("https://en.wikipedia.org/wiki/Lute");
    expect(res.status).toBe(200);
    const body = await res.json() as { copy: string; text: string };
    expect(body.copy).toBe("the offline copy of Wikipedia (2026-06)");
    expect(body.text).toContain("Lute");
    for (const u of [`${k}/content/wikipedia_en_all_nopic_2026-06/I/Lute.webp`, "https://en.wikipedia.org/wiki/Nope", "https://example.org/wiki/Lute", `${k}/catalog/v2/entries`]) expect((await page(u)).status).toBe(404);
    expect((await page("https://en.wikipedia.org/wiki/Lute", "")).status).not.toBe(200);
  });

  it("never sends a basic-auth password back, and keeps it while the user@host stays", async () => {
    const { ada, url, logs } = await setup();
    const host = await searxng({ auth: "lyrica:s3cret-pw" });
    const shown = { searxng: `http://lyrica@${host}`, auth: true, state: "reachable", ...NO_KIWIX };
    expect((await ada.put<WebSearch>(url, { searxng: `http://lyrica:s3cret-pw@${host}` })).body).toEqual(shown);
    expect((await ada.get<WebSearch>(url)).body).toEqual(shown);
    // Saving what was shown keeps the password.
    expect((await ada.put<WebSearch>(url, { searxng: shown.searxng })).body).toEqual(shown);
    // A new password replaces it.
    expect((await ada.put<WebSearch>(url, { searxng: `http://lyrica:wrong@${host}` })).body).toMatchObject({ auth: true, state: "unreachable" });
    // Another user doesn't take it.
    expect((await ada.put<WebSearch>(url, { searxng: `http://other@${host}` })).body).toMatchObject({ searxng: `http://other@${host}`, auth: false });
    expect((await ada.put<WebSearch>(url, { searxng: "" })).body).toEqual({ searxng: null, auth: false, state: "unset", ...NO_KIWIX });
    expect(logs.join("\n")).not.toContain("s3cret-pw");
  });

  it("takes the SearXNG install.sh runs here while none is set, and never again once an administrator clears it", async () => {
    const rt = await runtime();
    const local = `http://${await searxng()}`;
    const k = await kiwix();
    writeFileSync(join(rt.home, "searxng-address"), `${local}\n`);
    writeFileSync(join(rt.home, "kiwix-address"), `${k}\n`);
    const first = await daemon(rt);
    await browser(first.base).post("/api/unlock", { passphrase: "passphrase" });
    let ada = await login(first.base, "ada", "pw");
    const url = `/api/u/${rt.ada.id}/admin/web-search`;
    expect((await ada.get<WebSearch>(url)).body).toMatchObject({ searxng: local, auth: false, state: "reachable", kiwix: k, kiwixState: "reachable" });
    await ada.put(url, { searxng: "", kiwix: "" });
    await first.stop();

    const second = await daemon(rt);
    await browser(second.base).post("/api/unlock", { passphrase: "passphrase" });
    ada = await login(second.base, "ada", "pw");
    expect((await ada.get<WebSearch>(url)).body).toEqual({ searxng: null, auth: false, state: "unset", ...NO_KIWIX });
    await second.stop();

    // A new address is a new offer; an address an administrator set stays whatever install.sh offers.
    const other = `http://${await searxng()}`;
    writeFileSync(join(rt.home, "searxng-address"), other);
    const third = await daemon(rt);
    await browser(third.base).post("/api/unlock", { passphrase: "passphrase" });
    ada = await login(third.base, "ada", "pw");
    expect((await ada.get<WebSearch>(url)).body.searxng).toBe(other);
    await ada.put(url, { searxng: local });
    await third.stop();
    writeFileSync(join(rt.home, "searxng-address"), `http://${await searxng()}`);
    const fourth = await daemon(rt);
    await browser(fourth.base).post("/api/unlock", { passphrase: "passphrase" });
    ada = await login(fourth.base, "ada", "pw");
    expect((await ada.get<WebSearch>(url)).body.searxng).toBe(local);
  });
});
