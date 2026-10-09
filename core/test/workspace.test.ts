import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const settings = new Workspace(keyring, users).settings(li.id);
  settings.allow("general", join(host, "shared"));
  settings.allow("private", join(host, "diary"));
  return { keyring, users, li, host, settings };
}

describe("grants", () => {
  it("keep general threads out of private folders", async () => {
    const { host, settings } = await setup();
    expect(() => settings.setThread("g1", "general", { grants: [{ path: join(host, "diary"), writable: false }] }))
      .toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: join(host, "shared", "..", "diary"), writable: false }] }))
      .toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: host, writable: false }] })).toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: "/etc", writable: false }] })).toThrow(/not in this user's general folders/);
    // An administrator can't list one folder in both pools either.
    expect(() => settings.allow("general", join(host, "diary"))).toThrow(/overlaps/);
    expect(() => settings.allow("private", host)).toThrow(/overlaps/);

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
    const { keyring, host, settings } = await setup();
    symlinkSync(join(host, "shared"), join(host, "link"));
    expect(() => settings.allow("general", join(host, "link"))).toThrow(/symlink/);
    expect(() => settings.allow("general", keyring.home)).toThrow(/runtime/);
    expect(() => settings.allow("general", "/")).toThrow(/runtime|overlaps/);
    expect(() => settings.setThread("g1", "general", {
      grants: [{ path: join(host, "shared"), writable: false }, { path: join(host, "shared", "music"), writable: true }],
    })).toThrow(/inside/);
  });

  it("give private threads no network unless the user allows it", async () => {
    const { settings } = await setup();
    expect(settings.network("g1", "general")).toBe(true);
    expect(settings.network("p1", "private")).toBe(false);
    settings.setThread("p1", "private", { network: true });
    expect(settings.network("p1", "private")).toBe(true);
    settings.setPrivateNetwork(true);
    expect(settings.network("p2", "private")).toBe(true);
    settings.setThread("p2", "private", { network: false });
    expect(settings.network("p2", "private")).toBe(false);
    expect(() => settings.setThread("g1", "general", { network: false })).toThrow(/always/);
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
    const workspace = new Workspace(keyring, users);
    const thread = { userId: li.id, pool: "general" as const, threadId: "t1" };
    expect(workspace.targetFor(thread).name).toBe("ssh:nas");
    expect(workspace.folders(thread)).toEqual(["nas:/srv/lyrica"]);
    expect(() => settings.setThread("t1", "general", { target: "ssh:nope" })).toThrow(/unknown target/);
  });
});

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
    mkdirSync(join(dir, "root"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = spawn(sshd, ["-D", "-e", "-p", String(port), "-h", join(dir, "host_key"), "-o", `AuthorizedKeysFile=${join(dir, "authorized_keys")}`,
      "-o", "StrictModes=no", "-o", "UsePAM=no", "-o", `PidFile=${join(dir, "pid")}`, "-o", "ListenAddress=127.0.0.1"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
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
