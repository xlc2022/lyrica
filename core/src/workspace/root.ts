// Root steps on a card (docs/workspace.md, "Root steps"): she never runs sudo
// with a password and never writes sudoers. She writes a script on a machine;
// `run_as_root` shows it on a question card with its hash, and the user runs
// it. When the same root command will be needed again, she may offer exact
// sudoers lines instead, checked here.

import { createHash } from "node:crypto";

/** A script's size, her reason's length, and how many sudoers lines one card offers. */
export const ROOT_LIMITS = { scriptBytes: 16 * 1024, why: 600, sudoers: 8, line: 300 };

/** What the card shows, from the tool's own reading of the script: never her words, except `why`. */
export interface RootStep {
  machine: string;
  path: string;
  sha256: string;
  /** What the user runs: the hash is checked first, so a script changed after the card was made doesn't run. */
  command: string;
  script: string;
  why: string;
  sudoers?: SudoersLine[];
}

export interface SudoersLine { line: string; warning?: string }

/** The file and the way to add lines to it. */
export const SUDOERS_FILE = "/etc/sudoers.d/lyrica";
export const SUDOERS_HOW = `sudo visudo -f ${SUDOERS_FILE}, then sudo visudo -c`;

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The command on the card for a script at `path` with this hash. Her account
 * owns the script, so it is copied first and the copy is checked and run:
 * a change after the check can't reach root.
 */
export const rootCommand = (path: string, sha256: string): string =>
  `f=$(mktemp) && cat ${quote(path)} > "$f" && echo ${quote(`${sha256}  `)}"$f" | sha256sum -c --quiet - && sudo bash "$f"; rm -f "$f"`;

/** Programs a sudoers line may never name: they run anything. */
const NEVER = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "ash", "mksh", "yash", "rbash", "pwsh", "su", "sudo", "doas", "runuser", "env",
  "vi", "vim", "nvim", "rvim", "view", "ex", "nano", "emacs", "ed", "less", "more", "man", "watch",
  "python", "python3", "perl", "ruby", "node", "npx", "deno", "bun", "lua", "php", "tclsh", "wish", "sqlite3", "awk", "gawk", "make", "git", "journalctl",
  "find", "xargs", "nohup", "nice", "timeout", "time", "script", "expect", "busybox", "eval", "exec",
  "systemd-run", "chroot", "unshare", "nsenter", "setsid", "setpriv", "stdbuf", "flock", "taskset", "ionice", "chrt", "start-stop-daemon",
  "strace", "ltrace", "gdb", "ssh", "socat", "screen", "tmux"]);

/** Where a program on a sudoers line must live: folders only root can change. */
const SYSTEM_DIRS = ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/", "/usr/local/bin/", "/usr/local/sbin/"];

/** Folders where she can write, so a file there given to a root command is hers to change. */
const HERS = /^\/(home|tmp|var\/tmp|dev\/shm|run\/user)(\/|$)/;

/** Programs that can reach root anyway, with the reason the card gives. */
const REACHES_ROOT: Record<string, string> = {
  apt: "a package can run any script as root", "apt-get": "a package can run any script as root", dpkg: "a package can run any script as root", dnf: "a package can run any script as root",
  yum: "a package can run any script as root", pacman: "a package can run any script as root", zypper: "a package can run any script as root", snap: "a package can run any script as root",
  pip: "a package can run any code as root", pip3: "a package can run any code as root", npm: "a package can run any script as root",
  docker: "a container can mount the whole disk", podman: "a container can mount the whole disk", ctr: "a container can mount the whole disk", nerdctl: "a container can mount the whole disk",
  chmod: "it can make any file writable", chown: "it can give her any file", chgrp: "it can give her any file", cp: "it can overwrite any file", mv: "it can replace any file",
  tee: "it can overwrite any file", dd: "it can overwrite any file or disk", install: "it can place any file", rsync: "it can overwrite any file", tar: "it can overwrite any file",
  mount: "it can mount over any folder", ln: "it can redirect any file", sed: "it can rewrite any file", crontab: "a job runs as root", visudo: "it edits sudo's own rules",
  usermod: "it can add her to any group", passwd: "it can change any password", kill: "it can stop anything", pkill: "it can stop anything",
};

/** systemctl subcommands that change what runs as root. */
const SYSTEMCTL_ROOT = new Set(["edit", "link", "enable", "set-property", "import-environment", "set-environment", "daemon-reload", "revert", "preset"]);

/**
 * Checks sudoers lines she offers for `account`: each is `<account>
 * ALL=(root) NOPASSWD: /system/folder/program <fixed arguments>`, or `""`
 * for a program run with none (a bare program allows any arguments), with
 * no wildcard, comment, `ALL`, path she can write, or shell, editor,
 * interpreter or wrapper. Refuses the first bad line, with why; warns where
 * the program can reach root anyway.
 */
