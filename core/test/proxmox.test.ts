import { afterEach, describe, expect, it } from "vitest";
import { Users, Workspace, type Self } from "../src/index.ts";
import { fakeProxmox, TOKEN, type FakeProxmox } from "./fake-proxmox.ts";
import { freshKeyring, profile } from "./helpers.ts";

// Proxmox machines against a fake Proxmox API over real TLS, with a
// self-signed certificate as a node has.

const fakes: FakeProxmox[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });

const ELSEWHERE: Self = { hostname: "lyrica", macs: ["02:00:00:00:00:01"], addresses: ["192.168.1.50"], gateways: ["192.168.1.1"] };

async function setup(self: Self = ELSEWHERE) {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
  await users.authenticate("li", "pw");
  const pve = await fakeProxmox();
  fakes.push(pve);
  const workspace = new Workspace(keyring, users, { excludePorts: [], self: () => self });
  const add = (o: { token?: string; hostKey?: string; name?: string; limit?: "ask" | "auto" } = {}) => workspace.addMachine(li.id, {
    kind: "proxmox", name: o.name ?? "pve", address: pve.address, token: o.token ?? TOKEN, hostKey: o.hostKey ?? pve.fingerprint, pool: "general", root: null, limit: o.limit,
  });
  const t = { userId: li.id, pool: "general" as const, threadId: "t1" };
  return { li, workspace, pve, add, t };
}

describe("a Proxmox machine", () => {
  it("is added after Ada confirms the certificate, and the token is sent only then", async () => {
    const { li, workspace, pve, add } = await setup();
    const probe = await workspace.probeMachine(li.id, "li", { kind: "proxmox", name: "pve", address: pve.address });
    expect(probe).toMatchObject({ fingerprint: pve.fingerprint, login: false, offNetwork: false });
    expect(probe.setup).toContain('pveum role add LyricaPower --privs "VM.Audit VM.PowerMgmt"');
    expect(probe.setup).toContain("--privsep 1");
    expect(probe.setup).toContain("Never PVEVMUser");
    expect(pve.requests).toEqual([]);
    expect(workspace.settings(li.id).machines()).toEqual([]);

    await expect(add({ token: "lyrica@pve!agent=00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/the token didn't work: Proxmox answered 401/);
    expect(workspace.settings(li.id).machines()).toEqual([]);
    const m = await add();
    expect(m).toMatchObject({ kind: "proxmox", host: "127.0.0.1", port: pve.port, username: "lyrica@pve!agent", root: null, limit: "ask", hostKey: pve.fingerprint });
    expect(pve.requests.every((r) => !r.line.includes("destroy"))).toBe(true);
  });

  it("does what each action says, through one API call each, and never destroys", async () => {
    const { li, workspace, pve, add, t } = await setup();
    await add();
    workspace.settings(li.id).setThread("t1", "general", { machines: ["pve"] });
    expect(await workspace.proxmox(t, "pve", "list")).toBe("101 web (VM on pve1): running\n200 db (container on pve1): stopped");
    expect(await workspace.proxmox(t, "pve", "status", "web")).toBe("101 web on pve1: running, up 1 d 1 h, CPU 12% of 4, memory 2.0 of 8.0 GiB");
    expect(await workspace.proxmox(t, "pve", "snapshots", "101")).toBe("before-upgrade (2025-10-09 08:53 UTC): clean install");
    pve.requests.length = 0;
    expect(await workspace.proxmox(t, "pve", "start", "200")).toBe("Asked pve1 to start 200 db. It runs as a task there; check with status.");
    expect(pve.requests.map((r) => r.line)).toEqual(["GET /api2/json/cluster/resources?type=vm", "POST /api2/json/nodes/pve1/lxc/200/status/start"]);
    await expect(workspace.proxmox(t, "pve", "destroy" as never, "101")).rejects.toThrow(/can't destroy/);
    await expect(workspace.proxmox(t, "pve", "stop", "999")).rejects.toThrow(/no VM or container 999/);
    expect(pve.requests.some((r) => r.line.includes("destroy") || r.line.startsWith("DELETE"))).toBe(false);
    // Read, write, edit and bash have nowhere to run on it.
    expect(() => workspace.targetFor(t, "pve")).toThrow(/is a Proxmox machine: use the proxmox tool/);
    expect(workspace.machinesFor(t)).toEqual([{ name: "pve", kind: "proxmox", limit: "ask", root: null }]);
  });

  it("refuses a certificate whose fingerprint changed, with no fallback and before the token is sent", async () => {
    const { li, workspace, pve, add, t } = await setup();
    await add();
    workspace.settings(li.id).setThread("t1", "general", { machines: ["pve"] });
    const next = pve.swapCert();
    pve.requests.length = 0;
    await expect(workspace.proxmox(t, "pve", "list")).rejects.toThrow(/certificate isn't the one you confirmed/);
    expect(pve.requests).toEqual([]);
    // Ada confirms the new one: it works again.
    await workspace.setHostKey(li.id, "pve", next);
    expect(await workspace.proxmox(t, "pve", "list")).toContain("101 web");
  });

  it("refuses its own node's address when the address changes later, and on every call", async () => {
    const self: Self = { ...ELSEWHERE, gateways: [...ELSEWHERE.gateways] };
    const { li, workspace, pve, add, t } = await setup(self);
    await add();
    workspace.settings(li.id).setThread("t1", "general", { machines: ["pve"] });
    self.gateways.push("127.0.0.2");
    await expect(workspace.updateMachine(li.id, "pve", { address: `https://127.0.0.2:${pve.port}` })).rejects.toThrow(/127.0.0.2 is this computer's default gateway/);
    expect(workspace.settings(li.id).machine("pve")!.host).toBe("127.0.0.1");
    // An address that has come to be her gateway (a DHCP or DNS change) is refused before the token is sent.
    self.gateways.push("127.0.0.1");
    pve.requests.length = 0;
    await expect(workspace.proxmox(t, "pve", "list")).rejects.toThrow(/Stopping it would stop her/);
    expect(pve.requests).toEqual([]);
  });

  it("refuses the Proxmox that runs Lyrica's own VM, where it can tell", async () => {
    for (const [self, why] of [
      [{ ...ELSEWHERE, gateways: ["127.0.0.1"] }, /127.0.0.1 is this computer's default gateway/],
      [{ ...ELSEWHERE, hostname: "web.home.arpa" }, /it runs web \(101 on pve1\), which has this computer's name/],
      [{ ...ELSEWHERE, macs: ["bc:24:11:dd:ee:ff"] }, /it runs db \(200 on pve1\), which has this computer's network card/],
    ] as [Self, RegExp][]) {
      const { li, workspace, add } = await setup(self);
      await expect(add()).rejects.toThrow(why);
      await expect(add()).rejects.toThrow(/Stopping it would stop her/);
      expect(workspace.settings(li.id).machines()).toEqual([]);
    }
  });
});
