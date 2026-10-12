import { Workspace } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitAccountInfo, Me, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, login, runtime, systemdStart } from "./helpers.ts";

afterEach(() => { vi.restoreAllMocks(); });

/** Records home mounts instead of running gocryptfs. */
function homes() {
  const mounts = vi.spyOn(Workspace.prototype, "mountHome").mockResolvedValue("");
  const unmounts = vi.spyOn(Workspace.prototype, "unmountHome").mockResolvedValue();
  return { mounted: () => mounts.mock.calls.map((c) => c[0]), unmounted: () => unmounts.mock.calls.map((c) => c[0]) };
}

describe("lyricad and the home workspace", () => {
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
    const li = await login(first.base, "li", "pw");
    await li.put(`/api/u/${rt.li.id}/admin/passphrase`, { save: true, passphrase: "passphrase" });
    expect((await li.put<Me>(`/api/u/${rt.li.id}/me/credentials`, { save: true })).body.savedCredentials).toBe(true);
    await first.stop();

    const h = homes();
    systemdStart(rt);
    const second = await daemon(rt);
    expect(second.d.locked).toBe(false);
    expect(h.mounted()).toEqual([rt.li.id]);
    await login(second.base, "sam", "pw2");
    expect(h.unmounted()).toEqual([]);
    await second.stop();
    expect(h.unmounted().sort()).toEqual([rt.li.id, rt.sam.id].sort());
  });
});

describe("lyricad's network self-test", () => {
  const thread = (userId: string) => ({ userId, pool: "general" as const, threadId: "t1" });

  it("runs at unlock, and when a networked sandbox can't start, every thread's network is off", async () => {
    const rt = await runtime();
    homes();
    const { base, d, logs } = await daemon(rt, { selfTest: true, bwrap: "/bin/false", pasta: "/bin/false" });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    await login(base, "li", "pw");
    const ws = d.services!.workspace;
    expect(ws.networkRefused).toMatch(/networked sandbox didn't start/);
    expect(logs.some((l) => l.startsWith("network is off for every thread:"))).toBe(true);
    expect(ws.network(thread(rt.li.id))).toEqual({ internet: false, services: false, hosts: [] });
  });

  it("leaves a thread's own network settings alone when it's skipped", async () => {
    const rt = await runtime();
    homes();
    const { base, d, logs } = await daemon(rt, { bwrap: "/bin/false", pasta: "/bin/false" });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    await login(base, "li", "pw");
    expect(d.services!.workspace.networkRefused).toBeUndefined();
    expect(logs.some((l) => l.startsWith("network is off"))).toBe(false);
    // A general thread has internet on by default.
    expect(d.services!.workspace.network(thread(rt.li.id)).internet).toBe(true);
  });
});

describe("Git accounts", () => {
  it("are added once their token works, never send it back, and take their repositories from threads when they go", async () => {
    const rt = await runtime();
    homes();
    const probe = vi.spyOn(Workspace.prototype, "probeGitAccount").mockResolvedValue();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const accounts = `/api/u/${rt.li.id}/git-accounts`;
    const token = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";
    const added = await li.post<GitAccountInfo>(accounts, { name: "li", kind: "github", host: "github.com", account: "xlc2022", token, pool: "general" });
    expect(added.body).toMatchObject({ name: "li", kind: "github", host: "github.com", account: "xlc2022", pool: "general", state: { kind: "signedIn" } });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ token }));
    expect(JSON.stringify((await li.get(accounts)).body)).not.toContain(token);
    expect((await li.post(accounts, { name: "p", kind: "github", host: "github.com", account: "xlc2022", token, pool: "private" })).status).toBe(400);
    expect((await li.post(accounts, { name: "x", kind: "svn", host: "h", account: "a", token, pool: "general" })).status).toBe(400);
    // Another user can't reach them.
    const sam = await login(base, "sam", "pw2");
    expect((await sam.get(accounts)).status).toBe(401);

    const g = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "code" })).body;
    const url = `/api/u/${rt.li.id}/threads/general/${encodeURIComponent(g.id)}/settings`;
    const repositories = [{ name: "xlc2022/lyrica", account: "li" }];
    expect((await li.patch<ThreadSettings>(url, { repositories })).body.repositories).toEqual(repositories);
    expect((await li.patch(url, { repositories: [{ name: "xlc2022/lyrica", account: "nobody" }] })).status).toBe(400);
    expect((await li.patch<GitAccountInfo>(`${accounts}/li`, { name: "mine" })).body.name).toBe("mine");
    expect((await li.get<ThreadSettings>(url)).body.repositories).toEqual([{ name: "xlc2022/lyrica", account: "mine" }]);
    expect((await li.del(`${accounts}/mine`)).status).toBe(200);
    expect((await li.get<ThreadSettings>(url)).body.repositories).toEqual([]);
  });
});
