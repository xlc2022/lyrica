import { posix } from "node:path";
import { LOADER, SHELLS, simpleCommands, unwrapped } from "./machines.ts";

export interface CommandRule { prefix: string; decision: "allow" | "ask" | "forbid" }
/** What a new project starts with (docs/workspace.md, "Project command rules"): the person removes or changes them in Project settings. */
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = [
  { prefix: "git push --force", decision: "forbid" },
  { prefix: "git push -f", decision: "forbid" },
  { prefix: "rm -rf /", decision: "forbid" },
  { prefix: "rm -fr /", decision: "forbid" },
];
const SHELL = { test: (w: string) => SHELLS.has(w) };
const WRAPPER_NAMES = ["sudo", "doas", "env", "nohup", "exec", "command", "time", "nice", "ionice", "builtin", "timeout", "xargs", "stdbuf", "chroot"];
const WRAPPERS = new RegExp(`^(?:${WRAPPER_NAMES.join("|")})$`);
const WRAPPER = { test: (w: string) => WRAPPERS.test(w) || LOADER.test(w) };
const assignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const plain = (w: string | undefined) => !!w && /^[a-z][a-z0-9:_-]*$/.test(w);
const programs = (words: string[]) => words.filter(w => !assignment(w));
// What a glob in the program's name must not be able to name: a shell, wrapper or eval hides what runs.
const HIDING = [...SHELLS, ...WRAPPER_NAMES, "eval", "source", "."];
/** Whether a program glob (`/…/bin/*-gcc`) can only name programs no rule or check cares about: every word it
 * expands to fits the pattern, so if none of `named` fits, nor a loader, it hides nothing. Only `*` and `?` in the
 * name are read; a `[` set, or a name that could end like a loader (`.so`, `.so.2`), stays opaque. */
const harmlessGlob = (word: string, named: readonly string[]) => {
  const name = posix.basename(word);
  if (/[[\]]/.test(name) || !/[^*?\do]$/.test(name)) return false;
  const pattern = new RegExp(`^${name.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return ![...HIDING, ...named].some(n => pattern.test(n));
};
/** `names`, the first words of the project's Ask and Forbid rules, lets a harmless program glob through (`harmlessGlob`). */
const opaque = (words: string[], names?: readonly string[]) => {
  // `command -v` and `-V` only look a name up; they run nothing.
  if (words[0] === "command" && /^-[vV]+$/.test(words[1] ?? "")) return false;
  const wrapped = WRAPPER.test(words[0] ?? "");
  const candidates = wrapped ? words : words.slice(0, 1);
  // A glob only hides the program where the program is: the wrapper's own words and the program after them, not
  // its arguments (a quoted URL's `?`, a grep pattern's `*`).
  // A word after a flag may be that flag's value rather than the program, so the next word counts too, and so on.
  let at = wrapped ? words.length - unwrapped(words).length : 0;
  const flag = (w: string | undefined) => !!w && w.startsWith("-") && !w.includes("=");
  while (wrapped && flag(words[at - 1]) && at + 1 < words.length) { at++; while (flag(words[at]) && at + 1 < words.length) at++; }
  const named = words.slice(0, at + 1);
  // `[` globs only with a `]` after it: a lone `[` is the test command (`[ "$n" = 1 ]`).
  return named.some((w, i) => /[*?]|\[.*\]/.test(w) && !(names && i === at && harmlessGlob(w, names))) || candidates.some(w => /[$`]/.test(w) || /^(?:eval|source|\.)$/.test(w) || (SHELL.test(posix.basename(w)) && !words.includes("-c")));
};

/** Validate and normalize saved prefixes; saving a prefix again replaces it. */
export function commandRules(value: unknown): CommandRule[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("A project has at most 100 command rules.");
  const unique = new Map<string, CommandRule>();
  for (const rule of value) {
    if (!rule || typeof rule.prefix !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(rule.prefix)) throw new Error("A command prefix has no control characters.");
    const words = rule.prefix.trim().split(/\s+/);
    if (!rule.prefix.trim() || words.length > 8 || words.some((w: string) => w.length > 64)) throw new Error("A command prefix has 1 to 8 words, each at most 64 characters.");
    if (!["allow", "ask", "forbid"].includes(rule.decision)) throw new Error("A command rule is Allow, Ask or Forbid.");
    const prefix = words.join(" ");
    unique.set(prefix, { prefix, decision: rule.decision });
  }
  return [...unique.values()];
}

// A sourced script runs in her shell, so it can change what the rest of the line means. It is seen through only
// when every command in it is one of these, which set things up and run nothing else, and it sets none of the
// variables bash itself acts on (PATH is allowed: a changed PATH is no more than running a program by its path).
const SETUP = new Set(["export", "readonly", "declare", "typeset", "local", "unset", "set", "cd", "pushd", "popd", "echo", "true", "false", ":", "test", "[", "umask", "return",
  "pwd", "nproc", "dirname", "basename", "realpath", "readlink", "uname", "getconf"]);
const CONDITION = new Set(["if", "then", "else", "elif", "fi", "!"]);
const SHELL_READS = /^(?:BASH\w*|ENV|IFS|PS\d|PROMPT_COMMAND|SHELLOPTS|CDPATH|GLOBIGNORE)$/;
const LITERAL = /^[\w./@%+,:-]+$/;
const SOURCES = /^(?:source|\.)$/;
export const SCRIPT_LIMIT = 64 * 1024;

