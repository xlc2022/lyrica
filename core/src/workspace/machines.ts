// What applies to a machine whatever the modes: the suspect commands that
// always ask, the paths write and edit never touch, and what her command
// output loses on the way back. The boundary is the account's own rights and
// the root-owned keys file; these are a warning layer on top.

import { networkInterfaces } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { posix } from "node:path";
import { removePrivateKeys, PRIVATE_KEY_BEGIN as BEGIN, PRIVATE_KEY_END as END } from "../secrets.ts";
import { within } from "./settings.ts";

export interface SuspectCommand {
  /** What it does, in the permission card's warning sentence. */
  warning: string;
  /** Matches one simple command's words, its program name first. */
  test(words: string[]): boolean;
}

const TOP_FOLDERS = "bin|boot|dev|etc|home|lib|lib32|lib64|opt|proc|root|run|sbin|srv|sys|usr|var";
/** `/`, `/*`, a home folder or a top-level system folder, with or without a trailing `/` or `/*`. */
const SWEEPING = new RegExp(`^(?:/|~|\\$HOME|\\$\\{HOME\\}|/home/[^/]+|/(?:${TOP_FOLDERS}))/?\\*?$`);
const flags = (words: string[]) => words.slice(1).filter((w) => w.startsWith("-"));
const args = (words: string[]) => words.slice(1).filter((w) => !w.startsWith("-"));

/** Commands almost never right on a machine. A short, fixed list: never grown one scare at a time. */
export const SUSPECT_COMMANDS: readonly SuspectCommand[] = [
  { warning: "This deletes everything, a home folder or a system folder.", test: (w) => w[0] === "rm" && args(w).some((a) => SWEEPING.test(a)) },
  { warning: "This formats a disk, erasing what's on it.", test: (w) => /^mkfs(\..+)?$|^mke2fs$/.test(w[0]!) },
  { warning: "This writes straight onto a device, overwriting what's on it.", test: (w) => w[0] === "dd" && w.some((a) => a.startsWith("of=/dev/")) },
  {
    warning: "This changes permissions or owners across the whole system.",
    test: (w) => (w[0] === "chmod" || w[0] === "chown" || w[0] === "chgrp") && flags(w).some((f) => /^-[a-zA-Z]*R|^--recursive$/.test(f))
      && args(w).some((a) => /^\/+\*?$/.test(a)),
  },
  { warning: "This deletes an account.", test: (w) => w[0] === "userdel" || w[0] === "deluser" },
  {
    warning: "This shuts the machine down or restarts it.",
    test: (w) => ["shutdown", "reboot", "poweroff", "halt"].includes(w[0]!) || (w[0] === "systemctl" && w.some((a) => ["reboot", "poweroff", "halt", "kexec"].includes(a)))
      || (w[0] === "init" && (w[1] === "0" || w[1] === "6")),
  },
  { warning: "This destroys a virtual machine or container and its disks.", test: (w) => (w[0] === "qm" || w[0] === "pct") && w[1] === "destroy" },
];

/** Words that only run what follows them. */
const PREFIXES = new Set(["sudo", "doas", "env", "nohup", "exec", "command", "time", "nice", "ionice", "builtin", "timeout", "xargs", "stdbuf", "chroot"]);
/** Their flags that take the next word as a value (`sudo -u root`, `nice -n 5`, `timeout -s KILL`). */
const VALUE_FLAGS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-U"], doas: ["-u", "-C"], nice: ["-n"], ionice: ["-c", "-n", "-p"], timeout: ["-s", "-k"],
  xargs: ["-I", "-P", "-L", "-d", "-n", "-s", "-a"], env: ["-u", "-C", "-S"],
};
/** Shells whose `-c` argument is a command line; rules.ts shares this list. */
export const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

