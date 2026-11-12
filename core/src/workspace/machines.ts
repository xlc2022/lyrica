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
  /** Asks in the sandbox too, not only on a machine: work she can't undo wherever it runs. */
  everywhere?: true;
  /** Git throwing away uncommitted or untracked work, which is saved first (`discardingGit`). */
  discards?: true;
}

/** Where a suspect command is about to run; the sandbox gets only the `everywhere` rules. */
export type SuspectWhere = "machine" | "sandbox";
/** What Allow in this thread stores as the machine for a sandbox command (no machine's name has a colon). */
export const SANDBOX_ALLOW = ":sandbox";

const TOP_FOLDERS = "bin|boot|dev|etc|home|lib|lib32|lib64|opt|proc|root|run|sbin|srv|sys|usr|var";
/** `/`, `/*`, a home folder or a top-level system folder, with or without a trailing `/` or `/*`. */
const SWEEPING = new RegExp(`^(?:/|~|\\$HOME|\\$\\{HOME\\}|/home/[^/]+|/(?:${TOP_FOLDERS}))/?\\*?$`);
const flags = (words: string[]) => words.slice(1).filter((w) => w.startsWith("-"));
const args = (words: string[]) => words.slice(1).filter((w) => !w.startsWith("-"));
/** A short flag cluster holding the letter (`-rf`, `-fr`, `-Rf`), never a long `--flag`. */
const short = (letter: string) => (w: string) => new RegExp(`^-[a-zA-Z]*${letter}`).test(w);
/** Git's own options that take the next word (`git -C dir push`, `git -c k=v …`). */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** A git command's subcommand and the words after it, past git's own options; undefined for anything but git. */
function gitSub(w: string[]): string[] | undefined {
  if (w[0] !== "git") return undefined;
  let i = 1;
  while (i < w.length && w[i]!.startsWith("-")) i += GIT_VALUE_FLAGS.has(w[i]!) ? 2 : 1;
  return w.slice(i);
}

/**
 * Commands almost never right on a machine, and (`everywhere`) work that can't
 * be undone wherever it runs: a recursive delete, and git throwing away
 * commits or changes. A short, fixed list: never grown one scare at a time.
 */
export const SUSPECT_COMMANDS: readonly SuspectCommand[] = [
  { everywhere: true, warning: "This deletes everything, a home folder or a system folder.", test: (w) => w[0] === "rm" && args(w).some((a) => SWEEPING.test(a)) },
  { everywhere: true, warning: "This deletes a folder and everything in it.", test: (w) => w[0] === "rm" && flags(w).some((f) => short("[rR]")(f) || f === "--recursive") },
  {
    everywhere: true,
    warning: "This rewrites the branch on the remote: commits there that aren't here are lost.",
    test: (w) => { const g = gitSub(w); return g?.[0] === "push" && g.slice(1).some((a) => a.startsWith("--force") || short("f")(a) || a.startsWith("+")); },
  },
  {
    everywhere: true,
    discards: true,
    warning: "This throws away uncommitted changes.",
    test: (w) => {
      const g = gitSub(w);
      if (!g) return false;
      return (g[0] === "reset" && g.includes("--hard"))
        || (g[0] === "checkout" && (g.includes("--") || g.includes("--force") || g.slice(1).some((a) => a === "." || a === "*" || short("f")(a))))
        || (g[0] === "switch" && (g.includes("--discard-changes") || g.includes("--force") || g.slice(1).some(short("f"))))
        || (g[0] === "restore" && g.length > 1 && (!g.includes("--staged") && !g.slice(1).some(short("S")) || g.includes("--worktree") || g.slice(1).some(short("W"))));
    },
  },
  {
    everywhere: true,
    discards: true,
    warning: "This deletes untracked files for good.",
    test: (w) => { const g = gitSub(w); return g?.[0] === "clean" && !g.includes("--dry-run") && !g.slice(1).some(short("n")); },
  },
  {
    everywhere: true,
    warning: "This deletes a branch, or a stash with its changes.",
    test: (w) => {
      const g = gitSub(w);
      if (!g) return false;
      const rest = g.slice(1);
      return (g[0] === "branch" && (rest.some(short("D")) || ((rest.includes("--delete") || rest.some(short("d"))) && (rest.includes("--force") || rest.some(short("f"))))))
        || (g[0] === "push" && (rest.includes("--delete") || rest.some(short("d"))))
        || (g[0] === "stash" && (g[1] === "drop" || g[1] === "clear"));
    },
  },
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

/** Words that only run what follows them, the shell's own keywords among them (`then rm -rf x`). */
const PREFIXES = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "sudo", "doas", "env", "nohup", "exec", "command", "time", "nice", "ionice", "builtin", "timeout", "xargs", "stdbuf", "chroot", "ld.so"]);
/** The dynamic loader run by hand (`ld-linux-x86-64.so.2 --library-path … prog`): a wrapper that runs the program after its options. */
export const LOADER = /^ld(?:64|-[\w.-]+)?\.so(?:\.\d+)*$/;
/** Their flags that take the next word as a value (`sudo -u root`, `nice -n 5`, `timeout -s KILL`). */
const VALUE_FLAGS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-U"], doas: ["-u", "-C"], nice: ["-n"], ionice: ["-c", "-n", "-p"], timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: ["-I", "-P", "-L", "-d", "-n", "-s", "-a"], env: ["-u", "-C", "-S"],
  "ld.so": ["--library-path", "--preload", "--audit", "--argv0", "--inhibit-rpath", "--glibc-hwcaps-prepend", "--glibc-hwcaps-mask"],
};
/** Shells whose `-c` argument is a command line; rules.ts shares this list. */
export const SHELLS = new Set(["sh", "bash", "rbash", "dash", "ash", "zsh", "ksh", "mksh", "oksh", "pdksh", "yash", "posh", "csh", "tcsh", "fish"]);

