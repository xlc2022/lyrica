import { posix } from "node:path";
import { simpleCommands } from "./machines.ts";

export interface CommandRule { prefix: string; decision: "allow" | "ask" | "forbid" }
const SHELL = /^(?:sh|bash|dash|zsh|ksh|fish)$/;
const WRAPPER = /^(?:sudo|doas|env|nohup|exec|command|time|nice|ionice|builtin|timeout|xargs|stdbuf|chroot)$/;
const assignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const plain = (w: string | undefined) => !!w && /^[a-z][a-z0-9:_-]*$/.test(w);
const programs = (words: string[]) => words.filter(w => !assignment(w));
const opaque = (words: string[]) => {
  const candidates = WRAPPER.test(words[0] ?? "") ? words : words.slice(0, 1);
  return candidates.some(w => /[$`*?\[]/.test(w) || /^(?:eval|source|\.)$/.test(w) || (SHELL.test(posix.basename(w)) && !words.includes("-c")));
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

export function decide(command: string, rules: readonly CommandRule[]): CommandRule | undefined {
  const parts = simpleCommands(command).map(programs);
  const rank = { allow: 0, ask: 1, forbid: 2 };
  const results = parts.map(words => {
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
    if (opaque(words) && rules.some(r => r.decision === "forbid")) return { prefix: "", decision: "ask" } as CommandRule;
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
