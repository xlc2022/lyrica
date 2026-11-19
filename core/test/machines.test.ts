import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callArgs, cleanOutput, discardingGit, machineSetup, machineSudo, removedFolders, generateSshKey, maskKeys, migrate, RemoteMissing, suspectCommand, Users, writtenFiles, Workspace, WorkspaceSettings,
  type Db, type NewMachine, type SshSession, type SshTransport,
} from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";
import { NOT_NIXOS } from "../src/workspace/sudoers.ts";

// Machines with a fake SSH client: an in-memory machine whose host key and
// files the tests control. The real client against a real sshd is in
// workspace.test.ts.

const KEY = `SHA256:${"A".repeat(43)}`;
const OTHER = `SHA256:${"B".repeat(43)}`;

interface FakeMachine { hostKey: string; files: Map<string, string>; commands: string[]; output?: string; connects: string[]; keys: string[]; down?: boolean; accepts?: string[] }

function fakeTransport(machine: FakeMachine): SshTransport {
  return {
    async connect(to, verify) {
      machine.connects.push(to.host);
      machine.keys.push(to.privateKey);
      if (machine.down) throw new Error("connect ECONNREFUSED");
      if (!verify(machine.hostKey)) throw new Error("host key refused");
      if (machine.accepts && !machine.accepts.includes(to.privateKey)) throw new Error("All configured authentication methods failed");
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
  const fake: FakeMachine = { hostKey: KEY, files: new Map(), commands: [], connects: [], keys: [], ...machine };
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

  it("never take a name that means no machine, which a call's machine argument treats as the sandbox", async () => {
    const { add } = await setup();
    for (const name of ["null", "None", "sandbox", "undefined"]) expect(() => add({ name })).toThrow(/means no machine/);
    expect(callArgs("bash", { command: "ls", machine: "null" })).toEqual({ command: "ls" });
    expect(callArgs("bash", { command: "ls", machine: "nas" })).toEqual({ command: "ls", machine: "nas" });
    expect(callArgs("proxmox", { action: "list", machine: "null" })).toEqual({ action: "list", machine: "null" });
  });

  it("may log in as the user's own account, set up without root, in either pool", async () => {
    const { settings, workspace, thread, ada } = await setup();
    const own = await workspace.probeMachine(ada.id, "ada", { name: "laptop", address: "ada@127.0.0.1", asUser: true });
    expect(own.login).toBe(true);
    expect(own.setup).toContain(`>> ~/.ssh/authorized_keys`);
    expect(own.setup).toContain("run as ada, without sudo");
    expect(own.setup).not.toMatch(/sshd_config|sudoers|NOPASSWD|sudo /);
    expect(own.sudo).toBeUndefined();
    const hers = await workspace.probeMachine(ada.id, "ada", { name: "box", address: "lyrica@127.0.0.1" });
    expect(hers.setup).toContain("/etc/ssh/authorized_keys/lyrica");
    // Her account is made first where the machine lacks it, with a password that matches nothing but doesn't lock it, so sshd takes her key.
    expect(hers.setup).toContain("{ id -u lyrica > /dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash --password '*' lyrica; } &&");
    expect(hers.setup.indexOf("useradd")).toBeLessThan(hers.setup.indexOf("authorized_keys"));
    // On NixOS, where its sshd rule would never be read, it stops before changing anything, and so does sudo with a password.
    expect(hers.setup.indexOf(NOT_NIXOS)).toBeLessThan(hers.setup.indexOf("useradd"));
    expect(hers.sudo!.password.indexOf(NOT_NIXOS)).toBeLessThan(hers.sudo!.password.indexOf("passwd"));
    expect(own.setup).not.toContain("useradd");
    expect(spawnSync("bash", ["-n"], { input: hers.setup }).status).toBe(0);
    // Her line is added beside any key already there, never written over it, and each account has its own sshd file.
    expect(hers.setup).toContain(`printf '%s\\n' '${hers.keyLine}' | sudo tee -a /etc/ssh/authorized_keys/lyrica > /dev/null`);
    expect(hers.setup).toContain("| sudo tee /etc/ssh/sshd_config.d/lyrica-lyrica.conf > /dev/null");
    // Pasted whole as a user with sudo: no write runs as that user, and the commands are one chain, so sudo's password prompt can't swallow a later line.
    expect(hers.setup).not.toMatch(/>>? ?\/etc\//);
    for (const line of hers.setup.split("\n").filter((l) => l && !l.startsWith("#")).slice(0, -1)) expect(line).toMatch(/ &&$/);
    // The sudo rights are separate commands, each checked by visudo before sudo reads it, never in the setup.
    expect(hers.setup).not.toMatch(/NOPASSWD/);
    expect(hers.sudo!.everything).toContain("'lyrica ALL=(root) NOPASSWD: ALL'");
    expect(hers.sudo!.everything).toContain("sudo visudo -c -f /etc/sudoers.d/lyrica.new");
    const m = await workspace.addMachine(ada.id, { name: "laptop", address: "ada@127.0.0.1", root: null, pool: "private", draft: own.draft, hostKey: KEY, asUser: true });
    expect(m).toMatchObject({ asUser: true, pool: "private", limit: "ask", username: "ada" });
    expect((await workspace.addMachine(ada.id, { name: "box", address: "lyrica@127.0.0.1", root: null, pool: "general", draft: hers.draft, hostKey: KEY })).asUser).toBe(false);
    settings.setThread("p", "private", { machines: ["laptop"] });
    expect(workspace.machinesFor(thread("p", "private"))).toEqual([{ name: "laptop", kind: "ssh", limit: "ask", root: null, asUser: true }]);
    // The account is fixed once chosen, and root is never hers.
    await expect(workspace.updateMachine(ada.id, "box", { address: "ada@127.0.0.1" })).rejects.toThrow(/account can't change/);
    expect((await workspace.updateMachine(ada.id, "box", { address: "lyrica@127.0.0.1:2222" })).port).toBe(2222);
    await expect(workspace.probeMachine(ada.id, "ada", { name: "srv", address: "root@127.0.0.1", asUser: true })).rejects.toThrow(/never logs in as root/);
    // The account goes unquoted into the block the user pastes and into sudoers lines, so it is a plain user name.
    for (const bad of ["a;id@127.0.0.1", "$(id)@127.0.0.1", "-x@127.0.0.1"]) await expect(workspace.probeMachine(ada.id, "ada", { name: "srv", address: bad })).rejects.toThrow(/the account is a user name/);
  });

  it("on NixOS, give a module for the configuration and a rebuild, with sudo as extraRules, since its sshd and sudo read no drop-in folders", async () => {
    const { settings, workspace, ada } = await setup();
    const hers = await workspace.probeMachine(ada.id, "ada", { name: "nix", address: "lyrica@127.0.0.1", nixos: true });
    expect(hers.setup).toContain(`users.users.lyrica = {\n    isNormalUser = true;\n    openssh.authorizedKeys.keys = [ "${hers.keyLine}" ];`);
    expect(hers.setup).toContain("services.openssh.extraConfig = lib.mkAfter ''\n    Match User lyrica\n        AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u\n        PasswordAuthentication no");
    expect(hers.setup).not.toMatch(/sudo |sshd_config\.d|sudoers\.d/);
    expect(hers.rebuild).toMatch(/^sudo nixos-rebuild switch &&\n[^]*ssh-keygen -lf /);
    // Each sudo block is a module of its own for imports: two extraRules in one attribute set don't evaluate, separate modules' lists merge.
    expect(hers.sudo!.everything).toBe('# A file of its own, added to the configuration\'s imports before the rebuild\n{\n  security.sudo.extraRules = [{\n    users = [ "lyrica" ];\n    runAs = "root";\n    commands = [ { command = "ALL"; options = [ "NOPASSWD" ]; } ];\n  }];\n}');
    expect(hers.sudo!.password).toMatch(/^# A file of its own[^\n]*\n\{\n  security\.sudo\.extraRules = \[\{/);
    expect(hers.sudo!.password).toContain('commands = [ "ALL" ];');
    expect(hers.sudo!.password).toContain("#   sudo passwd lyrica");
    // Saved whole as a file, it is still one module: nothing but comments after its closing brace.
    expect(hers.sudo!.password.slice(hers.sudo!.password.lastIndexOf("}") + 1).split("\n").every((l) => l === "" || l.startsWith("#"))).toBe(true);
    const own = await workspace.probeMachine(ada.id, "ada", { name: "nixlap", address: "ada@127.0.0.1", asUser: true, nixos: true });
    expect(own.setup).toBe(`{\n  # Her key, beside your own\n  users.users.ada.openssh.authorizedKeys.keys = [ "${own.keyLine}" ];\n}`);
    expect(own.sudo).toBeUndefined();
    // A dotted account is quoted, or Nix would read it as a nested path.
    expect((await workspace.probeMachine(ada.id, "ada", { name: "nixdot", address: "first.last@127.0.0.1", nixos: true })).setup).toContain('users.users."first.last" = {');
    // Saved with the machine, so Replace key and Remove machine give the NixOS steps again.
    expect((await workspace.addMachine(ada.id, { name: "nix", address: "lyrica@127.0.0.1", root: null, pool: "general", draft: hers.draft, hostKey: KEY, nixos: true })).nixos).toBe(true);
    expect((await workspace.probeMachine(ada.id, "ada", { name: "nix", address: "", replace: true })).rebuild).toContain("nixos-rebuild");
    expect(settings.machine("nix")!.nixos).toBe(true);
  });

  it("give a key line that works from any address, and a setup that replaces an older line for the same key", async () => {
    const { workspace, ada } = await setup();
    const own = await workspace.probeMachine(ada.id, "ada", { name: "laptop", address: "ada@127.0.0.1", asUser: true });
    // Pinned to the server's addresses, a key stops working when the server moves network.
    expect(own.keyLine).toMatch(/^restrict ssh-ed25519 \S+/);
    const blob = own.keyLine!.split(" ")[2]!;
    const home = mkdtempSync(join(tmpdir(), "lyrica-keys-"));
    try {
      mkdirSync(join(home, ".ssh"), { mode: 0o700 });
      const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERKEYOTHERKEYOTHERKEYOTHERKEYOTHERKEYOT other";
      writeFileSync(join(home, ".ssh", "authorized_keys"), `${other}\nrestrict,from="10.0.0.2,fe80::1" ssh-ed25519 ${blob} lyrica:ada:laptop\n`);
      // The last line, the fingerprint, reads this computer's host key, which a test host may lack.
      spawnSync("bash", ["-c", own.setup!], { env: { ...process.env, HOME: home } });
      expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(`${other}\n${own.keyLine}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("say why the user's own account can't log in when it is already hers on that machine", async () => {
    const { workspace, add, ada, fake } = await setup();
    const hers = generateSshKey("test");
    add({ name: "box", username: "lyrica", privateKey: hers.privateKey });
    fake.accepts = [hers.privateKey];
    const own = await workspace.probeMachine(ada.id, "ada", { name: "mine", address: "lyrica@127.0.0.1", asUser: true });
    expect(own.login).toBe(false);
    expect(own.problem).toBe("lyrica is already her account on box: sshd reads its keys from /etc/ssh/authorized_keys/lyrica, never ~/.ssh, so a key added as your own can't log in. Use your own account, or box as it is.");
    // Another account there, or the same one not as the user's own, gets sshd's own words.
    expect((await workspace.probeMachine(ada.id, "ada", { name: "mine", address: "ada@127.0.0.1", asUser: true })).problem).toBe("All configured authentication methods failed");
    expect((await workspace.probeMachine(ada.id, "ada", { name: "again", address: "lyrica@127.0.0.1" })).problem).toBe("All configured authentication methods failed");
  });

  it("are tried as saved by Replace key: their own key, account and address, with no new pair", async () => {
    const { workspace, add, ada, fake } = await setup();
    const own = generateSshKey("test");
    add({ name: "nas", host: "127.0.0.2", port: 2222, privateKey: own.privateKey });
    const again = await workspace.probeMachine(ada.id, "ada", { name: "nas", address: "elsewhere@127.0.0.1", replace: true });
    expect(again).toMatchObject({ fingerprint: KEY, login: true, offNetwork: false });
    expect(again.draft).toBeUndefined();
    expect(again.keyLine).toContain(own.publicKey.split(" ")[1]);
    expect(fake.connects).toEqual(["127.0.0.2"]);
    expect(fake.keys).toEqual([own.privateKey]);
    // Whatever key it shows now is reported: that is what the user compares and confirms.
    fake.hostKey = OTHER;
    expect(await workspace.probeMachine(ada.id, "ada", { name: "nas", address: "", replace: true })).toMatchObject({ fingerprint: OTHER, login: true });
    await expect(workspace.probeMachine(ada.id, "ada", { name: "nope", address: "", replace: true })).rejects.toThrow(/no machine nope/);
  });

  it("get a new key pair from Replace key: the tested draft replaces her key, and a stale draft is refused", async () => {
    const { workspace, settings, add, ada, fake } = await setup();
    const old = generateSshKey("test");
    add({ name: "nas", privateKey: old.privateKey });
    // New key pair: the probe without `replace` makes a pair for the machine, as when adding it.
    const fresh = await workspace.probeMachine(ada.id, "ada", { name: "nas", address: "lyrica@127.0.0.1" });
    expect(fresh.draft).toBeDefined();
    expect(fresh.keyLine).not.toContain(old.publicKey.split(" ")[1]);
    expect(fresh.setup).toContain("| sudo tee -a /etc/ssh/authorized_keys/lyrica");
    await expect(workspace.setHostKey(ada.id, "nas", KEY, undefined, "nope")).rejects.toThrow(/key pair has expired/);
    // A pair tested more than an hour ago has expired, even before the next probe prunes it.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61 * 60_000);
    await expect(workspace.setHostKey(ada.id, "nas", KEY, undefined, fresh.draft)).rejects.toThrow(/key pair has expired/);
    vi.restoreAllMocks();
    expect(settings.machine("nas")!.privateKey).toBe(old.privateKey);
    await workspace.setHostKey(ada.id, "nas", OTHER, undefined, fresh.draft);
    const saved = settings.machine("nas")!;
    expect(saved.privateKey).toBe(fake.keys.at(-1));
    expect(saved.privateKey).not.toBe(old.privateKey);
    expect(saved.hostKey).toBe(OTHER);
    // The pair is hers now, and is used once: the same draft can't be saved twice.
    await expect(workspace.setHostKey(ada.id, "nas", OTHER, undefined, fresh.draft)).rejects.toThrow(/key pair has expired/);
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
    // The refusal is the row's state, which is what offers Use anyway: without it there is nothing in Settings to confirm.
    expect(settings.machine("vault")).toMatchObject({ offNetwork: false, state: { kind: "offNetwork" } });
    expect(workspace.confirmOffNetwork(thread("p").userId, "vault")).toMatchObject({ offNetwork: true, state: null });
    await run();
    expect(settings.machine("vault")!.state?.kind).toBe("online");
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
    // In its own session (groupRun), so a stop takes what it started; a machine with no setsid runs it as written.
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toMatch(/^export PATH="\$PATH:\/usr\/sbin:\/sbin" && cd '\/home\/lyrica' && if command -v setsid .* setsid "\$\{SHELL:-\/bin\/sh\}" -c 'uptime' <&0 & .* else uptime\nfi$/s);
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
  it("name the folders where git is about to throw work away", () => {
    expect(discardingGit("git reset --hard origin/main")).toEqual(["."]);
    expect(discardingGit("git fetch && git checkout -- . && git clean -fd")).toEqual(["."]);
    expect(discardingGit("cd repo && git reset --hard")).toEqual(["repo"]);
    expect(discardingGit("git -C /work/a restore src/x.ts; cd b; git switch -f main")).toEqual(["/work/a", "b"]);
    // Only git that discards: a delete, a force push or a branch delete is another rule's.
    for (const c of ["git status", "git checkout -b feature", "git stash", "rm -rf build", "git push --force", "git branch -D old", "git clean -n"]) {
      expect(discardingGit(c), c).toEqual([]);
    }
  });
  it("name the folders rm -r deletes, so a checkout in one can be saved first", () => {
    expect(removedFolders("rm -rf lyrica && git clone https://example.com/lyrica.git")).toEqual(["lyrica"]);
    expect(removedFolders("cd repos; rm -r -f -- lyrica /work/old")).toEqual(["repos/lyrica", "/work/old"]);
    expect(removedFolders("rm --recursive --force build")).toEqual(["build"]);
    for (const c of ["rm notes.txt", "rm -f a b", "rm -rf $DIR", "git rm -r src"]) expect(removedFolders(c), c).toEqual([]);
  });
  it("catch the commands on the list however they're written", () => {
    for (const c of ["rm -rf /", "sudo rm -rf --no-preserve-root /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -fr $HOME", "rm -r /home/ada", "rm -rf /etc/",
      "cd /tmp && rm -rf /usr", "sudo mkfs.ext4 /dev/sdb1", "dd if=img of=/dev/sda bs=4M", "chmod -R 777 /", "sudo chown -R ada /", "userdel ada",
      "sudo shutdown -h now", "/sbin/reboot", "sudo systemctl reboot", "poweroff", "qm destroy 101", "echo hi; sudo -n reboot",
      "sudo -u root rm -rf /", "nice -n 5 rm -rf /", "timeout 5 rm -rf /", "bash -c 'rm -rf /'", "chmod -R 777 /*", "chown -R ada //", "r{m,} -rf /", "/bin/{rm,ls} -rf /", "rm -r{f,} /"]) {
      expect(suspectCommand(c), c).toBeDefined();
    }
    for (const c of ["rm build.log", "rm -f build.log", "dd if=/dev/zero of=file", "chmod -R 755 /srv/www", "ls /", "qm list",
      "systemctl restart nginx", "echo reboot", "git push", "git push -u origin main", "git push --follow-tags", "git reset --soft HEAD~1", "git checkout -b feature",
      "git restore --staged src/a.ts", "git branch -d old", "git stash", "git stash pop", "git switch main", "git clean -n", "git clean --dry-run -d"]) {
      expect(suspectCommand(c), c).toBeUndefined();
    }
    expect(suspectCommand("sudo reboot")).toBe("This shuts the machine down or restarts it.");
  });
  it("read a shell's -c line wherever -c stands among its options", () => {
    for (const c of ["bash -ec 'rm -rf /'", "bash -lc 'rm -rf /'", "sh -xc reboot", "sudo bash -ec 'parted -s /dev/sda mklabel gpt && mkfs.ext4 /dev/sda1'",
      "env FOO=1 dash -euc 'mkfs.ext4 /dev/sdb1'", "zsh -ic reboot", "bash -e -c reboot", "bash -o pipefail -c reboot", "bash -oc pipefail reboot", "bash -co pipefail reboot", "bash -O extglob -c reboot", "bash --norc -xc reboot",
      "/bin/sh -c -e reboot", "sudo -u root /usr/bin/bash -lec 'rm -rf ~'", "fish --command reboot", "fish --command=reboot",
      "zsh --emulate sh -c 'rm -rf /'", "fish -C 'rm -rf /' -c true", "fish --init-command=reboot -c true", "bash x.sh -c reboot", "bash -c - reboot"]) {
      expect(suspectCommand(c), c).toBeDefined();
    }
    // The line is the first word after the options; the rest are its arguments, not commands.
    for (const c of ["bash -ec 'echo hi' reboot", "bash -e script.sh reboot", "bash -o reboot", "bash -oc reboot", "sh -x", "bash --rcfile reboot", "bash -cx 'echo $0' reboot"]) expect(suspectCommand(c), c).toBeUndefined();
  });
  it("catch a disk's partition table rewritten or wiped, and leave reading it alone", () => {
    const wipe = "This rewrites a disk's partitions or wipes it, erasing what's on it.";
    for (const c of ["sudo sfdisk /dev/sda < table", "sfdisk --part-type /dev/sda 1 uefi", "fdisk /dev/nvme0n1", "sudo sgdisk --zap-all /dev/sda", "sgdisk -Z /dev/sda",
      "sgdisk -n 1:0:+1G -t 1:ef00 /dev/sda", "sgdisk --new=2:0:0 /dev/sda", "sgdisk -o /dev/sdb", "parted -s /dev/sda mklabel gpt", "parted /dev/sda -- mkpart root 1GiB 100%",
      "parted /dev/sda rm 2", "sudo wipefs -a /dev/sda", "wipefs --all /dev/sda1", "wipefs -af /dev/sda", "blkdiscard /dev/nvme0n1"]) {
      expect(suspectCommand(c), c).toBe(wipe);
      expect(suspectCommand(c, "sandbox"), c).toBeUndefined();
    }
    for (const c of ["sfdisk -l", "sudo sfdisk --dump /dev/sda", "sfdisk -J /dev/sda", "fdisk -l /dev/sda", "sgdisk -p /dev/sda", "sgdisk --print /dev/sda", "sgdisk -v /dev/sda",
      "parted -l", "parted /dev/sda print", "wipefs /dev/sda", "lsblk -f"]) {
      expect(suspectCommand(c), c).toBeUndefined();
    }
  });
  it("read a cd earlier on the line, so a relative delete points where it will run", () => {
    const sweep = "This deletes everything, a home folder or a system folder.";
    for (const c of ["cd / && rm -rf *", "cd /; rm -rf .", "cd /home/ada && rm -rf *", "cd && rm -rf *", "cd /tmp && cd .. && rm -rf *", "(cd /usr && rm -rf ./*)", "bash -c 'cd / && rm -rf *'"]) {
      expect(suspectCommand(c), c).toBe(sweep);
    }
    // A delete in a folder of its own stays an ordinary recursive delete.
    expect(suspectCommand("cd /srv/www && rm -rf *")).toBe("This deletes a folder and everything in it.");
    expect(suspectCommand("cd $DIR && rm -rf *")).toBe("This deletes a folder and everything in it.");
  });
  it("ask about work she can't undo in the sandbox too, and only about that there", () => {
    const folder = "This deletes a folder and everything in it.", changes = "This throws away uncommitted changes.";
    const cases: [string, string][] = [
      ["rm -rf ./build", folder], ["rm -r node_modules", folder], ["rm --recursive -f dist", folder], ["sudo rm -fr /var/tmp/x", folder], ["rm -rf /", "This deletes everything, a home folder or a system folder."],
      ["git push --force", "This rewrites the branch on the remote: commits there that aren't here are lost."], ["git push -f origin main", "This rewrites the branch on the remote: commits there that aren't here are lost."],
      ["git -C repo push origin +main", "This rewrites the branch on the remote: commits there that aren't here are lost."], ["git push --force-with-lease", "This rewrites the branch on the remote: commits there that aren't here are lost."],
      ["git reset --hard HEAD~1", changes], ["git checkout -- .", changes], ["git checkout .", changes], ["git checkout -f main", changes], ["git switch --discard-changes main", changes], ["git switch -f main", changes],
      ["git restore src/a.ts", changes], ["git restore --staged --worktree .", changes],
      ["git clean -fdx", "This deletes untracked files for good."],
      ["git branch -D feature", "This deletes a branch, or a stash with its changes."], ["git branch --delete --force feature", "This deletes a branch, or a stash with its changes."],
      ["git push origin --delete feature", "This deletes a branch, or a stash with its changes."], ["git stash drop", "This deletes a branch, or a stash with its changes."], ["git stash clear", "This deletes a branch, or a stash with its changes."],
      ["npm run build && rm -rf dist", folder], ["bash -c 'git reset --hard'", changes],
      ["L=/lib/ld-linux-x86-64.so.2; \"$L\" --library-path /deps /bin/rm -rf build", folder], ["D=/; rm -rf $D", "This deletes everything, a home folder or a system folder."],
      ["bash <<'EOF'\nrm -rf build\nEOF", folder], ["cat <<'EOF' | sudo sh\nrm -rf build\nEOF", folder], ["sudo -s <<'EOF'\nrm -rf build\nEOF", folder], ["mksh <<'EOF'\nrm -rf build\nEOF", folder], ["D=/; rm -rf ${D}", "This deletes everything, a home folder or a system folder."], ["/lib64/ld-linux-x86-64.so.2 --inhibit-rpath x rm -rf ~/work", folder],
    ];
    for (const [c, warning] of cases) {
      expect(suspectCommand(c, "sandbox"), c).toBe(warning);
      expect(suspectCommand(c), c).toBe(warning);
    }
    // The machine-only rules don't apply in the sandbox.
    for (const c of ["sudo reboot", "mkfs.ext4 /dev/sdb1", "dd if=img of=/dev/sda", "chmod -R 777 /", "userdel ada", "qm destroy 101"]) {
      expect(suspectCommand(c, "sandbox"), c).toBeUndefined();
      expect(suspectCommand(c), c).toBeDefined();
    }
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

describe("the files a command plainly writes", () => {
  it("are its redirections' and tee's targets, and only names known before it runs", () => {
    expect(writtenFiles("echo '- terrain done' >> /shared/notes.md")).toEqual(["/shared/notes.md"]);
    expect(writtenFiles("cat >>notes.md <<'EOF'\nmore\nEOF")).toEqual(["notes.md"]);
    expect(writtenFiles("make 2> err.log > out.log && date | tee -a log.txt x.txt >/dev/null")).toEqual(["err.log", "out.log", "log.txt", "x.txt"]);
    expect(writtenFiles("bash -c 'echo hi > a.txt'")).toEqual(["a.txt"]);
    // After a cd, a relative name points elsewhere: only absolute ones are known.
    expect(writtenFiles("echo a > a.txt; cd /shared && echo x >> notes.md > /shared/log.md")).toEqual(["a.txt", "/shared/log.md"]);
    for (const c of ["ls 2>/dev/null", "make 2>&1 | grep x", "echo hi >&2", "echo x > $OUT", "echo 'a > b'", "cat notes.md", "sort < in.txt"]) {
      expect(writtenFiles(c), c).toEqual([]);
    }
  });
});

describe("sudo with a password", () => {
  it("keeps password logins out of SSH for her account, then sets the password and a sudoers line that asks for it", () => {
    expect(machineSetup("lyrica", "ssh-ed25519 AAAA x").setup).toContain("PasswordAuthentication no\\n    KbdInteractiveAuthentication no");
    const { password } = machineSudo("lyrica");
    const order = ["PasswordAuthentication no", "sudo sshd -t", "sudo systemctl reload ssh", "sudo passwd lyrica", "'lyrica ALL=(root) ALL'", "visudo -c"].map((x) => password.indexOf(x));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(password).not.toContain("NOPASSWD");
  });

  it("stops the shell setup on NixOS with a line naming System: NixOS, and lets it run elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "nixos-"));
    try {
      const guard = NOT_NIXOS.replace("/etc/NIXOS", join(dir, "NIXOS"));
      expect(spawnSync("bash", ["-c", `${guard} && echo ran`], { encoding: "utf8" }).stdout).toBe("ran\n");
      writeFileSync(join(dir, "NIXOS"), "");
      const r = spawnSync("bash", ["-c", `${guard} && echo ran`], { encoding: "utf8" });
      expect([r.status, r.stdout, r.stderr]).toEqual([1, "", "This machine runs NixOS: choose System: NixOS in Lyrica for its setup\n"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
