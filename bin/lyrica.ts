import { X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrap, Keyring, MACHINE_LIMITS, MIN_READER, SCHEMA, parseHost, proxmoxAddress, PersonaStore, PRONOUN_PRESETS, pronounLabel, Users, Workspace,
  type MachineLimit, type Pool, type Profile, type Pronouns, type User,
} from "@lyrica/core";
import { AgentSessionRuntime, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { BUILD, Lyricad, smokeTest } from "@lyrica/daemon";
import { openBench } from "./bench.ts";
import { modelsAdmin, MODELS_USAGE } from "./models.ts";

const USAGE = `usage:
  lyrica admin setup-code         (first run: the setup page's code, addresses and fingerprint)
  lyrica admin init               (first run from a terminal instead of the setup page)
  lyrica admin user add <login> [--admin]
  lyrica admin user list
  lyrica admin user set-admin <login> on|off
  lyrica admin user passwd <login>
  lyrica admin user profile <login>
  lyrica admin grants add|remove --user <login> --pool general|private <path>
  lyrica admin grants list --user <login>
  lyrica admin ssh add --user <login> <name> <account>@<host>[:<port>] [--root <path>] [--pool general|private] [--limit ask|acceptEdits|auto]
  lyrica admin ssh list|remove --user <login> [<name>]            (every machine, Proxmox ones too)
  lyrica admin proxmox add --user <login> <name> https://<host>[:<port>] [--pool general|private] [--limit ask|acceptEdits|auto]
  lyrica admin net show --user <login>
  lyrica admin net set --user <login> --pool general|private internet|services on|off
  lyrica admin net hosts add|remove --user <login> --pool general|private <host>
${MODELS_USAGE}
  lyrica dev --init <dir>
  lyrica dev --runtime <dir> --user <login> [--private | --local-only] [--debug-prompt]
  lyrica serve [--port <port>]   (default 7340)
  lyrica chat | mem              (not built yet)
  lyrica version [--json]        (the build, and each database's schema version and oldest reader)
  lyrica smoke-test <empty dir> [--port <port>]   (the updater's check of a release, with test data only)

serve and admin commands use --runtime <dir>, else LYRICA_HOME, else ./runtime.
Passwords are only read at a hidden prompt.`;

const SEED = fileURLToPath(new URL("../persona", import.meta.url));
const DEV_MARKER = "LYRICA_DEVELOPMENT_RUNTIME";
const STUBS: Record<string, string> = {
  chat: "lyrica chat, a client of lyricad, isn't built yet.",
  mem: "lyrica mem, a client of lyricad, isn't built yet.",
};

async function run(argv: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
    argv.splice(i, 2);
    return value;
  };
  const [cmd] = argv;
  if (cmd && cmd in STUBS) throw new Error(STUBS[cmd]);
  if (cmd === "admin") {
    const home = flag("--runtime") ?? process.env.LYRICA_HOME ?? "runtime";
    return admin(argv.slice(1), home);
  }
  if (cmd === "dev") return dev(argv.slice(1));
  if (cmd === "version") {
    const info = { version: BUILD.version, build: BUILD.build, schema: SCHEMA, minReader: MIN_READER };
    console.log(argv.includes("--json") ? JSON.stringify(info) : `Lyrica ${info.version}, build ${info.build}`);
    return;
  }
  if (cmd === "smoke-test") {
    const port = Number(flag("--port") ?? 0);
    const dir = argv[1];
    if (!dir) throw new Error(USAGE);
    const results = await smokeTest(dir, { port });
    for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (cmd === "serve") {
    const home = flag("--runtime") ?? process.env.LYRICA_HOME ?? "runtime";
    const port = Number(flag("--port") ?? 7340);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port needs a port number");
    return serve(home, port);
  }
  throw new Error(USAGE);
}

/**
 * Starts lyricad. As a service it starts locked (or unlocked, with a saved
 * passphrase); run by hand in a terminal, it asks for the passphrase instead.
 */
async function serve(home: string, port: number): Promise<void> {
  const daemon = new Lyricad({ home, port });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  // A promise nothing waited on failed, such as a model call whose machine went away: one thread's
  // failure, never a reason to take every user's threads down. Logged like a 500, never with text.
  process.on("unhandledRejection", (err) => console.error(`unhandled rejection: ${(err as Error)?.name ?? typeof err}: ${String((err as Error)?.message ?? "").split("\n")[0]}`));
  await daemon.start();
  for (let tries = 0; daemon.locked && !daemon.settingUp && process.stdin.isTTY && tries < 3; tries++) {
    try {
      await daemon.unlock(await ask("self.db passphrase: ", true));
    } catch (err) {
      console.error((err as Error).message);
    }
  }
}

async function admin(args: string[], home: string): Promise<void> {
  const keyring = new Keyring(home);
  const users = new Users(keyring);
  const [sub, action, login, opt] = args;

  if (sub === "init") {
    if (keyring.selfExists()) throw new Error(`${keyring.selfPath} already exists`);
    const passphrase = await askNew("New self.db passphrase: ");
    const name = await ask("Her name [Lyrica]: ") || "Lyrica";
    const first = await ask("First administrator's login name [li]: ") || "li";
    const profile = await askProfile({ displayName: "Li" });
    const password = await askNew(`Password for ${first}: `);
    await bootstrap(keyring, { passphrase, name, seed: SEED, admin: { login: first, password, profile } });
    console.log(`Created ${keyring.selfPath}, imported the persona and added ${first}. If lyricad is running, restart it.`);
    return;
  }
  if (sub === "setup-code") return setupCode(home);
  if (sub !== "user" && sub !== "grants" && sub !== "ssh" && sub !== "proxmox" && sub !== "net" && sub !== "models") throw new Error(USAGE);

  await keyring.unlockSelf(await ask("self.db passphrase: ", true));
  if (sub === "grants" || sub === "ssh" || sub === "proxmox" || sub === "net") return workspaceAdmin(users, keyring, sub, args.slice(1));
  if (sub === "models") return modelsAdmin(keyring, users, args.slice(1), ask);
  if (action === "list") {
    for (const u of users.all()) {
      console.log(`${u.login}: ${u.profile.displayName} (${pronounLabel(u.profile.pronouns)})${u.admin ? ", administrator" : ""}`);
    }
  } else if (action === "add" && login) {
    const profile = await askProfile({ displayName: login });
    await users.createUser(login, await askNew(`Password for ${login}: `), profile, { admin: opt === "--admin" });
    console.log(`Added ${login}.`);
  } else if (action === "set-admin" && login && (opt === "on" || opt === "off")) {
    const actor = await signIn(users, "Administrator login: ");
    users.setAdmin(actor, need(users, login), opt === "on");
    console.log(`${login} is ${opt === "on" ? "now" : "no longer"} an administrator.`);
  } else if (action === "passwd" && login) {
    const user = need(users, login);
    await users.changePassword(user, await ask(`Current password for ${login}: `, true), await askNew("New password: "));
    console.log("Password changed.");
  } else if (action === "profile" && login) {
    const target = need(users, login);
    const actor = await signIn(users, `Your login (${login} or an administrator): `);
    const change = await askProfile(target.profile);
    const profile = users.updateProfile(actor, target, change);
    console.log(`${login} is now ${profile.displayName} (${pronounLabel(profile.pronouns)}).`);
  } else {
    throw new Error(USAGE);
  }
}

/** Grants and SSH targets live in the user's own user.db, so their password opens it. */
/**
 * Allowed folders live in self.db and only an administrator changes them.
 * Network defaults and SSH targets live in the user's own user.db, so their
 * password opens it.
 */
async function workspaceAdmin(users: Users, keyring: Keyring, kind: "grants" | "ssh" | "proxmox" | "net", args: string[]): Promise<void> {
  const take = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const [value] = args.splice(i, 2).slice(1);
    if (!value) throw new Error(`${name} needs a value`);
    return value;
  };
  const login = take("--user");
  const pool = take("--pool");
  const root = take("--root");
  const limit = take("--limit");
  const [action, ...rest] = args;
  if (!login) throw new Error(USAGE);
  const target = need(users, login);
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  const isPool = (p: string | undefined): p is Pool => p === "general" || p === "private";

  if (kind === "grants") {
    if (action === "list") {
      const allowed = workspace.allowedPaths.list(target.id);
      for (const p of ["general", "private"] as const) console.log(`${p}: ${allowed[p].join(", ") || "(none)"}`);
    } else if ((action === "add" || action === "remove") && isPool(pool) && rest.length === 1) {
      const actor = await signIn(users, "Administrator login: ");
      if (action === "add") workspace.allowedPaths.allow(actor, target.id, pool, rest[0]!);
      else workspace.allowedPaths.disallow(actor, target.id, pool, rest[0]!);
      console.log(`${action === "add" ? "Added" : "Removed"} ${rest[0]} ${action === "add" ? "to" : "from"} ${login}'s ${pool} folders.`);
    } else {
      throw new Error(USAGE);
    }
    return;
  }

  await users.authenticate(login, await ask(`Password for ${login} (to open their settings): `, true));
  const settings = workspace.settings(target.id);
  if (kind === "net" && action === "show") {
    for (const p of ["general", "private"] as const) {
      const n = settings.defaultNetwork(p);
      console.log(`${p}: internet ${n.internet ? "on" : "off"}, local services ${n.services ? "on" : "off"}, hosts: ${n.hosts.join(", ") || "(none)"}`);
    }
  } else if (kind === "net" && action === "set" && isPool(pool) && (rest[0] === "internet" || rest[0] === "services") && (rest[1] === "on" || rest[1] === "off")) {
    settings.setDefaultNetwork(pool, { [rest[0]]: rest[1] === "on" });
    console.log(`${login}'s ${pool} threads: ${rest[0]} ${rest[1]} by default.`);
  } else if (kind === "net" && action === "hosts" && isPool(pool) && (rest[0] === "add" || rest[0] === "remove") && rest[1]) {
    const hosts = settings.defaultNetwork(pool).hosts;
    const entry = parseHost(rest[1]).entry;
    if (rest[0] === "remove" && !hosts.includes(entry)) throw new Error(`${entry} is not in the ${pool} hosts`);
    settings.setDefaultNetwork(pool, { hosts: rest[0] === "add" ? [...new Set([...hosts, entry])] : hosts.filter((h) => h !== entry) });
    console.log(`${rest[0] === "add" ? "Added" : "Removed"} ${entry} ${rest[0] === "add" ? "to" : "from"} ${login}'s ${pool} hosts.`);
  } else if (kind === "ssh" && action === "list") {
    for (const m of settings.machines()) {
      const where = m.kind === "proxmox" ? `Proxmox ${proxmoxAddress(m.host, m.port)}, token ${m.username}` : `${m.username}@${m.host}:${m.port}${m.root ? ` in ${m.root}` : ""}`;
      console.log(`${m.name}: ${where}, ${m.pool}, up to ${m.limit}${m.hostKey ? `, ${m.kind === "proxmox" ? "certificate" : "host key"} ${m.hostKey}` : ", host key not confirmed"}${m.offNetwork ? ", off network" : ""}`);
    }
  } else if (kind === "ssh" && action === "add" && rest.length === 2) {
    const [name, address] = rest as [string, string];
    const machinePool = pool ?? "general";
    if (!isPool(machinePool)) throw new Error(USAGE);
    if (limit !== undefined && !MACHINE_LIMITS.includes(limit as MachineLimit)) throw new Error("--limit is ask, acceptEdits or auto");
    let probe = await workspace.probeMachine(target.id, login, { name, address });
    console.log(`Run this on the machine as root:\n\n${probe.setup}\n`);
    await ask("Press Enter when it's done. ");
    probe = await workspace.probeMachine(target.id, login, { name, address, draft: probe.draft });
    if (!probe.fingerprint) throw new Error(`couldn't reach ${address}: ${probe.problem ?? "no answer"}`);
    console.log(`The machine's host key: ${probe.fingerprint}`);
    console.log(probe.login ? "Her key was accepted." : `Her key wasn't accepted (${probe.problem ?? "refused"}); it will be once the setup is done.`);
    if ((await ask("Is that the fingerprint the machine prints? (yes/no) ")).trim().toLowerCase() !== "yes") throw new Error("not added: the fingerprint wasn't confirmed");
    if (probe.offNetwork && machinePool === "private"
      && (await ask("It resolves outside your network: what she reads and writes there, and the thread's private memory, can leave it. Add anyway? (yes/no) ")).trim().toLowerCase() !== "yes") {
      throw new Error("not added");
    }
    await workspace.addMachine(target.id, {
      name, address, root: root ?? null, pool: machinePool, limit: limit as MachineLimit | undefined, draft: probe.draft, hostKey: probe.fingerprint, offNetworkConfirmed: true,
    });
    console.log(`Added ${name} (${machinePool}, up to ${limit ?? "ask"}).`);
  } else if (kind === "proxmox" && action === "add" && rest.length === 2) {
    const [name, address] = rest as [string, string];
    const machinePool = pool ?? "general";
    if (!isPool(machinePool)) throw new Error(USAGE);
    if (limit !== undefined && !MACHINE_LIMITS.includes(limit as MachineLimit)) throw new Error("--limit is ask, acceptEdits or auto");
    const probe = await workspace.probeMachine(target.id, login, { kind: "proxmox", name, address });
    console.log(`Run this on the Proxmox node as root, for each VM she may manage:\n\n${probe.setup}\n`);
    if (!probe.fingerprint) throw new Error(`couldn't reach ${address}: ${probe.problem ?? "no answer"}`);
    console.log(`Its certificate's fingerprint: ${probe.fingerprint}`);
    if ((await ask("Is that the fingerprint the node prints? (yes/no) ")).trim().toLowerCase() !== "yes") throw new Error("not added: the fingerprint wasn't confirmed");
    const token = await ask("The token, as lyrica@pve!agent=<secret>: ", true);
    if (probe.offNetwork && machinePool === "private"
      && (await ask("It resolves outside your network: what she reads there, and the thread's private memory, can leave it. Add anyway? (yes/no) ")).trim().toLowerCase() !== "yes") {
      throw new Error("not added");
    }
    await workspace.addMachine(target.id, {
      kind: "proxmox", name, address, token, root: null, pool: machinePool, limit: limit as MachineLimit | undefined, hostKey: probe.fingerprint, offNetworkConfirmed: true,
    });
    console.log(`Added ${name} (${machinePool}, up to ${limit ?? "ask"}).`);
  } else if (kind === "ssh" && action === "remove" && rest.length === 1) {
    workspace.removeMachine(target.id, rest[0]!);
    console.log(`Removed ${rest[0]}.`);
  } else {
    throw new Error(USAGE);
  }
  keyring.lockUser(target.id);
}

