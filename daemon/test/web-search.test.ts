import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadSettings, WebSearch } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

// Administration → Web search: the server's SearXNG address.

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A SearXNG that answers JSON, or 403 as one with the json format off does. */
async function searxng(json = true) {
  const srv = createServer((req, res) => {
    if (!json || !req.url?.startsWith("/search")) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ title: "SearXNG", url: "https://docs.searxng.org", content: "A metasearch engine." }] }));
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe("web search", () => {
  it("saves the address, says whether SearXNG answers, and is for administrators only", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const url = `/api/u/${rt.li.id}/admin/web-search`;
    expect((await li.get<WebSearch>(url)).body).toEqual({ searxng: null, state: "unset" });

    const good = await searxng();
    expect((await li.put<WebSearch>(url, { searxng: `${good}/` })).body).toEqual({ searxng: good, state: "reachable" });
    const off = await searxng(false);
    const bad = (await li.put<WebSearch>(url, { searxng: off })).body;
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
    expect((await li.get<ThreadSettings>(`/api/u/${rt.li.id}/threads/general/${enc(thread.id)}/settings`)).body.searchProvider).toBe(true);
    await li.put(url, { searxng: "" });
    expect((await li.get<ThreadSettings>(`/api/u/${rt.li.id}/threads/general/${enc(thread.id)}/settings`)).body.searchProvider).toBe(false);
  });
});
