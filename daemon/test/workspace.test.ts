import { Workspace } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/api.ts";
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

describe("her GitHub token", () => {
  it("is saved and removed by its user, and never sent back", async () => {
    const rt = await runtime();
    homes();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const token = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";
    expect((await li.get(`/api/u/${rt.li.id}/github`)).body).toEqual({ token: false, checkout: null });
    const saved = await li.put(`/api/u/${rt.li.id}/github`, { token });
    expect(saved.body).toEqual({ token: true, checkout: null });
    expect(JSON.stringify((await li.get(`/api/u/${rt.li.id}/github`)).body)).not.toContain(token);
    expect((await li.put(`/api/u/${rt.li.id}/github`, { token: "not a token" })).status).toBe(400);
    // Another user can't reach it.
    const sam = await login(base, "sam", "pw2");
    expect((await sam.get(`/api/u/${rt.li.id}/github`)).status).toBe(401);
    expect((await li.del(`/api/u/${rt.li.id}/github`)).body).toEqual({ token: false, checkout: null });
  });
});
