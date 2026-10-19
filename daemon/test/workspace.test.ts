import { Workspace } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../src/routes.ts";
import { match, statusOf, type Request } from "../src/http.ts";
import { Lyricad } from "../src/lyricad.ts";
import type { GitAccountInfo, Me, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

afterEach(() => { vi.restoreAllMocks(); });

// github.com resolves without the network: a real lookup on a busy runner can
// miss the workspace's 5 s limit. Other names still go to the resolver.
vi.mock("node:dns/promises", async (real) => {
  const dns = await real<typeof import("node:dns/promises")>();
  const lookup = ((host: string, opts?: object) =>
    host === "github.com" ? Promise.resolve([{ address: "140.82.112.3", family: 4 }]) : dns.lookup(host, opts as never)) as typeof dns.lookup;
  return { ...dns, lookup, default: { ...dns, lookup } };
});

/** Records home mounts instead of running gocryptfs. */
function homes() {
  const mounts = vi.spyOn(Workspace.prototype, "mountHome").mockResolvedValue("");
  const unmounts = vi.spyOn(Workspace.prototype, "unmountHome").mockResolvedValue();
  return { mounted: () => mounts.mock.calls.map((c) => c[0]), unmounted: () => unmounts.mock.calls.map((c) => c[0]) };
}

describe("lyricad and the home workspace", () => {
  it("reads authenticated new-thread defaults for both pools without creating threads (principles 1 and 2)", async () => {
    const rt = await runtime();
    const d = new Lyricad({ home: rt.home, port: 0, selfTest: false, log: () => {}, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 }, kdfIter: 1 });
    await d.unlock("passphrase");
    await d.services!.users.authenticate("ada", "pw");
    const cookie = d.sessions.login(undefined, rt.ada.id, () => false).id;
    const routes = apiRoutes(d);
    // Exercise real handlers, sessions and encrypted stores without a listening socket.
    const call = async <T,>(method: string, path: string, body: unknown = {}, session: string | undefined = cookie) => {
      const url = new URL(path, "http://localhost");
      const found = match(routes, method, url.pathname);
      if (!found || found === "method") throw new Error("test route not found");
      const request = { params: found.params, query: url.searchParams, cookie: session, json: async () => body } as Request;
      try { return { status: 200, body: await found.route.handler(request) as T }; }
      catch (err) { return { status: statusOf(err), body: undefined as T }; }
    };
    try {
      const u = `/api/u/${rt.ada.id}`;
      expect((await call("GET", `${u}/thread-defaults`, {}, "")).status).toBe(401);
      expect((await call("GET", `/api/u/${rt.sam.id}/thread-defaults`)).status).toBe(401);
      const workspace = d.services!.workspace.settings(rt.ada.id);
      workspace.setDefaultMode("ask");
      workspace.setDefaultNetwork("general", { internet: true });
      workspace.setDefaultNetwork("private", { internet: false });
      const before = (await call("GET", `${u}/threads`)).body;
      const recent = vi.spyOn(d.services!.models, "recentCalls");
      for (const pool of ["general", "private"] as const) {
        recent.mockClear();
        const defaults = await call<ThreadSettings>("GET", `${u}/thread-defaults?pool=${pool}`);
        expect(defaults.status).toBe(200);
        expect(recent).not.toHaveBeenCalled();
        for (const key of ["messages", "memory", "answered", "context"]) expect(defaults.body).not.toHaveProperty(key);
        expect(defaults.body).toMatchObject({ mode: "ask", code: false, webSearch: true, images: true });
        expect((await call("GET", `${u}/threads`)).body).toEqual(before);
        const thread = (await call<ThreadSummary>("POST", `${u}/threads`, { pool })).body;
        const settings = (await call<ThreadSettings>("GET", `${u}/threads/${pool}/${encodeURIComponent(thread.id)}/settings`)).body;
        expect(defaults.body).toEqual(settings);
        const path = `${u}/threads/${pool}/${encodeURIComponent(thread.id)}/settings`;
        expect((await call<ThreadSettings>("PATCH", path, { code: true })).body).toMatchObject({ code: true, mode: "ask" });
        expect((await call<ThreadSettings>("PATCH", path, { code: "wrong", mode: "auto" })).status).toBe(400);
        expect((await call<ThreadSettings>("GET", path)).body).toMatchObject({ code: true, mode: "ask" });
        expect((await call<ThreadSettings>("PATCH", path, { code: false })).body.code).toBe(false);
        await call("DELETE", `${u}/threads/${pool}/${encodeURIComponent(thread.id)}`);
      }
      expect((await call("GET", `${u}/threads`)).body).toEqual(before);
    } finally { await d.stop(); }
  });

  it("mounts a home at sign-in and unmounts it on Lock", async () => {
    const rt = await runtime();
    const h = homes();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    expect(h.mounted()).toEqual([]);
    const sam = await login(base, "sam", "pw2");
    expect(h.mounted()).toEqual([rt.sam.id]);
    // A second sign-in doesn't mount it again.
    await login(base, "sam", "pw2");
    expect(h.mounted()).toEqual([rt.sam.id]);
    await sam.post(`/api/u/${rt.sam.id}/lock`);
    expect(h.unmounted()).toEqual([rt.sam.id]);
    // Mounted again at the next sign-in.
    await login(base, "sam", "pw2");
    expect(h.mounted()).toEqual([rt.sam.id, rt.sam.id]);
  });

  it("mounts a home at unlock from saved credentials, and unmounts every mounted home on shutdown", async () => {
    const rt = await runtime();
    const first = await daemon(rt);
    await browser(first.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(first.base, "ada", "pw");
    await ada.put(`/api/u/${rt.ada.id}/admin/passphrase`, { save: true, passphrase: "passphrase" });
    expect((await ada.put<Me>(`/api/u/${rt.ada.id}/me/credentials`, { save: true })).body.savedCredentials).toBe(true);
    await first.stop();

    const h = homes();
    const second = await daemon(rt);
    expect(second.d.locked).toBe(false);
    expect(h.mounted()).toEqual([rt.ada.id]);
    await login(second.base, "sam", "pw2");
    expect(h.unmounted()).toEqual([]);
    await second.stop();
    expect(h.unmounted().sort()).toEqual([rt.ada.id, rt.sam.id].sort());
  });
});

describe("lyricad's network self-test", () => {
  const thread = (userId: string) => ({ userId, pool: "general" as const, threadId: "t1" });

  it("runs at unlock, and when a networked sandbox can't start, every thread's network is off", async () => {
    const rt = await runtime();
    homes();
    const { base, d, logs } = await daemon(rt, { selfTest: true, bwrap: "/bin/false", pasta: "/bin/false" });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    await login(base, "ada", "pw");
    const ws = d.services!.workspace;
    expect(ws.networkRefused).toMatch(/networked sandbox didn't start/);
    expect(logs.some((l) => l.startsWith("network is off for every thread:"))).toBe(true);
    expect(ws.network(thread(rt.ada.id))).toEqual({ internet: false, services: false, hosts: [] });
  });

  it("leaves a thread's own network settings alone when it's skipped", async () => {
    const rt = await runtime();
    homes();
    const { base, d, logs } = await daemon(rt, { bwrap: "/bin/false", pasta: "/bin/false" });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    await login(base, "ada", "pw");
    expect(d.services!.workspace.networkRefused).toBeUndefined();
    expect(logs.some((l) => l.startsWith("network is off"))).toBe(false);
    // A general thread has internet on by default.
    expect(d.services!.workspace.network(thread(rt.ada.id)).internet).toBe(true);
  });
});

describe("Git accounts", () => {
  it("are added once their token works, never send it back, and take their repositories from threads when they go", async () => {
    const rt = await runtime();
    homes();
    const probe = vi.spyOn(Workspace.prototype, "probeGitAccount").mockResolvedValue();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const accounts = `/api/u/${rt.ada.id}/git-accounts`;
    const token = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";
    const added = await ada.post<GitAccountInfo>(accounts, { name: "ada", kind: "github", host: "github.com", account: "xlc2022", token, pool: "general" });
    expect(added.body).toMatchObject({ name: "ada", kind: "github", host: "github.com", account: "xlc2022", pool: "general", state: { kind: "signedIn" } });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ token }));
    expect(JSON.stringify((await ada.get(accounts)).body)).not.toContain(token);
    expect((await ada.post(accounts, { name: "p", kind: "github", host: "github.com", account: "xlc2022", token, pool: "private" })).status).toBe(400);
    expect((await ada.post(accounts, { name: "x", kind: "svn", host: "h", account: "a", token, pool: "general" })).status).toBe(400);
    // Another user can't reach them.
    const sam = await login(base, "sam", "pw2");
    expect((await sam.get(accounts)).status).toBe(401);

    const g = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "code" })).body;
    const url = `/api/u/${rt.ada.id}/threads/general/${encodeURIComponent(g.id)}/settings`;
    const repositories = [{ name: "xlc2022/lyrica", account: "ada" }];
    expect((await ada.patch<ThreadSettings>(url, { repositories })).body.repositories).toEqual(repositories);
    expect((await ada.patch(url, { repositories: [{ name: "xlc2022/lyrica", account: "nobody" }] })).status).toBe(400);
    expect((await ada.patch<GitAccountInfo>(`${accounts}/ada`, { name: "mine" })).body.name).toBe("mine");
    expect((await ada.get<ThreadSettings>(url)).body.repositories).toEqual([{ name: "xlc2022/lyrica", account: "mine" }]);
    expect((await ada.del(`${accounts}/mine`)).status).toBe(200);
    expect((await ada.get<ThreadSettings>(url)).body.repositories).toEqual([]);
  });
});
