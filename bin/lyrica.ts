import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main as pi } from "@earendil-works/pi-coding-agent";
import { Keyring, PersonaStore, Users, type User } from "@lyrica/core";
import { createLyricaExtension } from "@lyrica/extension";

const USAGE = `usage:
  lyrica admin init
  lyrica admin user add <name> [--admin]
  lyrica admin user list
  lyrica admin user set-admin <name> on|off
  lyrica admin user passwd <name>
  lyrica dev --user <name> [--debug] [-- <pi args>]

LYRICA_HOME sets the data directory (default ./runtime).`;

const SEED = fileURLToPath(new URL("../persona", import.meta.url));
const home = process.env.LYRICA_HOME ?? "runtime";

async function run(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  const keyring = new Keyring(home);
  const users = new Users(keyring);

  if (cmd === "admin" && sub === "init") {
    if (keyring.selfExists()) throw new Error(`${keyring.selfPath} already exists`);
    const passphrase = await askNew("New self.db passphrase: ");
    const name = await ask("First administrator's name: ");
    const password = await askNew(`Password for ${name}: `);
    await keyring.initSelf(passphrase);
    new PersonaStore(keyring.self()).importSeed(SEED);
    await users.createUser(name, password, { admin: true });
    console.log(`Created ${keyring.selfPath}, imported the persona and added ${name}.`);
    return;
  }

  if (cmd === "admin" && sub === "user") {
    const [action, name, flag] = rest;
    await keyring.unlockSelf(await ask("self.db passphrase: ", true));
    if (action === "list") {
      for (const u of users.all()) console.log(`${u.name}${u.admin ? " (administrator)" : ""}`);
    } else if (action === "add" && name) {
      await users.createUser(name, await askNew(`Password for ${name}: `), { admin: flag === "--admin" });
      console.log(`Added ${name}.`);
    } else if (action === "set-admin" && name && (flag === "on" || flag === "off")) {
      const actor = await login("Administrator name: ");
      users.setAdmin(actor, need(users, name), flag === "on");
      console.log(`${name} is ${flag === "on" ? "now" : "no longer"} an administrator.`);
    } else if (action === "passwd" && name) {
      const user = need(users, name);
      await users.changePassword(user, await ask(`Current password for ${name}: `, true), await askNew("New password: "));
      console.log("Password changed.");
    } else {
      throw new Error(USAGE);
    }
    return;

    async function login(question: string): Promise<User> {
      const actor = await ask(question);
      return users.authenticate(actor, await ask(`Password for ${actor}: `, true));
    }
  }

  if (cmd === "dev") {
    const args = [sub, ...rest].filter((a): a is string => a !== undefined);
    const split = args.indexOf("--");
    const own = split < 0 ? args : args.slice(0, split);
    const piArgs = split < 0 ? [] : args.slice(split + 1);
    const name = own[own.indexOf("--user") + 1];
    if (!own.includes("--user") || !name) throw new Error(USAGE);
    // Pi reads piped stdin itself, after our prompts have consumed it.
    if (!process.stdin.isTTY) throw new Error("lyrica dev needs a terminal");

    await keyring.unlockSelf(await ask("self.db passphrase: ", true));
    const user = await users.authenticate(name, await ask(`Password for ${name}: `, true));
    const persona = new PersonaStore(keyring.self());

    const extension = createLyricaExtension(
      {
        user,
        pool: "general",
        interface: "cli",
        threadId: `cli:${randomUUID()}`,
        view: { pool: "general" }, // the Memory thread replaces this with openThreadView
        call: { userId: user.id, pool: "general", localOnly: false },
      },
      { persona: () => persona.read(), displayName: users.displayName(user), debug: own.includes("--debug") },
    );
    try {
      await pi(
        ["--no-session", "--no-context-files", "--no-builtin-tools", "--no-skills",
         "--no-prompt-templates", "--no-extensions", "--no-mcp", ...piArgs],
        { extensionFactories: [{ name: "lyrica", factory: extension }] },
      );
    } finally {
      keyring.lockUser(user.id);
    }
    return;
  }

  throw new Error(USAGE);
}

function need(users: Users, name: string): User {
  const user = users.find(name);
  if (!user) throw new Error(`no such user: ${name}`);
  return user;
}

// Prompts. On a terminal, hidden input is read in raw mode; otherwise lines come from stdin.

let piped: AsyncIterator<string> | undefined;

async function ask(question: string, hidden = false): Promise<string> {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    piped ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const next = await piped.next();
    process.stderr.write("\n");
    if (next.done) throw new Error("unexpected end of input");
    return next.value;
  }
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
          return resolve(buf);
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
  if (process.stdin.isTTY && (await ask("Again: ", true)) !== first) throw new Error("the two entries differ");
  return first;
}

run(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
