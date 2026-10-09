import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSshKey, SshTarget, Users, Workspace, type SshTargetConfig } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
  await users.authenticate("li", "pw");
  const host = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-host-")));
  dirs.push(host);
  for (const d of ["shared", "shared/music", "diary", "both"]) mkdirSync(join(host, d));
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  const paths = workspace.allowedPaths;
  paths.allow(li, li.id, "general", join(host, "shared"));
  paths.allow(li, li.id, "private", join(host, "diary"));
  return { keyring, users, li, host, workspace, paths, settings: workspace.settings(li.id) };
}

describe("grants", () => {
  it("keep general threads out of private folders", async () => {
    const { li, host, paths, settings } = await setup();
    expect(() => settings.setThread("g1", "general", { grants: [{ path: join(host, "diary"), writable: false }] }))
      .toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: join(host, "shared", "..", "diary"), writable: false }] }))
      .toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: host, writable: false }] })).toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: "/etc", writable: false }] })).toThrow(/not in this user's general folders/);
    // An administrator can't list one folder in both pools either.
    expect(() => paths.allow(li, li.id, "general", join(host, "diary"))).toThrow(/overlaps/);
    expect(() => paths.allow(li, li.id, "private", host)).toThrow(/overlaps/);

    const ok = settings.setThread("g1", "general", { grants: [{ path: join(host, "shared", "music"), writable: true }] });
    expect(ok.grants).toEqual([{ path: join(host, "shared", "music"), writable: true }]);
    expect(settings.thread("g1").grants).toEqual(ok.grants);
  });

  it("let private threads read general folders but not write them", async () => {
    const { host, settings } = await setup();
    expect(() => settings.setThread("p1", "private", { grants: [{ path: join(host, "shared"), writable: true }] })).toThrow(/can only read/);
    settings.setThread("p1", "private", {
      grants: [{ path: join(host, "shared"), writable: false }, { path: join(host, "diary"), writable: true }],
    });
  });

  it("refuse symlinks, Lyrica's runtime and nested grants", async () => {
    const { keyring, li, host, paths, settings } = await setup();
    symlinkSync(join(host, "shared"), join(host, "link"));
    expect(() => paths.allow(li, li.id, "general", join(host, "link"))).toThrow(/symlink/);
    expect(() => paths.allow(li, li.id, "general", keyring.home)).toThrow(/runtime/);
    expect(() => paths.allow(li, li.id, "general", "/")).toThrow(/runtime|overlaps/);
    expect(() => settings.setThread("g1", "general", {
      grants: [{ path: join(host, "shared"), writable: false }, { path: join(host, "shared", "music"), writable: true }],
    })).toThrow(/inside/);
  });

  it("are an administrator's to change, not the user's", async () => {
    const { users, li, host, paths } = await setup();
    const sam = await users.createUser("sam", "pw", profile("Sam"), { admin: false });
    expect(() => paths.allow(sam, sam.id, "general", join(host, "shared"))).toThrow(/only an administrator/);
    expect(() => paths.disallow(sam, li.id, "general", join(host, "shared"))).toThrow(/only an administrator/);
    paths.allow(li, sam.id, "general", join(host, "shared"));
    expect(paths.list(sam.id).general).toEqual([join(host, "shared")]);
    expect(paths.list(li.id).general).toEqual([join(host, "shared")]);
  });

  it("follow each pool's network defaults unless the thread overrides them", async () => {
    const { settings } = await setup();
    expect(settings.network("g1", "general")).toEqual({ internet: true, services: false, hosts: [] });
    expect(settings.network("p1", "private")).toEqual({ internet: false, services: false, hosts: [] });
    settings.setThread("g1", "general", { internet: false, services: true });
    expect(settings.network("g1", "general")).toMatchObject({ internet: false, services: true });
    settings.setThread("p1", "private", { hosts: ["http://nas.lan:8080/api", "192.168.1.0/24"] });
    expect(settings.network("p1", "private").hosts).toEqual(["nas.lan:8080", "192.168.1.0/24"]);
    settings.setDefaultNetwork("private", { internet: true, hosts: ["nas.lan"] });
    expect(settings.network("p2", "private")).toEqual({ internet: true, services: false, hosts: ["nas.lan"] });
    expect(() => settings.setThread("p1", "private", { hosts: ["not a host"] })).toThrow(/can't read host/);
    for (const all of ["0.0.0.0/0", "10.0.0.0/0", "0.0.0.0", "0.0.0.0:443", "255.255.255.255"]) {
      expect(() => settings.setThread("p1", "private", { hosts: [all] }), all).toThrow(/every address|isn't a host/);
    }
    for (const v6 of ["::/0", "::", "fd00::1", "[fd00::1]:80", "http://[fd00::1]:8080/"]) {
      expect(() => settings.setThread("p1", "private", { hosts: [v6] }), v6).toThrow(/IPv6 hosts aren't supported yet/);
    }
  });

  it("let a subagent have its parent's settings or stricter ones, never wider", async () => {
    const { host, settings } = await setup();
    const music = join(host, "shared", "music");
    settings.setThread("parent", "general", {
      grants: [{ path: music, writable: true }], internet: false, services: true, hosts: ["10.0.0.5:80"], mode: "ask-commands",
    });

    const same = settings.inheritSettings("parent", "child", "general");
    expect(same).toMatchObject({
      grants: [{ path: music, writable: true }], internet: false, services: true, hosts: ["10.0.0.5:80"], mode: "ask-commands", parent: "parent",
    });
    const narrow = settings.inheritSettings("parent", "child2", "general", { grants: [{ path: music, writable: false }], mode: "ask-changes" });
    expect(narrow).toMatchObject({ grants: [{ path: music, writable: false }], mode: "ask-changes" });

    expect(() => settings.inheritSettings("parent", "c3", "general", { internet: true })).toThrow(/no internet/);
    expect(() => settings.inheritSettings("parent", "c6", "general", { hosts: ["10.0.0.5:80", "10.0.0.6"] })).toThrow(/10.0.0.6 isn't in the parent/);
    expect(settings.inheritSettings("parent", "c7", "general", { hosts: [], services: false })).toMatchObject({ hosts: [], services: false });
    expect(() => settings.inheritSettings("parent", "c4", "general", { mode: "auto" })).toThrow(/permission mode/);
    expect(() => settings.inheritSettings("parent", "c5", "general", { grants: [{ path: join(host, "shared"), writable: false }] }))
      .toThrow(/parent thread's folders/);
    // Widening later, through the thread's own settings, is refused too.
    expect(() => settings.setThread("child2", "general", { grants: [{ path: join(host, "shared"), writable: false }] }))
      .toThrow(/parent thread's folders/);
    expect(() => settings.setThread("child", "general", { internet: null })).toThrow(/no internet/);
    expect(() => settings.setThread("child", "general", { hosts: ["10.0.0.5"] })).toThrow(/isn't in the parent/);
    // Narrowing the parent later narrows what the child may keep.
    settings.setThread("parent", "general", { grants: [{ path: music, writable: false }] });
    expect(() => settings.setThread("child", "general", { grants: [{ path: music, writable: true }] })).toThrow(/read-only in the parent/);
    expect(() => settings.checkInherited("child", "general")).toThrow(/read-only in the parent/);
    expect(settings.folderThread("child2")).toBe("parent");
  });
});

describe("ssh targets", () => {
  const unreachable: SshTargetConfig = {
    name: "nas", host: "127.0.0.1", port: 1, username: "lyrica", privateKey: generateSshKey("test").privateKey, root: null, hostKey: null,
  };

  it("fail without falling back to local execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-ssh-"));
    dirs.push(dir);
    const marker = join(dir, "ran-locally");
    const ops = new SshTarget(unreachable, () => {}).ops();
    await expect(ops.bash.exec(`touch ${marker}`, dir, { onData: () => {} })).rejects.toThrow(/ssh nas/);
    await expect(ops.write.writeFile(marker, "x")).rejects.toThrow(/ssh nas/);
    await expect(ops.read.readFile("/etc/hostname")).rejects.toThrow(/ssh nas/);
    expect(existsSync(marker)).toBe(false);
  });

  it("keep file tools inside the root", async () => {
    const ops = new SshTarget({ ...unreachable, root: "/srv/lyrica" }, () => {}).ops();
    await expect(ops.read.readFile("/srv/lyrica/../etc/passwd")).rejects.toThrow(/outside \/srv\/lyrica/);
    await expect(ops.write.writeFile("/etc/passwd", "x")).rejects.toThrow(/outside/);
  });

  it("are chosen per thread and stored with the user's settings", async () => {
    const { keyring, users, li, settings } = await setup();
    settings.addSsh({ ...unreachable, root: "/srv/lyrica" });
    settings.setThread("t1", "general", { target: "ssh:nas" });
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const thread = { userId: li.id, pool: "general" as const, threadId: "t1" };
    expect(workspace.targetFor(thread).name).toBe("ssh:nas");
    expect(workspace.folders(thread)).toEqual(["nas:/srv/lyrica"]);
    expect(() => settings.setThread("t1", "general", { target: "ssh:nope" })).toThrow(/unknown target/);
  });
});

/** Waits until something accepts connections on `port`, or `server` exits. */
async function listening(port: number, server: ReturnType<typeof spawn>, log: () => string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`sshd exited: ${log()}`);
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1", () => { s.end(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`sshd isn't listening: ${log()}`);
}

// A real round trip against a throwaway sshd, run as the current user. Skipped
// where sshd isn't installed or the tests run as root.
const sshd = "/usr/sbin/sshd";
describe.skipIf(!existsSync(sshd) || process.getuid?.() === 0)("an ssh target", () => {
  it("reads, writes, edits and runs commands remotely, pinning the host key", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-sshd-")));
    dirs.push(dir);
    const key = generateSshKey("lyrica");
    const hostKey = generateSshKey("host");
    writeFileSync(join(dir, "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "host_key"), hostKey.privateKey, { mode: 0o600 });
    writeFileSync(join(dir, "sshd_config"), "Subsystem sftp internal-sftp\n"); // the system's may include files only root can read
    mkdirSync(join(dir, "root"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = spawn(sshd, ["-D", "-e", "-f", join(dir, "sshd_config"), "-p", String(port), "-h", join(dir, "host_key"), "-o", `AuthorizedKeysFile=${join(dir, "authorized_keys")}`,
      "-o", "StrictModes=no", "-o", "UsePAM=no", "-o", `PidFile=${join(dir, "pid")}`, "-o", "ListenAddress=127.0.0.1"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    server.stderr.on("data", (d: Buffer) => { log += d.toString(); });
    try {
      await listening(port, server, () => log);
      const seen: string[] = [];
      const target = new SshTarget({
        name: "local", host: "127.0.0.1", port, username: userInfo().username, privateKey: key.privateKey, root: join(dir, "root"), hostKey: null,
      }, (fp) => seen.push(fp));
      const ops = target.ops();
      const file = join(dir, "root", "todo.txt");
      await ops.write.writeFile(file, "buy milk\n");
      await ops.edit.access(file);
      expect((await ops.read.readFile(file)).toString()).toBe("buy milk\n");
      let out = "";
      const { exitCode } = await ops.bash.exec("pwd && cat todo.txt", "/elsewhere", { onData: (d) => { out += d.toString(); } });
      expect(exitCode).toBe(0);
      expect(out).toBe(`${join(dir, "root")}\nbuy milk\n`);
      symlinkSync("/etc", join(dir, "root", "etc"));
      await expect(ops.read.readFile(join(dir, "root", "etc", "hostname"))).rejects.toThrow(/leads outside/);
      expect(seen).toEqual([expect.stringMatching(/^SHA256:/)]);
      target.close();
      const impostor = new SshTarget({ ...target["cfg"], hostKey: "SHA256:someone-else" }, () => {});
      await expect(impostor.ops().read.readFile(file)).rejects.toThrow(/ssh local/);
    } finally {
      server.kill();
    }
  });
});