const assigns = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
/** Words that make a line more than straight-through commands. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "case", "esac", "for", "select", "function", "coproc", "!", "[[", "]]"]);
/** Names bash sets or reads itself, so a value given on the line isn't what a later `$NAME` gives (or changes how words split and programs are found). */
const SPECIAL = /^(?:BASH\w*|UID|EUID|PPID|SHELLOPTS|RANDOM|SRANDOM|SECONDS|LINENO|EPOCH\w*|HISTCMD|FUNCNAME|GROUPS|DIRSTACK|PIPESTATUS|OPT\w*|IFS|PATH|CDPATH|ENV|HOME)$/;

/**
 * A command line's simple commands, each as words with quotes removed and the
 * program's path dropped (after any leading assignments). A `$NAME` or
 * `${NAME}` is replaced with its value when the line plainly sets it first
 * (`L=/path; "$L" --version`), as in {@link knownValues}.
 */
export function simpleCommands(command: string): string[][] {
  const values = knownValues(command);
  const known = new Map<string, string>();
  return parse(command).map((parsed) => {
    let words = parsed;
    if (values.size) {
      words = parsed.map((w) => w.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (ref, a, b) => known.get(a ?? b) ?? ref));
      // An assignment on its own sets the name for what comes after it on the line.
      if (words.every(assigns)) for (const w of words) { const name = w.slice(0, w.indexOf("=")); if (values.has(name)) known.set(name, values.get(name)!); }
    }
    const at = words.findIndex((w) => !assigns(w));
    return at < 0 ? words : words.map((w, i) => (i === at ? posix.basename(w) : w));
  });
}

/**
 * The names a command line sets once to a plain value, each with its value.
 * Only a line read straight through, in one shell, is trusted: one with no
 * pipe, background, `&&` or `||`, subshell, group, substitution, here
 * document, comment, single quote, backslash, shell keyword, nested shell or
 * find `-exec`. The assignment stands unquoted on its own; its value is
 * letters, digits and `_ . / : @ % + , -` only, so it can't split or glob;
 * and the name appears nowhere else on the line but as `$NAME` or
 * `${NAME}`, so nothing else (`read`, `unset`, `for`, a second assignment)
 * can change it. Anything else leaves `$NAME` as it is.
 */
