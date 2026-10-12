import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadSettings, WebSearch } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

// Administration → Web search: the server's SearXNG address.

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
  const li = await login(base, "li", "pw");
  return { rt, base, logs, li, url: `/api/u/${rt.li.id}/admin/web-search` };
}

describe("web search", () => {
  it("saves the address, says whether SearXNG answers, and is for administrators only", async () => {
    const { rt, base, li, url } = await setup();
    expect((await li.get<WebSearch>(url)).body).toEqual({ searxng: null, auth: false, state: "unset" });

    const good = `http://${await searxng()}`;
    expect((await li.put<WebSearch>(url, { searxng: `${good}/` })).body).toEqual({ searxng: good, auth: false, state: "reachable" });
    const bad = (await li.put<WebSearch>(url, { searxng: `http://${await searxng({ json: false })}` })).body;
    expect(bad).toMatchObject({ state: "unreachable" });
    expect(bad.reason).toContain("json format");
    expect((await li.put(url, { searxng: "ftp://x" })).status).toBe(400);

    const sam = await login(base, "sam", "pw2");
    const samUrl = url.replace(rt.li.id, rt.sam.id);
    expect((await sam.get(samUrl)).status).toBe(403);
    expect((await sam.put(samUrl, { searxng: good })).status).toBe(403);
    expect((await sam.get(url)).status).toBe(401);

    // A thread's settings say whether search has a provider, for the switch's tooltip.
    const thread = (await li.post<{ id: string }>(`/api/u/${rt.li.id}/threads`, { pool: "general" })).body;
    const settings = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}/settings`;
    expect((await li.get<ThreadSettings>(settings)).body.searchProvider).toBe(true);
    await li.put(url, { searxng: "" });
    expect((await li.get<ThreadSettings>(settings)).body.searchProvider).toBe(false);
  });

  it("never sends a basic-auth password back, and keeps it while the user@host stays", async () => {
    const { li, url, logs } = await setup();
    const host = await searxng({ auth: "lyrica:s3cret-pw" });
    const shown = { searxng: `http://lyrica@${host}`, auth: true, state: "reachable" };
    expect((await li.put<WebSearch>(url, { searxng: `http://lyrica:s3cret-pw@${host}` })).body).toEqual(shown);
    expect((await li.get<WebSearch>(url)).body).toEqual(shown);
    // Saving what was shown keeps the password.
    expect((await li.put<WebSearch>(url, { searxng: shown.searxng })).body).toEqual(shown);
    // A new password replaces it.
    expect((await li.put<WebSearch>(url, { searxng: `http://lyrica:wrong@${host}` })).body).toMatchObject({ auth: true, state: "unreachable" });
    // Another user doesn't take it.
    expect((await li.put<WebSearch>(url, { searxng: `http://other@${host}` })).body).toMatchObject({ searxng: `http://other@${host}`, auth: false });
    expect((await li.put<WebSearch>(url, { searxng: "" })).body).toEqual({ searxng: null, auth: false, state: "unset" });
    expect(logs.join("\n")).not.toContain("s3cret-pw");
  });
});
