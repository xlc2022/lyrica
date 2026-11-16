// Root steps and secrets on a card (docs/workspace.md, "Root steps" and
// "Secrets for one command"): she never holds a password and never writes
// sudoers. She writes a script on a machine; `run_as_root` or
// `run_with_secret` shows it on a question card with its hash. The user runs a
// root step in their own terminal, or types the password on the card and
// lyricad runs it with `sudo -S`; a secret the user types goes to the script's
// standard input. When the same root command will be needed again, she may
// offer exact sudoers lines instead, checked here.

import { createHash } from "node:crypto";
import { checkSudoers, quote, ROOT_LIMITS, sudoersCommand, type SudoersLine } from "./sudoers.ts";

export { checkSudoers, ROOT_LIMITS, SUDOERS_FILE, SUDOERS_HOW, sudoersCommand, type SudoersLine } from "./sudoers.ts";

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
  /** A `run_with_secret` card: the secret's name, as the field's label ("Tailscale auth key"). Its `command` runs as her account, without sudo. */
  secret?: string;
  /** With `secret`: a box of several lines (a private key) in place of one line. */
  lines?: boolean;
}

/** A secret's name on the card, and the most a secret or a password may be. */
export const SECRET_LIMITS = { name: 40, bytes: 16 * 1024 };

/** The shell the card runs a script with: `sh` when its first line asks for sh or dash, else bash. */
export const scriptShell = (script: string): "sh" | "bash" => (/^#!\s*(?:\/usr)?\/bin\/(?:env\s+)?(?:sh|dash)(?:\s|$)/.test(script) ? "sh" : "bash");

/**
 * The command on the card for a script at `path` with this hash. Her account
 * owns the script, so it is copied first and the copy is checked and run:
 * a change after the check can't reach root. The copy runs under `sh` when
 * the script's first line says so, else bash. The cleanup keeps the chain's
 * exit status (`(exit $rc)` sets it without leaving the person's shell), so
 * a refused hash or a failed script shows as a failure, not as the rm's 0.
 */
export const rootCommand = (path: string, sha256: string, shell: "sh" | "bash" = "bash"): string =>
  `f=$(mktemp) && cat ${quote(path)} > "$f" && echo ${quote(`${sha256}  `)}"$f" | sha256sum -c --quiet - && sudo ${shell} "$f"; rc=$?; rm -f "$f"; (exit $rc)`;

/**
 * The same chain without sudo: what lyricad runs as her account for a
 * `run_with_secret` card, with the secret on the script's standard input. The
 * copy is checked against the hash the card showed, so a script changed after
 * the person read it never gets the secret.
 */
export const secretCommand = (path: string, sha256: string, shell: "sh" | "bash" = "bash"): string =>
  `f=$(mktemp) && cat ${quote(path)} > "$f" && echo ${quote(`${sha256}  `)}"$f" | sha256sum -c --quiet - && ${shell} "$f"; rc=$?; rm -f "$f"; (exit $rc)`;

/**
 * A root step lyricad runs itself, with the password the person typed on the
 * card as sudo's first line of input: `-S` reads it there, `-p ''` prints no
 * prompt, and `-k` neither uses nor updates a cached login, so the password
 * opens this one script and nothing she runs after it.
 */
export const sudoRunCommand = (path: string, sha256: string, shell: "sh" | "bash" = "bash"): string =>
  `f=$(mktemp) && cat ${quote(path)} > "$f" && echo ${quote(`${sha256}  `)}"$f" | sha256sum -c --quiet - && sudo -S -k -p '' ${shell} "$f"; rc=$?; rm -f "$f"; (exit $rc)`;

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
  // What the card shows must be what bash reads: no control or invisible format characters besides tab and newline.
  if (HIDDEN.test(script)) throw new Error("the script has control or invisible characters (other than tab and newline), so the card couldn't show what runs");
  return { script, sha256: createHash("sha256").update(bytes).digest("hex"), why };
}

/** Reads what `run_as_root` read on the machine into the card: refuses a script too long, empty or not text. */
export function rootStep(input: { machine: string; path: string; why: string; sudoers?: string[] }, bytes: Buffer, account: string): RootStep {
  const { script, sha256, why } = readScript(input, bytes);
  // The command carries the lines as the card shows them: checked and trimmed.
  const sudoers = input.sudoers?.length ? checkSudoers(input.sudoers, account) : undefined;
  return {
    machine: input.machine, path: input.path, sha256, command: rootCommand(input.path, sha256, scriptShell(script)), script, why,
    ...(sudoers ? { sudoers, sudoersCommand: sudoersCommand(sudoers.map((l) => l.line)) } : {}),
  };
}

/** Reads what `run_with_secret` read on the machine into the card, with the secret's name as its field's label. */
export function secretStep(input: { machine: string; path: string; why: string; secret: string; lines?: boolean }, bytes: Buffer): RootStep {
  const name = (input.secret ?? "").trim();
  if (!name || [...name].length > SECRET_LIMITS.name) throw new Error(`secret is the field's label, 1 to ${SECRET_LIMITS.name} characters, such as "Tailscale auth key"`);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) throw new Error("secret is one line of text");
  const { script, sha256, why } = readScript(input, bytes, "what it does with the secret");
  return { machine: input.machine, path: input.path, sha256, command: secretCommand(input.path, sha256, scriptShell(script)), script, why, secret: name, ...(input.lines ? { lines: true } : {}) };
}
