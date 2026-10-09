import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as pi } from "@earendil-works/pi-coding-agent";
import {
  generateSshKey, Keyring, parseHost, PersonaStore, PRONOUN_PRESETS, pronounLabel, Users, Workspace,
  type Pool, type Profile, type Pronouns, type User,
} from "@lyrica/core";
import { benchExtensions } from "./bench.ts";

const USAGE = `usage:
  lyrica admin init
  lyrica admin user add <login> [--admin]
  lyrica admin user list
  lyrica admin user set-admin <login> on|off
  lyrica admin user passwd <login>
  lyrica admin user profile <login>
  lyrica admin grants add|remove --user <login> --pool general|private <path>
  lyrica admin grants list --user <login>
  lyrica admin ssh add --user <login> <name> <account>@<host>[:<port>] [--root <path>]
  lyrica admin ssh list|remove --user <login> [<name>]
  lyrica admin net show --user <login>
  lyrica admin net set --user <login> --pool general|private internet|services on|off
  lyrica admin net hosts add|remove --user <login> --pool general|private <host>
  lyrica dev --init <dir>
  lyrica dev --runtime <dir> --user <login> [--debug-prompt] [-- <pi args>]
  lyrica serve | chat | mem      (not built yet)

admin commands use --runtime <dir>, else LYRICA_HOME, else ./runtime.
Passwords are only read at a hidden prompt.`;

const SEED = fileURLToPath(new URL("../persona", import.meta.url));
const DEV_MARKER = "LYRICA_DEVELOPMENT_RUNTIME";
const STUBS: Record<string, string> = {
  serve: "lyrica serve starts lyricad, which the Web thread builds.",
  chat: "lyrica chat is a client of lyricad, which the Web thread builds.",
  mem: "lyrica mem is a client of lyricad, which the Web thread builds.",
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
  throw new Error(USAGE);
}

async function admin(args: string[], home: string): Promise<void> {
  const keyring = new Keyring(home);
  const users = new Users(keyring);
  const [sub, action, login, opt] = args;

  if (sub === "init") {
    if (keyring.selfExists()) throw new Error(`${keyring.selfPath} already exists`);
    const passphrase = await askNew("New self.db passphrase: ");
    const first = await ask("First administrator's login name [li]: ") || "li";
    const profile = await askProfile({ displayName: "Li" });
    const password = await askNew(`Password for ${first}: `);
    await keyring.initSelf(passphrase);
    new PersonaStore(keyring.self()).importSeed(SEED);
    await users.createUser(first, password, profile, { admin: true });
    console.log(`Created ${keyring.selfPath}, imported the persona and added ${first}.`);
    return;
  }
  if (sub !== "user" && sub !== "grants" && sub !== "ssh" && sub !== "net") throw new Error(USAGE);

  await keyring.unlockSelf(await ask("self.db passphrase: ", true));
  if (sub === "grants" || sub === "ssh" || sub === "net") return workspaceAdmin(users, keyring, sub, args.slice(1));
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
async function workspaceAdmin(users: Users, keyring: Keyring, kind: "grants" | "ssh" | "net", args: string[]): Promise<void> {
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
  const [action, ...rest] = args;
  if (!login) throw new Error(USAGE);
  const target = need(users, login);
  const workspace = new Workspace(keyring, users);
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
      console.log(`${p}: internet ${n.internet ? "on" : "off"}, machine's services ${n.services ? "on" : "off"}, hosts: ${n.hosts.join(", ") || "(none)"}`);
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
    for (const t of settings.sshTargets()) {
      console.log(`${t.name}: ${t.username}@${t.host}:${t.port}${t.root ? ` in ${t.root}` : ""}${t.hostKey ? ` (host key ${t.hostKey})` : " (host key not seen yet)"}`);
    }
  } else if (kind === "ssh" && action === "add" && rest.length === 2) {
    const [name, address] = rest as [string, string];
    const m = /^([^@\s]+)@([^:\s]+)(?::(\d+))?$/.exec(address);
    if (!m) throw new Error("the address looks like account@host or account@host:port");
    const key = generateSshKey(`lyrica:${login}:${name}`);
    settings.addSsh({ name, username: m[1]!, host: m[2]!, port: Number(m[3] ?? 22), privateKey: key.privateKey, root: root ?? null });
    console.log(`Added ${name}. Add this key to ~${m[1]}/.ssh/authorized_keys on ${m[2]}:\n${key.publicKey}`);
  } else if (kind === "ssh" && action === "remove" && rest.length === 1) {
    settings.removeSsh(rest[0]!);
    console.log(`Removed ${rest[0]}.`);
  } else {
    throw new Error(USAGE);
  }
  keyring.lockUser(target.id);
}

async function dev(args: string[]): Promise<void> {
  const split = args.indexOf("--");
  const own = split < 0 ? args : args.slice(0, split);
  const piArgs = split < 0 ? [] : args.slice(split + 1);
  const value = (name: string) => (own.includes(name) ? own[own.indexOf(name) + 1] : undefined);

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
  const bench = await benchExtensions(keyring, users, user, { debugPrompt: own.includes("--debug-prompt") });
  try {
    await pi(
      ["--no-session", "--no-context-files", "--no-builtin-tools", "--no-skills",
       "--no-prompt-templates", "--no-extensions", "--no-mcp", ...piArgs],
      { extensionFactories: bench.factories },
    );
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
