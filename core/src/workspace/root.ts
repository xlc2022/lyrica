// Root steps and secrets on a card (docs/workspace.md, "Root steps" and
// "Secrets for one command"): she never holds a password and never writes
// sudoers. She writes a script on a machine; `run_as_root` or
// `run_with_secret` shows it on a question card with its hash. The user runs a
// root step in their own terminal, or types the password on the card and
// lyricad runs it with `sudo -S`; a secret the user types goes to the script's
// standard input. When the same root command will be needed again, she may
// offer exact sudoers lines instead, checked here.

import { createHash } from "node:crypto";
import { checkSudoers, nixosSudoers, quote, ROOT_LIMITS, sudoersCommand, SYSTEM_DIRS, type SudoersLine } from "./sudoers.ts";

export { checkSudoers, nixosSudoers, ROOT_LIMITS, SUDOERS_FILE, SUDOERS_HOW, sudoersCommand, type SudoersLine } from "./sudoers.ts";

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
  /** With `sudoers`: what the user runs to add the lines, checked by visudo before they reach sudo (`sudoersCommand`). */
  sudoersCommand?: string;
  /** With `sudoers` on a NixOS machine, in place of `sudoersCommand`: the `security.sudo.extraRules` lines and the rebuild (`nixosSudoers`), since NixOS's sudo reads no sudoers.d. */
  sudoersNixos?: string;
  /** A `run_with_secret` card: the secret's name, as the field's label ("Tailscale auth key"). Its `command` runs as her account, without sudo. */
  secret?: string;
  /** With `secret`: a box of several lines (a private key) in place of one line. */
  lines?: boolean;
}

/** A secret's name on the card, and the most a secret or a password may be. */
export const SECRET_LIMITS = { name: 40, bytes: 16 * 1024 };

/** Where a root step's interpreter may live: folders only root can change, so a change after the card can't reach root. */
const ROOT_INTERPRETER_DIRS = [...SYSTEM_DIRS, "/nix/store/"];
const INTERPRETER = /^\/[A-Za-z0-9._+/-]+$/;
const ROOT_ARG = /^-[A-Za-z]+$/;
const INTERPRETER_ARG = /^[A-Za-z0-9._+=:,@%/-]+$/;

/**
 * What the card runs a script's copy with, as shell words: what its first line
 * names, as running the file would (one interpreter and at most one argument,
 * the kernel's rule), so a Python or Perl script runs as one. A shell (sh,
 * dash, bash, directly or through env) runs by name from PATH, as before, so
 * `#!/bin/bash` works on NixOS too; no first line means bash. The copy sits in
 * a private mktemp folder, which may be noexec, so the interpreter is named rather
 * than the file run. For a root step (`root`) the interpreter must be in a
 * folder only root can change, and env's program a bare name (sudo's
 * secure_path finds it). Throws, before the card is made, on a first line it
 * can't run as written.
 */