export function knownValues(command: string): Map<string, string> {
  const values = new Map<string, string>();
  const rest = command.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "").replace(/\d*>&\d+|&>>?/g, "");
  if (/[|&(){}`'\\#]|<</.test(rest)) return values;
  const parsed = parse(command);
  if (parsed.some((words) => words.some((w) => KEYWORDS.has(w) || SHELLS.has(posix.basename(w)) || ["-exec", "-execdir", "-ok"].includes(w)))) return values;
  for (const words of parsed) {
    if (!words.every(assigns)) continue;
    for (const w of words) {
      const name = w.slice(0, w.indexOf("=")), value = w.slice(w.indexOf("=") + 1);
      if (SPECIAL.test(name) || !/^[\w./:@%+,-]+$/.test(value)) continue;
      const uses = [...command.matchAll(new RegExp(`(?<![A-Za-z0-9_$]|\\$\\{)${name}(?![A-Za-z0-9_])`, "g"))];
      if (uses.length === 1 && /^\s*$|[\s;]$/.test(command.slice(0, uses[0]!.index)) && command[uses[0]!.index! + name.length] === "=") values.set(name, value);
    }
  }
  return values;
}

/** Programs whose input is plainly not shell: a here-document only they read is data or their own code, not commands. */
const READS_INPUT = /^(?:python[\d.]*|node|perl|ruby|jq|cat|tee)$/;

// An unquoted `{` or `}` inside a word, marked so brace expansion can tell it from a quoted one.
const OPEN = "\u0001", CLOSE = "\u0002";
/** How many words one word's brace expansion may make before the line counts as opaque. */
const BRACE_LIMIT = 256;

/** A `{a..e}` or `{1..9..2}` sequence's words, `undefined` if it isn't one, or `null` if it makes too many. */
function sequence(inner: string): string[] | null | undefined {
  const m = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/.exec(inner);
  if (!m) return undefined;
  const letters = !!m[3];
  const from = letters ? m[3]!.charCodeAt(0) : Number(m[1]), to = letters ? m[4]!.charCodeAt(0) : Number(m[2]);
  const step = Math.abs(Number(m[5] ?? 1)) || 1;
  if (Math.abs(to - from) / step + 1 > BRACE_LIMIT) return null;
  // `{01..10}` pads every number to the wider end, as bash does.
  const width = !letters && [m[1]!, m[2]!].some((e) => /^-?0\d/.test(e)) ? Math.max(m[1]!.length, m[2]!.length) : 0;
  const out: string[] = [];
  for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
    out.push(letters ? String.fromCharCode(n) : (n < 0 ? "-" : "") + String(Math.abs(n)).padStart(width - (n < 0 ? 1 : 0), "0"));
  }
  return out;
}

/** Bash's brace expansion of a word with marked braces (`r{m,}` is `rm r`), into `out`; false if it makes too many words. */
function expand(word: string, out: string[]): boolean {
  for (let open = word.indexOf(OPEN); open >= 0; open = word.indexOf(OPEN, open + 1)) {
    let depth = 0, close = -1;
    const commas: number[] = [];
    for (let i = open; i < word.length; i++) {
      if (word[i] === OPEN) depth++;
      else if (word[i] === CLOSE && --depth === 0) { close = i; break; }
      else if (word[i] === "," && depth === 1) commas.push(i);
    }
    if (close < 0) break;
    const parts = commas.length ? [...commas, close].map((c, k) => word.slice(k ? commas[k - 1]! + 1 : open + 1, c)) : sequence(word.slice(open + 1, close));
    if (parts === null) return false;
    // Not an expansion (`{}`, `{x}`): this brace is just a character.
    if (!parts) continue;
    const head = word.slice(0, open), tail = word.slice(close + 1);
    return parts.every((part) => expand(head + part + tail, out));
  }
  if (out.length >= BRACE_LIMIT) return false;
  out.push(word);
  return true;
}

function parse(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quote = "";
  const heredocs: { word: string; tabs: boolean; quoted: boolean; reader: string[]; piped?: boolean }[] = [];
  const flushWord = () => {
    if (!word) return;
    const out: string[] = [];
    // Too many words to read is an opaque part, which asks while any Forbid rule exists.
    if (!expand(word, out)) { commands.push(["$braces"]); out.splice(0, out.length, word); }
    for (const w of out) { const plain = w.replace(/["']/g, "").replaceAll(OPEN, "{").replaceAll(CLOSE, "}"); if (plain) words.push(plain); }
    word = "";
  };
  const flush = () => {
    flushWord();
    if (!words.length) return;
    const current = words; words = [];
    commands.push(current);
    const shell = current.findIndex(w => SHELLS.has(posix.basename(w)));
    const c = current.indexOf("-c", shell + 1);
    if (shell >= 0 && c > shell && current[c + 1]) commands.push(...parse(current[c + 1]!));
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
      commands.push(...parse(command.slice(start, end)));
      word += "$substitution"; i = end; continue;
    }
    // `${NAME}` is one word, not a group; any other `${…}` splits as before.
    const braced = ch === "$" && quote !== "'" ? /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(command.slice(i)) : null;
    if (braced) { word += braced[0]; i += braced[0].length - 1; continue; }
    // A here-document is the program's input, not commands: its body is skipped, but for the
    // substitutions an unquoted delimiter lets run (as shellcheck.ts's segments reads it).
    if (!quote && ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(command.slice(i));
      if (m) { flushWord(); heredocs.push({ word: m[3]!, tabs: m[1] === "-", quoted: !!m[2], reader: words }); i += m[0].length - 1; continue; }
    }
    if (!quote && ch === "\n" && heredocs.length) {
      flush();
      let at = i + 1;
      for (const h of heredocs.splice(0)) {
        const body = at;
        let end = command.length;
        while (at < command.length) {
          const nl = command.indexOf("\n", at);
          const line = command.slice(at, nl < 0 ? command.length : nl);
          if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.word) { end = at; at = nl < 0 ? command.length : nl + 1; break; }
          at = nl < 0 ? command.length : nl + 1;
          end = at;
        }
        // The body is commands unless its reader is plainly not a shell and nothing later in a pipeline could run it.
        if (h.piped || !READS_INPUT.test(unwrapped(h.reader)[0] ?? "")) commands.push(...parse(command.slice(body, end)));
        else if (!h.quoted) for (const m of command.slice(body, end).matchAll(/\$\(|`/g)) {
          const text = command.slice(body + m.index!);
          let close = m[0].length, depth = 1;
          for (; close < text.length; close++) {
            if (m[0] === "`" && text[close] === "`") break;
            if (m[0] !== "`") { if (text[close] === "(") depth++; if (text[close] === ")" && --depth === 0) break; }
          }
          commands.push(...parse(text.slice(m[0].length, close)));
        }
      }
      i = at - 1; continue;
    }
    // A pipe or process substitution after a here-document could hand its body to a shell.
    if (!quote && (ch === "|" || (ch === "(" && /[<>]$/.test(word)))) for (const h of heredocs) h.piped = true;
    // `{` and `}` group commands only as words of their own; inside a word they are brace expansion, as in `r{m,}`
    // (but `${` starts a parameter, not an expansion).
    if (!quote && ch === "{") { if (!word && (i + 1 >= command.length || /\s/.test(command[i + 1]!))) flush(); else word += word.endsWith("$") ? ch : OPEN; continue; }
    if (!quote && ch === "}") { if (!word) flush(); else word += CLOSE; continue; }
    if (!quote && /[;&|\n()]/.test(ch)) { flush(); continue; }
    if (!quote && /\s/.test(ch)) { flushWord(); continue; }
    word += ch;
  }
  flush();
  return commands;
}

