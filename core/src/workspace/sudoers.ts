// Sudoers lines: checking an offered line, and the command that adds lines
// to her sudoers file. Free of Node modules, so the web interface builds the
// Add machine page's Sudo, exact commands block from the same code.

/** A script's size, her reason's length, and how many sudoers lines one card offers. */
export const ROOT_LIMITS = { scriptBytes: 16 * 1024, why: 600, sudoers: 8, line: 300 };

export interface SudoersLine { line: string; warning?: string }

/** The file her offered lines go to, and what the card's command does with them. */
export const SUDOERS_FILE = "/etc/sudoers.d/lyrica";
export const SUDOERS_HOW = "it keeps the lines the file already has, checks the result with visudo -c and installs it only when that passes";

export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The command on the card that adds offered lines to the sudoers file, ready to paste. It reads the file's own
 * lines in a step of its own, so a failed sudo (a mistyped password) stops the chain instead of installing the
 * new lines alone; then the old lines (their last one given its newline) and the new, each once; put beside the
 * file as `lyrica.new` with root's ownership and mode (sudo ignores a name with a dot, so a bad file can't lock
 * anyone out); checked there by `visudo -c`; moved over the file only when the check passes. The cleanup keeps
 * the chain's status and never prompts (`sudo -n`). The person never opens an editor, and nothing unchecked
 * reaches sudo. `file` is the card's `/etc/sudoers.d/lyrica`; a test gives its own.
 */
export const sudoersCommand = (lines: string[], file = SUDOERS_FILE): string =>
  `f=$(mktemp) && g=$(mktemp) && { sudo test ! -e ${file} || sudo cat ${file}; } > "$f" && { awk 1 "$f"; printf '%s\\n' ${lines.map(quote).join(" ")}; } | awk '!seen[$0]++' > "$g"`
  + ` && sudo install -m 0440 -o root -g root "$g" ${file}.new && sudo visudo -c -f ${file}.new && sudo mv -f ${file}.new ${file}; rc=$?; sudo -n rm -f ${file}.new 2>/dev/null; rm -f "$f" "$g"; (exit $rc)`;

/** Programs a sudoers line may never name: they run anything. */
const NEVER = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "ash", "mksh", "yash", "rbash", "pwsh", "su", "sudo", "doas", "runuser", "env",
  "vi", "vim", "nvim", "rvim", "view", "ex", "nano", "emacs", "ed", "less", "more", "man", "watch",
  "python", "python3", "perl", "ruby", "node", "npx", "deno", "bun", "lua", "php", "tclsh", "wish", "sqlite3", "awk", "gawk", "make", "git", "journalctl",
  "find", "xargs", "nohup", "nice", "timeout", "time", "script", "expect", "busybox", "eval", "exec",
  "systemd-run", "chroot", "unshare", "nsenter", "setsid", "setpriv", "stdbuf", "flock", "taskset", "ionice", "chrt", "start-stop-daemon",
  "strace", "ltrace", "gdb", "ssh", "socat", "screen", "tmux"]);

/** Where a program on a sudoers line must live: folders only root can change. */
/** Folders only root can change; NixOS keeps its programs in /run/current-system/sw. */
const SYSTEM_DIRS = ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/", "/usr/local/bin/", "/usr/local/sbin/", "/run/current-system/sw/bin/", "/run/current-system/sw/sbin/"];

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
    if (words.slice(1).some((w) => HERS.test(w) || /(^|\/)\.\.(\/|$)/.test(w))) bad("it runs or changes a file she can change");
    if (words.some((w, j) => j > 0 && w.startsWith("-") && name === "systemctl" && w !== "--no-block")) bad("give systemctl a fixed subcommand and unit, without options");
    const warning = REACHES_ROOT[name] ?? REACHES_ROOT[base]
      ?? (name === "systemctl" && SYSTEMCTL_ROOT.has(words[1] ?? "") ? "it changes what runs as root" : undefined);
    return { line, ...(warning ? { warning } : {}) };
  });
}

/** A Nix string literal: `"`, `\` and `${` escaped. */
export const nixString = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${")}"`;

/** NixOS sudo rules for her account, for the configuration's `security.sudo.extraRules`: each command, with or without a password. */
export function nixosSudo(account: string, commands: string[], nopasswd = true): string {
  const each = commands.map((c) => nopasswd ? `{ command = ${nixString(c)}; options = [ "NOPASSWD" ]; }` : nixString(c));
  return ["security.sudo.extraRules = [{", `  users = [ ${nixString(account)} ];`, `  commands = [ ${each.join(" ")} ];`, "}];"].join("\n");
}