export function checkSudoers(lines: unknown, account: string): SudoersLine[] {
  if (!Array.isArray(lines) || !lines.length) throw new Error("sudoers is a list of lines");
  if (lines.length > ROOT_LIMITS.sudoers) throw new Error(`offer at most ${ROOT_LIMITS.sudoers} sudoers lines at once`);
  const head = `${account} ALL=(root) NOPASSWD: `;
  return lines.map((raw, i) => {
    const line = typeof raw === "string" ? raw.trim() : "";
    const bad = (why: string): never => { throw new Error(`sudoers line ${i + 1}: ${why}`); };
    if (!line || line.length > ROOT_LIMITS.line || /[\x00-\x1f\x7f]/.test(line)) bad(`must be one line of at most ${ROOT_LIMITS.line} characters`);
    if (!line.startsWith(head)) bad(`must start with "${head}"`);
    const words = line.slice(head.length).split(/\s+/);
    const program = words[0]!;
    // `""` alone after the program means no arguments; any other quote, a comment (#) or an alias (@) is refused.
    const none = words.length === 2 && words[1] === '""';
    if (/[*?[\]\\,:=!"'`$;&|<>(){}~#@]/.test((none ? words.slice(0, 1) : words).join(" "))) bad("wildcards, quotes, comments, commas and shell characters aren't allowed: name one command with fixed arguments");
    if (program === "ALL" || words.includes("ALL")) bad("ALL would let her run anything as root");
    if (!/^\/[\w./+-]+$/.test(program) || program.includes("/../") || program.includes("/./") || program.endsWith("/")) bad("the program must be an absolute path such as /usr/bin/systemctl");
    if (!SYSTEM_DIRS.some((d) => program.startsWith(d) && !program.slice(d.length).includes("/"))) bad(`the program must be in ${SYSTEM_DIRS.join(", ")}, where she can't change it`);
    const name = program.split("/").at(-1)!;
    // vim.basic, python3.12, bash.static: the name without a version or variant.
    const base = name.replace(/\..*$/, "").replace(/\d+$/, "");
    if (NEVER.has(name) || NEVER.has(base)) bad(`${name} runs anything, so it can't be allowed`);
    if (words.length === 1) bad('a program alone allows any arguments: give its fixed arguments, or "" for none');
    if (words.slice(1).some((w) => HERS.test(w))) bad("it runs or changes a file she can change");
    if (words.some((w, j) => j > 0 && w.startsWith("-") && name === "systemctl" && w !== "--no-block")) bad("give systemctl a fixed subcommand and unit, without options");
    const warning = REACHES_ROOT[name] ?? REACHES_ROOT[base]
      ?? (name === "systemctl" && SYSTEMCTL_ROOT.has(words[1] ?? "") ? "it changes what runs as root" : undefined);
    return { line, ...(warning ? { warning } : {}) };
  });
}

const HIDDEN = /[\x00-\x08\x0b-\x1f\x7f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** Reads what `run_as_root` read on the machine into the card: refuses a script too long, empty or not text. */
export function rootStep(input: { machine: string; path: string; why: string; sudoers?: string[] }, bytes: Buffer, account: string): RootStep {
  if (!input.path.startsWith("/")) throw new Error("path must be the script's absolute path on the machine");
  if (/[\x00-\x1f\x7f]/.test(input.path)) throw new Error("the path has control characters");
  const why = (input.why ?? "").trim();
  if (!why || why.length > ROOT_LIMITS.why) throw new Error(`why is 1 to ${ROOT_LIMITS.why} characters: what the script does and why it needs root`);
  if (!bytes.length) throw new Error("the script is empty");
  if (bytes.length > ROOT_LIMITS.scriptBytes) throw new Error(`the script is ${bytes.length} bytes; at most ${ROOT_LIMITS.scriptBytes}, so the person can read it`);
  if (bytes.includes(0)) throw new Error("the script isn't text");
  const script = bytes.toString("utf8");
  if (script.includes("\uFFFD")) throw new Error("the script isn't UTF-8 text");
  // What the card shows must be what bash reads: no control or invisible format characters besides tab and newline.
  if (HIDDEN.test(script)) throw new Error("the script has control or invisible characters (other than tab and newline), so the card couldn't show what runs");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    machine: input.machine, path: input.path, sha256, command: rootCommand(input.path, sha256), script, why,
    ...(input.sudoers?.length ? { sudoers: checkSudoers(input.sudoers, account) } : {}),
  };
}
