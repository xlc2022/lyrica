import { afterEach, describe, expect, it } from "vitest";
import {
  cleanOutput, generateSshKey, maskKeys, migrate, RemoteMissing, suspectCommand, Users, Workspace, WorkspaceSettings,
  type Db, type NewMachine, type SshSession, type SshTransport,
} from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

// Machines with a fake SSH client: an in-memory machine whose host key and
// files the tests control. The real client against a real sshd is in
// workspace.test.ts.

const KEY = `SHA256:${"A".repeat(43)}`;
const OTHER = `SHA256:${"B".repeat(43)}`;

interface FakeMachine { hostKey: string; files: Map<string, string>; commands: string[]; output?: string; connects: string[]; down?: boolean }

function fakeTransport(machine: FakeMachine): SshTransport {
  return {
    async connect(to, verify) {
      machine.connects.push(to.host);
      if (machine.down) throw new Error("connect ECONNREFUSED");
      if (!verify(machine.hostKey)) throw new Error("host key refused");
      const missing = (p: string) => new RemoteMissing(`${p}: no such file`);
      const session: SshSession = {
        home: "/home/lyrica",
        exec: async (command, o) => { machine.commands.push(command); if (machine.output) o.onData(Buffer.from(machine.output)); return 0; },
        realpath: async (p) => {
          if (p === "/" || p === "/home" || p === "/home/lyrica" || p === "/etc" || [...machine.files.keys()].some((f) => f === p || f.startsWith(`${p}/`))) return p;
          throw missing(p);
        },
        lstat: async (p) => (machine.files.has(p) ? { uid: 1000, gid: 1000, mode: 0o100644, symlink: false } : undefined),
        readFile: async (p) => { const f = machine.files.get(p); if (f === undefined) throw missing(p); return Buffer.from(f); },
        readHead: async (p, n) => Buffer.from(machine.files.get(p) ?? "").subarray(0, n),
        check: async (p) => { if (!machine.files.has(p)) throw missing(p); },
        writeFile: async (p, c) => { machine.files.set(p, c.toString()); },
        chmod: async () => {},
        chown: async () => {},
        rename: async (from, to) => { machine.files.set(to, machine.files.get(from)!); machine.files.delete(from); },
        unlink: async (p) => { machine.files.delete(p); },
        close: () => {},
        onClose: () => {},
      };
      return session;
    },
  };
}

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

async function setup(machine: Partial<FakeMachine> = {}) {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const fake: FakeMachine = { hostKey: KEY, files: new Map(), commands: [], connects: [], ...machine };
  const workspace = new Workspace(keyring, users, { excludePorts: [], sshTransport: fakeTransport(fake) });
  const settings = workspace.settings(ada.id);
  const add = (m: Partial<NewMachine> & { name: string }) => settings.addMachine({
    host: "127.0.0.1", port: 22, username: "lyrica", privateKey: generateSshKey("test").privateKey, root: null, pool: "general", offNetwork: false, ...m,
  }, KEY);
  const thread = (threadId: string, pool: "general" | "private" = "general") => ({ userId: ada.id, pool, threadId });
  return { ada, workspace, settings, fake, add, thread };
}

