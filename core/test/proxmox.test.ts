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
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const pve = await fakeProxmox();
  fakes.push(pve);
  const workspace = new Workspace(keyring, users, { excludePorts: [], self: () => self });
  const add = (o: { token?: string; hostKey?: string; name?: string; limit?: "ask" | "auto" } = {}) => workspace.addMachine(ada.id, {
    kind: "proxmox", name: o.name ?? "pve", address: pve.address, token: o.token ?? TOKEN, hostKey: o.hostKey ?? pve.fingerprint, pool: "general", root: null, limit: o.limit,
  });
  const t = { userId: ada.id, pool: "general" as const, threadId: "t1" };
  return { ada, workspace, pve, add, t };
}

describe("a Proxmox machine", () => {
  it("is added after Ada confirms the certificate, and the token is sent only then", async () => {
    const { ada, workspace, pve, add } = await setup();
    const probe = await workspace.probeMachine(ada.id, "ada", { kind: "proxmox", name: "pve", address: pve.address });
    expect(probe).toMatchObject({ fingerprint: pve.fingerprint, login: false, offNetwork: false });
    expect(probe.setup).toContain('pveum role add LyricaPower --privs "VM.Audit VM.PowerMgmt"');
    expect(probe.setup).toContain("--privsep 1");
    expect(probe.setup).toContain("Never PVEVMUser");
    expect(pve.requests).toEqual([]);
    expect(workspace.settings(ada.id).machines()).toEqual([]);

    await expect(add({ token: "lyrica@pve!agent=00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/the token didn't work: Proxmox answered 401/);
    expect(workspace.settings(ada.id).machines()).toEqual([]);
    const m = await add();
    expect(m).toMatchObject({ kind: "proxmox", host: "127.0.0.1", port: pve.port, username: "lyrica@pve!agent", root: null, limit: "ask", hostKey: pve.fingerprint });
    expect(pve.requests.every((r) => !r.line.includes("destroy"))).toBe(true);
  });

  it("takes a token on Ada's own Proxmox user when she says so, and only on that user", async () => {
    const { ada, workspace, pve, add } = await setup();
    const OWN = "ada@pam!lyrica=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    pve.tokens.push(OWN);
    // The setup makes no user: a separated token on hers, with the roles given to the token alone.
    const probe = await workspace.probeMachine(ada.id, "ada", { kind: "proxmox", name: "pve", address: pve.address, asUser: true, user: "ada@pam" });
    expect(probe.setup).toContain("pveum user token add ada@pam lyrica --privsep 1");
    expect(probe.setup).toContain("pveum acl modify /vms/101 --roles LyricaPower --tokens 'ada@pam!lyrica'");
    expect(probe.setup).not.toContain("pveum user add");
    expect(probe.setup).toContain("Never --privsep 0");
    await expect(workspace.probeMachine(ada.id, "ada", { kind: "proxmox", name: "pve", address: pve.address, asUser: true })).rejects.toThrow(/a Proxmox user looks like root@pam/);
    // The user goes into a block run as root: nothing a shell reads gets in.
    for (const user of ["a';id;'@pam", "ada@pam;id", "$(id)@pam", "-x@pam", "ada@pam`id`", "ada @pam"]) {
      await expect(workspace.probeMachine(ada.id, "ada", { kind: "proxmox", name: "pve", address: pve.address, asUser: true, user })).rejects.toThrow(/a Proxmox user looks like root@pam/);
    }
    expect(pve.requests).toEqual([]);

    const mine = (token: string) => workspace.addMachine(ada.id, { kind: "proxmox", name: "pve", address: pve.address, token, hostKey: pve.fingerprint, pool: "general", root: null, asUser: true, user: "ada@pam" });
    // A token on another user is refused before anything is sent.
    await expect(mine(TOKEN)).rejects.toThrow("the token is lyrica@pve's, not ada@pam's");
    expect(pve.requests).toEqual([]);
    // A token made without privilege separation has all her user has: Proxmox says so, and nothing is saved.
    const WIDE = "ada@pam!all=2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
    const everything = { "/": { "Sys.Audit": 1, "VM.Audit": 1, "VM.PowerMgmt": 1, "VM.Allocate": 1, "VM.Console": 1, "Sys.PowerMgmt": 1, "Permissions.Modify": 1, "User.Modify": 1 } };
    pve.tokens.push(WIDE);
    pve.permissions[WIDE] = everything;
    await expect(mine(WIDE)).rejects.toThrow("the token can do more than see and power VMs (Permissions.Modify, Sys.PowerMgmt, User.Modify, VM.Allocate and 1 more): make it again with privilege separation and only the roles in the setup");
    pve.permissions[OWN] = null;
    await expect(mine(OWN)).rejects.toThrow("couldn't read what the token may do");
    expect(workspace.settings(ada.id).machines()).toEqual([]);
    delete pve.permissions[OWN];
    expect(await mine(OWN)).toMatchObject({ kind: "proxmox", username: "ada@pam!lyrica", asUser: true });
    expect(workspace.machinesFor({ userId: ada.id, pool: "general", threadId: "t0" })).toEqual([]);
    // Replacing the token keeps it on her user, as an SSH account is fixed once added.
    await expect(workspace.setHostKey(ada.id, "pve", pve.fingerprint, TOKEN)).rejects.toThrow("the token is lyrica@pve's, not ada@pam's");
    await expect(workspace.setHostKey(ada.id, "pve", pve.fingerprint, WIDE)).rejects.toThrow(/can do more than see and power VMs/);
    expect(workspace.settings(ada.id).machine("pve")).toMatchObject({ username: "ada@pam!lyrica", asUser: true });
    // One made for her says nothing of the kind.
    expect(await add({ name: "pve2" })).toMatchObject({ username: "lyrica@pve!agent", asUser: false });
  });

  it("does what each action says, through one API call each, and never destroys", async () => {
    const { ada, workspace, pve, add, t } = await setup();
    await add();
    workspace.settings(ada.id).setThread("t1", "general", { machines: ["pve"] });
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
    expect(() => workspace.targetFor(t, "pve")).toThrow(/is a Proxmox machine, reached only with the proxmox tool/);
    expect(workspace.machinesFor(t)).toEqual([{ name: "pve", kind: "proxmox", limit: "ask", root: null }]);
  });

  it("refuses a certificate whose fingerprint changed, with no fallback and before the token is sent", async () => {
    const { ada, workspace, pve, add, t } = await setup();
    await add();
    workspace.settings(ada.id).setThread("t1", "general", { machines: ["pve"] });
    const next = pve.swapCert();
    pve.requests.length = 0;
    await expect(workspace.proxmox(t, "pve", "list")).rejects.toThrow(/certificate isn't the one you confirmed/);
    expect(pve.requests).toEqual([]);
    // Ada confirms the new one: it works again.
    await workspace.setHostKey(ada.id, "pve", next);
    expect(await workspace.proxmox(t, "pve", "list")).toContain("101 web");
  });

  it("records how her last call went for its row, as an SSH connection does", async () => {
    const { ada, workspace, pve, add, t } = await setup();
    await add();
    workspace.settings(ada.id).setThread("t1", "general", { machines: ["pve"] });
    const state = () => workspace.settings(ada.id).machine("pve")!.state?.kind;
    // Adding it wasn't a call of hers: no state yet.
    expect(state()).toBeUndefined();
    await workspace.proxmox(t, "pve", "list");
    expect(state()).toBe("online");
    // The node refusing one thing is still the node answering.
    await expect(workspace.proxmox(t, "pve", "start", "101")).rejects.toThrow(/Proxmox answered 500/);
    expect(state()).toBe("online");
    // A token it no longer takes is a login that failed.
    pve.tokens.length = 0;
    await expect(workspace.proxmox(t, "pve", "list")).rejects.toThrow(/Proxmox answered 401/);
    expect(state()).toBe("unreachable");
    pve.tokens.push(TOKEN);
    const next = pve.swapCert();
    await expect(workspace.proxmox(t, "pve", "list")).rejects.toThrow(/certificate isn't the one you confirmed/);
    expect(state()).toBe("keyChanged");
    // Confirming the new certificate clears it, and her next call says online again.
    await workspace.setHostKey(ada.id, "pve", next);
    expect(state()).toBeUndefined();
    await workspace.proxmox(t, "pve", "status", "web");
    expect(state()).toBe("online");
    await pve.close();
    await expect(workspace.proxmox(t, "pve", "list")).rejects.toThrow();
    expect(state()).toBe("unreachable");
  });

  it("refuses its own node's address when the address changes later, and on every call", async () => {
    const self: Self = { ...ELSEWHERE, gateways: [...ELSEWHERE.gateways] };
    const { ada, workspace, pve, add, t } = await setup(self);
    await add();
    workspace.settings(ada.id).setThread("t1", "general", { machines: ["pve"] });
    self.gateways.push("127.0.0.2");
    await expect(workspace.updateMachine(ada.id, "pve", { address: `https://127.0.0.2:${pve.port}` })).rejects.toThrow(/127.0.0.2 is this computer's default gateway/);
    expect(workspace.settings(ada.id).machine("pve")!.host).toBe("127.0.0.1");
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
      const { ada, workspace, add } = await setup(self);
      await expect(add()).rejects.toThrow(why);
      await expect(add()).rejects.toThrow(/Stopping it would stop her/);
      expect(workspace.settings(ada.id).machines()).toEqual([]);
    }
  });
});