/** A simple command without its wrappers (`sudo -u root`, `env X=1`, `timeout 5`), its program's path dropped. */
export function unwrapped(parsed: string[]): string[] {
  const words = [...parsed];
  let wrapper = "";
  while (words.length) {
    const w = words[0]!;
    const name = LOADER.test(posix.basename(w)) ? "ld.so" : posix.basename(w);
    if (PREFIXES.has(name)) { wrapper = name; words.shift(); continue; }
    if (w.startsWith("-")) { words.shift(); if (VALUE_FLAGS[wrapper]?.includes(w)) words.shift(); continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (wrapper === "timeout" && /^\d/.test(w))) { words.shift(); continue; }
    break;
  }
  if (words.length) words[0] = posix.basename(words[0]!);
  return words;
}

/** Where `cd <target>` leaves the shell, when it can be told: an absolute or home path, or one relative to a known folder. */
function movedTo(cwd: string | undefined, target: string | undefined): string | undefined {
  if (target === undefined) return "~";
  if (target.startsWith("/") || /^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/.test(target)) return target;
  if (target === "-" || target.includes("$") || !cwd) return undefined;
  return posix.join(cwd, target);
}

/**
 * The warning for a suspect command, or undefined. On a machine every rule
 * applies; in the sandbox only those marked `everywhere`. A `cd` earlier on
 * the line moves where a later relative `rm` points, so `cd / && rm -rf *`
 * is read as `rm -rf /*`.
 */