// A `#!` line is a comment to the shell that sources the file.
const withoutShebang = (script: string) => script.replace(/^#!.*/, "");

/** Whether a sourced script only sets things up (docs/workspace.md, "Project command rules"). */
export function setupOnly(script: string): boolean {
  if (script.length > SCRIPT_LIMIT) return false;
  return simpleCommands(withoutShebang(script)).every(part => {
    let words = part;
    while (words.length && CONDITION.has(words[0]!)) words = words.slice(1);
    if (words[0]?.startsWith("#")) return true;
    const run = programs(words);
    if (run.length && !SETUP.has(run[0]!)) return false;
    // A nameref (`declare -n r=BASH_ENV`) would set one of bash's own variables under another name.
    if (/^(?:declare|typeset|local)$/.test(run[0] ?? "") && run.some(w => /^-\w*n/.test(w))) return false;
    return words.every(w => !assignment(w) || !SHELL_READS.test(w.slice(0, w.indexOf("="))));
  });
}

/** The one part of a parsed line `decide` may look through: `source FILE` or `. FILE` with a literal path, with
 * nothing before it but `cd DIR`s, so nothing on the line can change the file between the gate reading it and bash
 * sourcing it. */
function sourcing(parts: string[][]): { at: number; cds: string[]; path: string } | undefined {
  const cds: string[] = [];
  for (const [at, words] of parts.entries()) {
    // `cd -` goes back to the last folder, and `-P`/`-L` are flags: none is a folder to resolve against.
    if (words[0] === "cd" && words.length === 2 && LITERAL.test(words[1]!) && !words[1]!.startsWith("-")) { cds.push(words[1]!); continue; }
    // Without a slash, bash looks the name up on PATH first, so which file it is isn't known.
    return SOURCES.test(words[0] ?? "") && words[1] && LITERAL.test(words[1]) && words[1].includes("/") ? { at, cds, path: words[1] } : undefined;
  }
  return undefined;
}

/** The file a command sources that the gate should read and pass to `decide`, with the `cd`s before it to resolve it from. */
export function sourcedFile(command: string): { cds: string[]; path: string } | undefined {
  const found = sourcing(simpleCommands(command).map(programs));
  return found && { cds: found.cds, path: found.path };
}

/** `sourced` is the text of the file `sourcedFile` names, when the gate could read it. */
export function decide(command: string, rules: readonly CommandRule[], sourced?: string): CommandRule | undefined {
  const parts = simpleCommands(command).map(programs);
  const rank = { allow: 0, ask: 1, forbid: 2 };
  const read = sourced === undefined ? undefined : sourcing(parts)?.at;
  const inside = read === undefined ? undefined : decide(withoutShebang(sourced!), rules);
  // A forbidden command in the script is refused whatever else it does; one that only sets things up is seen through.
  const seen = inside?.decision === "forbid" || (read !== undefined && setupOnly(sourced!)) ? read : undefined;
  const results = parts.map((words, at) => {
    // A script seen through counts as its own commands: a rule it breaks is broken here, and otherwise it hides nothing.
    if (at === seen && inside && inside.decision !== "allow") return inside;
    const matches = rules.filter(rule => {
      const prefix = rule.prefix.split(" ");
      if (rule.decision === "allow") return !opaque(words) && prefix.every((w, i) => w === words[i]);
      return words.some((w, i) => {
        if (posix.basename(w) !== prefix[0]) return false;
        let at = i + 1;
        return prefix.slice(1).every(p => { while (at < words.length && words[at] !== p) at++; return at++ < words.length; });
      });
    }).sort((a, b) => b.prefix.split(" ").length - a.prefix.split(" ").length || rank[b.decision] - rank[a.decision]);
    const hit = matches[0];
    if (hit?.decision === "forbid") return hit;
    if (at !== seen && opaque(words, rules.filter(r => r.decision !== "allow").map(r => r.prefix.split(" ")[0]!)) && rules.some(r => r.decision === "forbid")) return { prefix: "", decision: "ask" } as CommandRule;
    return hit;
  });
  return results.find(r => r?.decision === "forbid") ?? results.find(r => r?.decision === "ask")
    ?? (results.length && results.every(r => r?.decision === "allow") ? results[0] : undefined);
}

export function alwaysAllowPrefix(command: string): string | undefined {
  const parts = simpleCommands(command);
  if (parts.length !== 1) return undefined;
  const words = programs(parts[0]!);
  const program = words[0];
  if (!program || opaque(words) || SHELL.test(program) || WRAPPER.test(program) || /^(?:python.*|node|perl|ruby)$/.test(program)) return undefined;
  const prefix = [program];
  if (plain(words[1])) {
    prefix.push(words[1]!);
    if (["run", "exec", "x"].includes(words[1]!) && ["npm", "pnpm", "yarn", "cargo", "uv", "poetry", "bun"].includes(program) && plain(words[2])) prefix.push(words[2]!);
  }
  try { return commandRules([{ prefix: prefix.join(" "), decision: "allow" }])[0]!.prefix; } catch { return undefined; }
}