export function scriptRunner(script: string, root = false): string {
  if (!script.startsWith("#!")) return "bash";
  const nl = script.indexOf("\n");
  const words = (nl < 0 ? script : script.slice(0, nl)).slice(2).split(/[ \t]+/).filter(Boolean);
  const [interpreter, ...rest] = words;
  if (!interpreter) return "bash";
  if (rest.length > 1) throw new Error(`the script's first line gives ${interpreter} ${rest.length} arguments; a first line runs one program with at most one argument (use #!/usr/bin/env python3, not env -S)`);
  const arg = rest[0];
  if (!INTERPRETER.test(interpreter)) throw new Error(`the script's first line must name its interpreter by absolute path, such as #!/usr/bin/env python3, not ${interpreter}`);
  // A `.` or `..` segment, or `//`, would carry a path past the folder check below.
  if (/\/\.{1,2}(?:\/|$)|\/\//.test(interpreter)) throw new Error(`the script's first line must name its interpreter by a plain absolute path, without . or .. or //: ${interpreter}`);
  if (arg !== undefined && !INTERPRETER_ARG.test(arg)) throw new Error(`the script's first line has an argument the card can't run as written: ${arg}`);
  const base = interpreter.slice(interpreter.lastIndexOf("/") + 1);
  const env = base === "env";
  if (env && (arg === undefined || arg.startsWith("-") || arg.includes("/"))) throw new Error("after #!/usr/bin/env comes the program's bare name, such as python3");
  const program = env ? arg! : base;
  // On a root step the argument (env's aside, a bare name) is a flag alone: a path there (bash /home/…/x.sh, perl -I/home/…) runs her files as root.
  if (root && !env && arg !== undefined && !ROOT_ARG.test(arg)) throw new Error(`a root step's first line may give its interpreter only a flag, such as -e, not ${arg}`);
  if (/^(?:sh|dash|bash)$/.test(program)) return [program === "dash" ? "sh" : program, ...(!env && arg !== undefined ? [arg] : [])].join(" ");
  if (root && !ROOT_INTERPRETER_DIRS.some((d) => interpreter.startsWith(d))) throw new Error(`a root step's interpreter must be in a folder only root can change (${ROOT_INTERPRETER_DIRS.join(", ")}), not ${interpreter}`);
  return arg === undefined ? interpreter : `${interpreter} ${arg}`;
}

/**
 * The command on the card for a script at `path` with this hash. Her account
 * owns the script, so it is copied first and the copy is checked and run:
 * a change after the check can't reach root. The copy runs under `sh` when
 * the script's first line names (`scriptRunner`), else bash. The cleanup keeps the chain's
 * exit status (`(exit $rc)` sets it without leaving the person's shell), so
 * a refused hash or a failed script shows as a failure, not as the rm's 0.
 */
export const rootCommand = (path: string, sha256: string, shell = "bash"): string =>
  `d=$(mktemp -d) && f="$d/script" && cat ${quote(path)} > "$f" && echo ${quote(`${sha256}  `)}"$f" | sha256sum -c --quiet - && sudo ${shell} "$f"; rc=$?; rm -rf "$d"; (exit $rc)`;

/**
 * The same chain without sudo: what lyricad runs as her account for a
 * `run_with_secret` card, with the secret on the script's standard input. The
 * copy is checked against the hash the card showed, so a script changed after
 * the person read it never gets the secret.
 */
export const secretCommand = (path: string, sha256: string, shell = "bash"): string =>
  `d=$(mktemp -d) && f="$d/script" && cat ${quote(path)} > "$f" && echo ${quote(`${sha256}  `)}"$f" | sha256sum -c --quiet - && ${shell} "$f"; rc=$?; rm -rf "$d"; (exit $rc)`;

/**
 * A root step lyricad runs itself, with the password the person typed on the
 * card. The account's shell execs sudo at once, so it keeps no copy of the
 * input: `-S` reads the password there, `-p` prints `prompt` (lyricad writes
 * the password only once it sees it, ops.ts handOff), and `-k` neither uses
 * nor updates a cached login. Root makes the copy of the script and checks
 * its hash, so the copy is root's own and the account can't change it between
 * the check and the run.
 */
export const sudoRunCommand = (path: string, sha256: string, shell: string, prompt: string): string =>
  `exec sudo -S -k -p ${quote(prompt)} /bin/sh -c ${quote(`d=$(mktemp -d) && f="$d/script" && cat "$1" > "$f" && printf '%s  %s\\n' "$2" "$f" | sha256sum -c --quiet - && ${shell} "$f"; rc=$?; rm -rf "$d"; exit $rc`)} sh ${quote(path)} ${quote(sha256)}`;

const HIDDEN = /[\x00-\x08\x0b-\x1f\x7f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** A script read for a card: refuses a path that isn't absolute, a missing reason, and a script too long, empty or not text. */
function readScript(input: { path: string; why: string }, bytes: Buffer, needs = "why it needs root"): { script: string; sha256: string; why: string } {
  if (!input.path.startsWith("/")) throw new Error("path must be the script's absolute path on the machine");
  if (/[\x00-\x1f\x7f]/.test(input.path)) throw new Error("the path has control characters");
  const why = (input.why ?? "").trim();
  if (!why || why.length > ROOT_LIMITS.why) throw new Error(`why is 1 to ${ROOT_LIMITS.why} characters: what the script does and ${needs}`);
  if (!bytes.length) throw new Error("the script is empty");
  if (bytes.length > ROOT_LIMITS.scriptBytes) throw new Error(`the script is ${bytes.length} bytes; at most ${ROOT_LIMITS.scriptBytes}, so the person can read it`);
  if (bytes.includes(0)) throw new Error("the script isn't text");
  const script = bytes.toString("utf8");
  if (script.includes("\uFFFD")) throw new Error("the script isn't UTF-8 text");
  // What the card shows must be what the interpreter reads: no control or invisible format characters besides tab and newline.
  if (HIDDEN.test(script)) throw new Error("the script has control or invisible characters (other than tab and newline), so the card couldn't show what runs");
  return { script, sha256: createHash("sha256").update(bytes).digest("hex"), why };
}

/** Reads what `run_as_root` read on the machine into the card: refuses a script too long, empty or not text. On a NixOS machine (`nixos`), offered lines become configuration. */
export function rootStep(input: { machine: string; path: string; why: string; sudoers?: string[] }, bytes: Buffer, account: string, nixos = false): RootStep {
  const { script, sha256, why } = readScript(input, bytes);
  // The command carries the lines as the card shows them: checked and trimmed.
  const sudoers = input.sudoers?.length ? checkSudoers(input.sudoers, account, nixos) : undefined;
  const lines = sudoers?.map((l) => l.line) ?? [];
  return {
    machine: input.machine, path: input.path, sha256, command: rootCommand(input.path, sha256, scriptRunner(script, true)), script, why,
    ...(sudoers ? { sudoers, ...(nixos ? { sudoersNixos: nixosSudoers(account, lines) } : { sudoersCommand: sudoersCommand(lines) }) } : {}),
  };
}

/** Reads what `run_with_secret` read on the machine into the card, with the secret's name as its field's label. */
export function secretStep(input: { machine: string; path: string; why: string; secret: string; lines?: boolean }, bytes: Buffer): RootStep {
  const name = (input.secret ?? "").trim();
  if (!name || [...name].length > SECRET_LIMITS.name) throw new Error(`secret is the field's label, 1 to ${SECRET_LIMITS.name} characters, such as "Tailscale auth key"`);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) throw new Error("secret is one line of text");
  const { script, sha256, why } = readScript(input, bytes, "what it does with the secret");
  return { machine: input.machine, path: input.path, sha256, command: secretCommand(input.path, sha256, scriptRunner(script)), script, why, secret: name, ...(input.lines ? { lines: true } : {}) };
}