export function suspectCommand(command: string, where: SuspectWhere = "machine"): string | undefined {
  const rules = where === "machine" ? SUSPECT_COMMANDS : SUSPECT_COMMANDS.filter((s) => s.everywhere);
  let cwd: string | undefined;
  for (const parsed of simpleCommands(command)) {
    const words = unwrapped(parsed);
    if (!words.length) continue;
    if (words[0] === "cd" || words[0] === "pushd") { cwd = movedTo(cwd, args(words)[0]); continue; }
    const seen = words[0] === "rm" && cwd ? words.map((w, i) => (i && !w.startsWith("-") && !w.startsWith("/") && !w.startsWith("~") && !w.startsWith("$") ? posix.join(cwd!, w) : w)) : words;
    const hit = rules.find((s) => s.test(seen));
    if (hit) return hit.warning;
  }
  return undefined;
}

/**
 * The folders, relative to where the command starts unless absolute, in
 * which a git command on the line throws away uncommitted or untracked work
 * (`reset --hard`, `checkout -- .`, `clean`, …), so that work can be saved
 * first. A `cd` or `pushd` earlier on the line, and git's own `-C`, move it.
 */
export function discardingGit(command: string): string[] {
  const rules = SUSPECT_COMMANDS.filter((s) => s.discards);
  const dirs = new Set<string>();
  let cwd = ".";
  const move = (from: string, to: string | undefined) => (!to || to === "-" || to.includes("$") ? from : to.startsWith("/") ? to : posix.join(from, to));
  for (const parsed of simpleCommands(command)) {
    const words = unwrapped(parsed);
    if (!words.length) continue;
    if (words[0] === "cd" || words[0] === "pushd") { cwd = move(cwd, args(words)[0]); continue; }
    if (!rules.some((s) => s.test(words))) continue;
    let dir = cwd;
    for (let i = 1; i < words.length && words[i]!.startsWith("-"); i += GIT_VALUE_FLAGS.has(words[i]!) ? 2 : 1) if (words[i] === "-C") dir = move(dir, words[i + 1]);
    dirs.add(dir);
  }
  return [...dirs];
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
    "# 1. Her key, in a file only root can change, beside any key already there",
    "install -d -m 755 /etc/ssh/authorized_keys",
    `touch /etc/ssh/authorized_keys/${account}`,
    `grep -qxF -- '${line}' /etc/ssh/authorized_keys/${account} || printf '%s\\n' '${line}' >> /etc/ssh/authorized_keys/${account}`,
    `chmod 644 /etc/ssh/authorized_keys/${account}`,
    `printf 'Match User ${account}\\n    AuthorizedKeysFile /etc/ssh/authorized_keys/%%u\\n' > /etc/ssh/sshd_config.d/lyrica-${account}.conf`,
    "sshd -t && systemctl reload ssh",
    "",
    "# 2. Optional: sudo without a password, for exact commands (visudo -f /etc/sudoers.d/lyrica)",
    `${account} ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx`,
    "#    or, on a machine you really trust, for everything:",
    `# ${account} ALL=(root) NOPASSWD: ALL`,
    ...fingerprint,
  ].join("\n");
}