/** A command line's simple commands, each as words with quotes removed and the program's path dropped. */
export function simpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quote = "";
  const flushWord = () => { if (word) { words.push(word.replace(/["']/g, "")); word = ""; } };
  const flush = () => {
    flushWord();
    if (!words.length) return;
    const current = words; words = [];
    current[0] = posix.basename(current[0]!);
    commands.push(current);
    const shell = current.findIndex(w => SHELLS.has(posix.basename(w)));
    const c = current.indexOf("-c", shell + 1);
    if (shell >= 0 && c > shell && current[c + 1]) commands.push(...simpleCommands(current[c + 1]!));
    for (let i = 0; i < current.length; i++) if (["-exec", "-execdir", "-ok"].includes(current[i]!)) {
      const nested = current.slice(i + 1);
      if (nested.length) commands.push(nested);
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") { if (command[i + 1]) word += command[++i]; continue; }
    if (ch === "'" || ch === '"') {
      if (!quote) { quote = ch; continue; }
      if (quote === ch) { quote = ""; continue; }
    }
    // Substitutions execute even inside double quotes. Keep their commands separately.
    if (quote !== "'" && (ch === "`" || (ch === "$" && command[i + 1] === "("))) {
      const start = i + (ch === "`" ? 1 : 2);
      let end = start, depth = 1;
      for (; end < command.length; end++) {
        if (ch === "`" && command[end] === "`") break;
        if (ch !== "`") { if (command[end] === "(") depth++; if (command[end] === ")" && --depth === 0) break; }
      }
      commands.push(...simpleCommands(command.slice(start, end)));
      word += "$substitution"; i = end; continue;
    }
    if (!quote && /[;&|\n(){}]/.test(ch)) { flush(); continue; }
    if (!quote && /\s/.test(ch)) { flushWord(); continue; }
    word += ch;
  }
  flush();
  return commands;
}

/** The warning for a suspect command, or undefined. */
export function suspectCommand(command: string): string | undefined {
  for (const parsed of simpleCommands(command)) {
    const words = [...parsed];
    let wrapper = "";
    while (words.length) {
      const w = words[0]!;
      if (PREFIXES.has(posix.basename(w))) { wrapper = posix.basename(w); words.shift(); continue; }
      if (w.startsWith("-")) { words.shift(); if (VALUE_FLAGS[wrapper]?.includes(w)) words.shift(); continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (wrapper === "timeout" && /^\d/.test(w))) { words.shift(); continue; }
      break;
    }
    if (!words.length) continue;
    words[0] = posix.basename(words[0]!);
    const hit = SUSPECT_COMMANDS.find((s) => s.test(words));
    if (hit) return hit.warning;
  }
  return undefined;
}

/**
 * The files a command plainly writes before it runs: the targets of its `>`
 * and `>>` redirections and of `tee`. A name made from a variable or a
 * substitution, or under /dev, isn't known, so it isn't listed; nor is a
 * relative name after a `cd` or `pushd`, which moves where it points.
 */
export function writtenFiles(command: string): string[] {
  const out: string[] = [];
  let moved = false;
  const add = (w: string | undefined) => { if (w && !w.includes("$") && !/\s/.test(w) && !w.startsWith("/dev/") && (!moved || w.startsWith("/"))) out.push(w); };
  for (const words of simpleCommands(command)) {
    if (words[0] === "cd" || words[0] === "pushd") { moved = true; continue; }
    for (let i = 0; i < words.length; i++) {
      const m = /^(?:\d*|&)>>?(.*)$/.exec(words[i]!);
      if (m && !m[1]!.startsWith("&")) add(m[1] || words[++i]);
    }
    const tee = words.indexOf("tee");
    if (tee >= 0) for (const w of words.slice(tee + 1)) { if (/^(?:\d*|&)?[<>]/.test(w)) break; if (!w.startsWith("-")) add(w); }
  }
  return [...new Set(out)];
}

/** Where write and edit never go on a machine, in any mode: SSH's keys and config, and sudo's rules. */
export function onFloor(path: string): boolean {
  return path.split("/").includes(".ssh") || within(path, "/etc/ssh") || path.startsWith("/etc/sudoers");
}

export const KEY_REMOVED = "[private key removed]";

/** A file's contents with any private-key block replaced. Bytes are kept as they are otherwise. */
export function maskKeys(content: Buffer): Buffer {
  const s = content.toString("latin1");
  return /PRIVATE KEY(?: BLOCK)?-----/.test(s) ? Buffer.from(removePrivateKeys(s, KEY_REMOVED), "latin1") : content;
}

// Terminal control: CSI and OSC sequences, other escapes, and control characters but tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
/** A line longer than this is passed on without waiting for its end. */
const LONG_LINE = 8 * 1024;

/**
 * Command output from a machine, cleaned line by line before it is passed
 * on: terminal control sequences stripped, and private-key blocks replaced
 * with a marker. A partial line waits for its end, unless it gets long.
 */
export function cleanOutput(onData: (data: Buffer) => void): { push(data: Buffer): void; end(): void } {
  let partial = "";
  let inKey = false;
  // Keeps a character split across chunks whole (Chinese output, say).
  const decoder = new StringDecoder("utf8");
  /** The line as passed on, or undefined when it is dropped (inside a key). */
  const line = (l: string): string | undefined => {
    const clean = l.replace(CONTROL, "");
    if (inKey) {
      if (END.test(clean)) inKey = false;
      return undefined;
    }
    const begin = BEGIN.exec(clean);
    if (!begin) return clean;
    inKey = !END.test(clean.slice(begin.index));
    return `${clean.slice(0, begin.index)}${KEY_REMOVED}`;
  };
  const emit = (lines: string[], last: boolean) => {
    const out = lines.map((l, i) => {
      const cleaned = line(l);
      return cleaned === undefined ? "" : cleaned + (!last || i < lines.length - 1 ? "\n" : "");
    }).join("");
    if (out) onData(Buffer.from(out));
  };
  return {
    push(data) {
      const lines = (partial + decoder.write(data)).split("\n");
      partial = lines.pop()!;
      if (partial.length > LONG_LINE) {
        // Pass a long line on, but hold back from its last "-----", where a key's header may be starting.
        const cut = partial.lastIndexOf("-----");
        const at = cut <= 0 || partial.length > 4 * LONG_LINE ? partial.length : cut;
        lines.push(partial.slice(0, at));
        partial = partial.slice(at);
        emit(lines, true);
        return;
      }
      if (lines.length) emit(lines, false);
    },
    end() {
      partial += decoder.end();
      if (partial) emit([partial], true);
      partial = "";
    },
  };
}

/** This computer's own addresses, as a machine sees Lyrica connect from them. */
export function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a!.address.replace(/%.*$/, ""));
}

/** The authorized_keys line for a machine: usable only from Lyrica's addresses, with no forwarding, agent or pty. */
export function authorizedKeysLine(publicKey: string, from: string[] = ownAddresses()): string {
  return `restrict${from.length ? `,from="${from.join(",")}"` : ""} ${publicKey}`;
}

/**
 * The two steps that make a machine ready, to run as root there: the key in
 * a root-owned file sshd reads for her account, so nothing she runs can add
 * one, and sudo rights that are exact commands, never a password. On the
 * user's own account (`asUser`) there is nothing to protect from her, so the
 * user adds the key to their own keys file, without root.
 */
export function machineSetup(account: string, keyLine: string, asUser = false): string {
  const line = keyLine.replaceAll("'", "'\\''");
  const fingerprint = ["", "# The host key's fingerprint, to compare with the one Lyrica shows", "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"];
  if (asUser) {
    return [
      `# Her key, in your own keys file: run as ${account}, not as root`,
      "install -d -m 700 ~/.ssh",
      `printf '%s\\n' '${line}' >> ~/.ssh/authorized_keys`,
      "chmod 600 ~/.ssh/authorized_keys",
      ...fingerprint,
    ].join("\n");
  }
  return [
    "# 1. Her key, in a file only root can change",
    "install -d -m 755 /etc/ssh/authorized_keys",
    `printf '%s\\n' '${line}' > /etc/ssh/authorized_keys/${account}`,
    `chmod 644 /etc/ssh/authorized_keys/${account}`,
    `printf 'Match User ${account}\\n    AuthorizedKeysFile /etc/ssh/authorized_keys/%%u\\n' > /etc/ssh/sshd_config.d/lyrica.conf`,
    "sshd -t && systemctl reload ssh",
    "",
    "# 2. Optional: sudo without a password, for exact commands (visudo -f /etc/sudoers.d/lyrica)",
    `${account} ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx`,
    "#    or, on a machine you really trust, for everything:",
    `# ${account} ALL=(root) NOPASSWD: ALL`,
    ...fingerprint,
  ].join("\n");
}