/** The setup page's code, where to open it, and the Direct certificate's fingerprint to compare. */
function setupCode(home: string): void {
  if (existsSync(join(home, "self.db"))) {
    console.log("Lyrica is set up already.");
    return;
  }
  let code: string;
  try {
    code = readFileSync(join(home, "setup-code"), "utf8").trim();
  } catch {
    throw new Error("no setup code yet: is lyricad running? (systemctl status lyricad)");
  }
  console.log(`Setup code: ${code}`);
  try {
    const dir = JSON.parse(readFileSync(join(home, "web-external.json"), "utf8")) as { direct?: boolean; addresses?: string[]; port?: number; tls?: { cert?: string } };
    if (dir.direct && dir.tls?.cert) {
      for (const a of dir.addresses ?? []) console.log(`Open:       https://${a}:${dir.port}`);
      console.log(`Certificate fingerprint (SHA-256), to compare with the browser's warning:\n  ${new X509Certificate(dir.tls.cert).fingerprint256}`);
      return;
    }
  } catch { /* no Direct listener */ }
  console.log("Open:       http://127.0.0.1:7340 on this machine (no Direct listener: web access was set before)");
}

async function dev(args: string[]): Promise<void> {
  const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

  const initDir = value("--init");
  if (initDir) {
    if (existsSync(initDir) && readdirSync(initDir).length) throw new Error(`${initDir} is not empty`);
    const keyring = new Keyring(initDir);
    await keyring.initSelf(await askNew("Passphrase for the development self.db: "));
    writeFileSync(join(initDir, DEV_MARKER), "Development runtime for lyrica dev. Test users only, never real data.\n");
    new PersonaStore(keyring.self()).importSeed(SEED);
    await new Users(keyring).createUser("tester", await askNew("Password for test administrator 'tester': "),
      { displayName: "Tester", pronouns: PRONOUN_PRESETS.they }, { admin: true });
    console.log(`Created a development runtime in ${initDir} with test administrator 'tester'.`);
    return;
  }

  const runtime = value("--runtime");
  const login = value("--user");
  if (!runtime || !login) throw new Error(USAGE);
  if (!existsSync(join(runtime, DEV_MARKER))) {
    throw new Error(`${runtime} is not a development runtime (no ${DEV_MARKER}); create one with lyrica dev --init`);
  }

  const keyring = new Keyring(runtime);
  await keyring.unlockSelf(await ask("Development self.db passphrase: ", true));
  const users = new Users(keyring);
  const user = await users.authenticate(login, await ask(`Password for ${login}: `, true));
  const pool: Pool = args.includes("--private") ? "private" : "general";
  const bench = await openBench(keyring, users, user, {
    pool, localOnly: args.includes("--local-only"), debugPrompt: args.includes("--debug-prompt"),
  });
  for (const line of bench.report) console.error(line);
  // Pi's TUI on the bench's own session: its runtime comes from the router, and
  // it never checks for updates or model catalogs over the network.
  process.env.PI_OFFLINE = "1";
  const { session, runtime: modelRuntime } = bench;
  const services = {
    cwd: session.sessionManager.getCwd(), agentDir: join(runtime, "bench"), modelRuntime,
    settingsManager: session.settingsManager, resourceLoader: session.resourceLoader, diagnostics: [],
  };
  const host = new AgentSessionRuntime(session, services, async () => {
    throw new Error("lyrica dev runs one thread; restart it for a new one");
  });
  try {
    await new InteractiveMode(host, {}).run();
  } finally {
    await bench.close();
    keyring.lockUser(user.id);
  }
}