describe("machines", () => {
  it("start at Ask, belong to one pool, and are granted only to threads of that pool", async () => {
    const { settings, add } = await setup();
    expect(add({ name: "nas" }).limit).toBe("ask");
    add({ name: "vault", pool: "private" });
    expect(() => settings.addMachine({ name: "x", host: "h", port: 22, username: "u", privateKey: "k", root: null, pool: "general", offNetwork: false }, "trust me"))
      .toThrow(/confirm the machine's host key/);
    settings.setThread("g", "general", { machines: ["nas"] });
    expect(() => settings.setThread("g", "general", { machines: ["vault"] })).toThrow(/vault is a private machine; a general thread can't use it/);
    expect(() => settings.setThread("p", "private", { machines: ["nas"] })).toThrow(/nas is a general machine; a private thread can't use it/);
    settings.setThread("p", "private", { machines: ["vault"] });
    expect(settings.thread("g").machines).toEqual(["nas"]);
  });

  it("may log in as the user's own account, set up without root, in either pool", async () => {
    const { settings, workspace, thread, ada } = await setup();
    const own = await workspace.probeMachine(ada.id, "ada", { name: "laptop", address: "ada@127.0.0.1", asUser: true });
    expect(own.login).toBe(true);
    expect(own.setup).toContain(`>> ~/.ssh/authorized_keys`);
    expect(own.setup).toContain("run as ada, not as root");
    expect(own.setup).not.toMatch(/sshd_config|sudoers|NOPASSWD/);
    const hers = await workspace.probeMachine(ada.id, "ada", { name: "box", address: "lyrica@127.0.0.1" });
    expect(hers.setup).toContain("/etc/ssh/authorized_keys/lyrica");
    const m = await workspace.addMachine(ada.id, { name: "laptop", address: "ada@127.0.0.1", root: null, pool: "private", draft: own.draft, hostKey: KEY, asUser: true });
    expect(m).toMatchObject({ asUser: true, pool: "private", limit: "ask", username: "ada" });
    expect((await workspace.addMachine(ada.id, { name: "box", address: "lyrica@127.0.0.1", root: null, pool: "general", draft: hers.draft, hostKey: KEY })).asUser).toBe(false);
    settings.setThread("p", "private", { machines: ["laptop"] });
    expect(workspace.machinesFor(thread("p", "private"))).toEqual([{ name: "laptop", kind: "ssh", limit: "ask", root: null, asUser: true }]);
  });

  it("leave every thread that granted them when their pool changes", async () => {
    const { settings, add, workspace, thread } = await setup();
    add({ name: "nas" });
    settings.setThread("g", "general", { machines: ["nas"] });
    settings.allowInThread("g", "nas", "sudo reboot");
    settings.setMachinePool("nas", "private");
    expect(settings.thread("g").machines).toEqual([]);
    expect(settings.allowedInThread("g")).toEqual([]);
    expect(() => workspace.targetFor(thread("g"), "nas")).toThrow(/isn't one of this thread's machines/);
  });

  it("keep their limit at every depth, and narrow a child when its parent is narrowed later", async () => {
    const { settings, add, workspace, thread } = await setup();
    add({ name: "nas", limit: "acceptEdits" });
    add({ name: "pi", limit: "auto" });
    settings.setThread("top", "general", { mode: "auto", machines: ["nas", "pi"] });
    settings.inheritSettings("top", "child", "general");
    settings.inheritSettings("child", "grandchild", "general", { machines: ["nas"] });
    expect(() => settings.inheritSettings("child", "wider", "general", { machines: ["nas", "elsewhere"] })).toThrow(/no machine elsewhere|isn't in the parent/);
    expect(workspace.callMode(thread("grandchild"), "nas")).toBe("acceptEdits");
    expect(workspace.callMode(thread("child"), "pi")).toBe("auto");
    settings.setThread("top", "general", { machines: ["nas"] });
    expect(workspace.machinesFor(thread("child")).map((m) => m.name)).toEqual(["nas"]);
    expect(() => workspace.targetFor(thread("child"), "pi")).toThrow(/isn't one of this thread's machines/);
    expect(workspace.targetFor(thread("child"), "nas").name).toBe("ssh:nas");
    settings.setThread("top", "general", { mode: "ask" });
    expect(workspace.callMode(thread("grandchild"), "nas")).toBe("ask");
    settings.setThread("top", "general", { machines: [] });
    expect(workspace.machinesFor(thread("grandchild"))).toEqual([]);
  });

  it("keep a per-thread allow in that thread only", async () => {
    const { settings, add, workspace, thread } = await setup();
    add({ name: "nas" });
    settings.setThread("a", "general", { machines: ["nas"] });
    settings.setThread("b", "general", { machines: ["nas"] });
    settings.allowInThread("a", "nas", "sudo reboot");
    expect(workspace.forThread(thread("a")).allowedInThread("nas", "sudo reboot")).toBe(true);
    expect(workspace.forThread(thread("b")).allowedInThread("nas", "sudo reboot")).toBe(false);
    expect(workspace.forThread(thread("a")).allowedInThread("nas", "sudo reboot now")).toBe(false);
    // A change of settings keeps it.
    settings.setThread("a", "general", { mode: "ask" });
    expect(settings.allowedInThread("a")).toEqual([{ machine: "nas", command: "sudo reboot" }]);
  });

  it("refuse a private machine whose address newly resolves off network, until Ada confirms", async () => {
    const { settings, add, workspace, thread, fake } = await setup();
    add({ name: "vault", pool: "private" });
    settings.setThread("p", "private", { machines: ["vault"] });
    const run = () => workspace.targetFor(thread("p", "private"), "vault").ops().bash.exec("uptime", "/", { onData: () => {} });
    await run();
    expect(fake.connects).toEqual(["127.0.0.1"]);
    workspace.updateMachine(thread("p").userId, "vault", { address: "lyrica@192.0.2.7" });
    await expect(run()).rejects.toThrow(/192.0.2.7 now resolves outside your network/);
    expect(fake.connects).toHaveLength(1);
    workspace.confirmOffNetwork(thread("p").userId, "vault");
    await run();
    expect(fake.connects).toEqual(["127.0.0.1", "192.0.2.7"]);
    // Back on network clears it, so leaving again asks again.
    workspace.updateMachine(thread("p").userId, "vault", { address: "lyrica@10.0.0.9" });
    await run();
    expect(settings.machine("vault")!.offNetwork).toBe(false);
  });

  it("fail with no fallback when the host key changes, and without a confirmed key", async () => {
    const { settings, add, workspace, thread, fake } = await setup({ hostKey: OTHER });
    add({ name: "nas" });
    settings.setThread("g", "general", { machines: ["nas"] });
    const target = workspace.targetFor(thread("g"), "nas");
    await expect(target.ops().bash.exec("uptime", "/", { onData: () => {} })).rejects.toThrow(/ssh nas: its host key changed/);
    expect(fake.commands).toEqual([]);
    expect(settings.machine("nas")!.state?.kind).toBe("keyChanged");
    workspace.setHostKey(thread("g").userId, "nas", OTHER);
    expect(settings.machine("nas")!.state).toBeNull();
    await workspace.targetFor(thread("g"), "nas").ops().bash.exec("uptime", "/", { onData: () => {} });
    expect(fake.commands).toEqual(["cd '/home/lyrica' && uptime"]);
    expect(settings.machine("nas")!.state?.kind).toBe("online");
  });

  it("keep how the last connection went, and since when", async () => {
    const { settings, add, workspace, thread, fake } = await setup();
    add({ name: "nas" });
    settings.setThread("g", "general", { machines: ["nas"] });
    const run = () => workspace.targetFor(thread("g"), "nas").ops().bash.exec("uptime", "/", { onData: () => {} });
    expect(settings.machine("nas")!.state).toBeNull();
    fake.down = true;
    await expect(run()).rejects.toThrow(/ECONNREFUSED/);
    const down = settings.machine("nas")!.state!;
    expect(down.kind).toBe("unreachable");
    await new Promise((r) => setTimeout(r, 5));
    await expect(run()).rejects.toThrow(/ECONNREFUSED/);
    expect(settings.machine("nas")!.state).toEqual(down);
    fake.down = false;
    await run();
    expect(settings.machine("nas")!.state?.kind).toBe("online");
    // The same address again keeps it; a new one clears it.
    workspace.updateMachine(thread("g").userId, "nas", { address: "lyrica@127.0.0.1" });
    expect(settings.machine("nas")!.state?.kind).toBe("online");
    workspace.updateMachine(thread("g").userId, "nas", { address: "lyrica@10.0.0.9" });
    expect(settings.machine("nas")!.state).toBeNull();
    // A name that no longer resolves is unreachable too.
    workspace.updateMachine(thread("g").userId, "nas", { address: "lyrica@gone.invalid" });
    await expect(run()).rejects.toThrow();
    expect(settings.machine("nas")!.state?.kind).toBe("unreachable");
  });

  it("never let write or edit touch SSH's or sudo's files, in any mode", async () => {
    const { settings, add, workspace, thread, fake } = await setup();
    add({ name: "nas" });
    settings.setThread("g", "general", { machines: ["nas"], mode: "auto" });
    const ops = workspace.targetFor(thread("g"), "nas").ops();
    for (const path of ["/home/lyrica/.ssh/authorized_keys", "/etc/ssh/sshd_config", "/etc/sudoers", "/etc/sudoers.d/lyrica", "/root/.ssh/x"]) {
      await expect(ops.write.writeFile(path, "x")).rejects.toThrow(/SSH's or sudo's/);
      await expect(ops.edit.writeFile(path, "x")).rejects.toThrow(/SSH's or sudo's/);
    }
    await expect(ops.write.mkdir("/home/lyrica/.ssh")).rejects.toThrow(/SSH's or sudo's/);
    await ops.write.writeFile("/home/lyrica/notes.txt", "fine");
    expect(fake.files.get("/home/lyrica/notes.txt")).toBe("fine");
  });

  it("mask private keys and terminal control in what she sees", async () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n";
    const { settings, add, workspace, thread } = await setup({ output: `before\n\x1b[31mred\x1b[0m\n${key}after\n`, files: new Map([["/home/lyrica/id", key]]) });
    add({ name: "nas" });
    settings.setThread("g", "general", { machines: ["nas"] });
    const ops = workspace.targetFor(thread("g"), "nas").ops();
    let out = "";
    await ops.bash.exec("cat id", "/", { onData: (d) => { out += d.toString(); } });
    expect(out).toBe("before\nred\n[private key removed]\nafter\n");
    expect((await ops.read.readFile("/home/lyrica/id")).toString()).toBe("[private key removed]\n");
    // edit reads it as it is, so writing it back doesn't destroy the key.
    expect((await ops.edit.readFile("/home/lyrica/id")).toString()).toBe(key);
  });
});

describe("suspect commands", () => {
  it("catch the commands on the list however they're written", () => {
    for (const c of ["rm -rf /", "sudo rm -rf --no-preserve-root /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -fr $HOME", "rm -r /home/ada", "rm -rf /etc/",
      "cd /tmp && rm -rf /usr", "sudo mkfs.ext4 /dev/sdb1", "dd if=img of=/dev/sda bs=4M", "chmod -R 777 /", "sudo chown -R ada /", "userdel ada",
      "sudo shutdown -h now", "/sbin/reboot", "sudo systemctl reboot", "poweroff", "qm destroy 101", "echo hi; sudo -n reboot",
      "sudo -u root rm -rf /", "nice -n 5 rm -rf /", "timeout 5 rm -rf /", "bash -c 'rm -rf /'", "chmod -R 777 /*", "chown -R ada //"]) {
      expect(suspectCommand(c), c).toBeDefined();
    }
    for (const c of ["rm -rf ./build", "rm -rf /home/ada/tmp", "rm -rf ~/cache", "dd if=/dev/zero of=file", "chmod -R 755 /srv/www", "ls /", "qm list",
      "systemctl restart nginx", "echo reboot"]) {
      expect(suspectCommand(c), c).toBeUndefined();
    }
    expect(suspectCommand("sudo reboot")).toBe("This shuts the machine down or restarts it.");
  });
});

describe("output cleaning", () => {
  it("keeps machine key masking byte-preserving around the shared detector", () => {
    const content = Buffer.from("ÿ\n-----BEGIN OPENSSH PRIVATE KEY-----\nfiction\n-----END OPENSSH PRIVATE KEY-----\nGH_TOKEN", "latin1");
    expect(maskKeys(content).toString("latin1")).toBe("ÿ\n[private key removed]\nGH_TOKEN");
  });
  it("masks a key block split across chunks and keeps the rest streaming", () => {
    const got: string[] = [];
    const clean = cleanOutput((d) => got.push(d.toString()));
    clean.push(Buffer.from("one\n-----BEGIN RSA PRIV"));
    clean.push(Buffer.from("ATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\ntwo"));
    clean.end();
    expect(got.join("")).toBe("one\n[private key removed]\ntwo");
    expect(maskKeys(Buffer.from("x\n-----BEGIN PRIVATE KEY-----\nAAA")).toString()).toBe("x\n[private key removed]");
    const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\n";
    expect(maskKeys(Buffer.from(`a\n${pgp}b`)).toString()).toBe("a\n[private key removed]\nb");
    const out: string[] = [];
    const c = cleanOutput((d) => out.push(d.toString()));
    c.push(Buffer.from(pgp));
    c.end();
    expect(out.join("")).toBe("[private key removed]\n");
  });

  it("keeps characters split across chunks, and holds back a key header after a long line", () => {
    const got: string[] = [];
    const clean = cleanOutput((d) => got.push(d.toString()));
    const zh = Buffer.from("你好\n");
    clean.push(zh.subarray(0, 2));
    clean.push(zh.subarray(2));
    const long = "x".repeat(9000);
    clean.push(Buffer.from(`${long}-----BEGIN OPENSSH PRIV`));
    clean.push(Buffer.from("ATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nok\n"));
    clean.end();
    expect(got.join("")).toBe(`你好\n${long}[private key removed]\nok\n`);
  });
});

describe("an older user.db", () => {
  it("turns SSH targets into general machines at Ask, and a thread's target into its machine", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const db: Db = users.openUserDb(ada.id);
    db.exec(`DROP TABLE thread_workspaces; DROP TABLE machines; DROP TABLE model_presets; DROP TABLE model_columns; PRAGMA user_version = 0;
      CREATE TABLE thread_workspaces (thread_id TEXT PRIMARY KEY, grants TEXT NOT NULL, internet INTEGER, services INTEGER, hosts TEXT,
        mode TEXT NOT NULL, target TEXT NOT NULL, parent TEXT, web_search INTEGER NOT NULL DEFAULT 1, images INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE ssh_targets (name TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, private_key TEXT NOT NULL, root TEXT, host_key TEXT);
      INSERT INTO ssh_targets VALUES ('nas', 'nas.lan', 22, 'lyrica', 'key', NULL, NULL);
      INSERT INTO thread_workspaces (thread_id, grants, mode, target) VALUES ('t1', '[]', 'ask-changes', 'ssh:nas'), ('t2', '[]', 'auto', 'sandbox');`);
    migrate(db, "user");
    const settings = new WorkspaceSettings(db, () => ({ general: [], private: [] }));
    expect(settings.machine("nas")).toMatchObject({ pool: "general", limit: "ask", hostKey: null, offNetwork: false, state: null });
    expect(settings.thread("t1")).toMatchObject({ machines: ["nas"], mode: "ask" });
    expect(settings.thread("t2").machines).toEqual([]);
    settings.close();
  });
});