function need(users: Users, login: string): User {
  const user = users.find(login);
  if (!user) throw new Error(`no such user: ${login}`);
  return user;
}

async function signIn(users: Users, question: string): Promise<User> {
  const login = await ask(question);
  return users.authenticate(login, await ask(`Password for ${login}: `, true));
}

async function askProfile(current: { displayName: string; pronouns?: Pronouns }): Promise<Omit<Profile, "previousNames">> {
  const displayName = (await ask(`Display name [${current.displayName}]: `)) || current.displayName;
  const presets = Object.keys(PRONOUN_PRESETS).join(", ");
  const fallback = current.pronouns ? pronounLabel(current.pronouns) : undefined;
  const choice = (await ask(`Pronouns (${presets} or custom)${fallback ? ` [${fallback}]` : ""}: `)).trim().toLowerCase();
  if (!choice && current.pronouns) return { displayName, pronouns: current.pronouns };
  if (choice in PRONOUN_PRESETS) return { displayName, pronouns: PRONOUN_PRESETS[choice as keyof typeof PRONOUN_PRESETS] };
  if (choice !== "custom") throw new Error(`choose one of ${presets} or custom`);
  const pronouns: Pronouns = {
    subj: await ask("Subject (they): "),
    obj: await ask("Object (them): "),
    poss: await ask("Possessive (their): "),
    possPro: await ask("Possessive pronoun (theirs): "),
    refl: await ask("Reflexive (themself): "),
  };
  return { displayName, pronouns };
}

/** Reads one line from the terminal; hidden input isn't echoed. */
async function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("lyrica reads passwords only at a terminal prompt");
  process.stderr.write(question);
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(hidden ? buf : buf.trim());
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") {
          if (buf && !hidden) process.stderr.write("\b \b");
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
          if (!hidden) process.stderr.write(ch);
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function askNew(question: string): Promise<string> {
  const first = await ask(question, true);
  if (!first) throw new Error("must not be empty");
  if ((await ask("Again: ", true)) !== first) throw new Error("the two entries differ");
  return first;
}

run(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
