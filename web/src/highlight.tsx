// Code coloured by language (docs/ux.md §6, "Lyrica's inner workings" and "Code in a message"): a tool call's
// arguments, a read's file text and fenced code in her messages. The grammars load the first time code shows, so a
// page with none never fetches them; until then, and for a language with none, the text shows uncoloured.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Root, RootContent } from "hast";

type Lowlight = { highlight: (lang: string, text: string) => Root; registered: (lang: string) => boolean };
let lowlight: Lowlight | undefined;
let loading: Promise<Lowlight> | undefined;
const waiting = new Set<() => void>();

function load(): Promise<Lowlight> {
  loading ??= import("./grammars.ts").then((m) => {
    lowlight = m.lowlight;
    for (const w of waiting) w();
    waiting.clear();
    return m.lowlight;
  });
  return loading;
}

/** Past this much text a block is left uncoloured: colouring is all at once, on the page's one thread. */
const MAX_COLOURED = 256 * 1024;

/** File extensions to the grammar that colours them. */
const BY_EXT: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", py: "python", pyw: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript", json: "json", jsonc: "json", json5: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", conf: "ini", cfg: "ini", service: "ini", html: "xml", htm: "xml", xml: "xml", svg: "xml", css: "css", scss: "scss",
  less: "less", nix: "nix", rs: "rust", go: "go", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", java: "java", kt: "kotlin", rb: "ruby",
  php: "php", lua: "lua", pl: "perl", r: "r", swift: "swift", sql: "sql", diff: "diff", patch: "diff", mk: "makefile", graphql: "graphql",
  cs: "csharp", dockerfile: "dockerfile",
};
/** Names a fence uses for a grammar under another name. */
const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", py: "python", js: "javascript", ts: "typescript",
  yml: "yaml", toml: "ini", html: "xml", svg: "xml", rs: "rust", golang: "go", "c++": "cpp", docker: "dockerfile", jsonc: "json", json5: "json" };

/** The grammar for a file by its name: its extension, or a Dockerfile or Makefile by name. */
export function langOfPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXT[name.slice(dot + 1)] : undefined;
}

/** The grammar a fence's language names, if there is one. */
export const langOfFence = (lang: string): string | undefined => {
  const l = lang.toLowerCase();
  return l ? ALIASES[l] ?? l : undefined;
};

/** The program a `#!` line names, as a grammar. */
function langOfShebang(line: string): string | undefined {
  if (!line.startsWith("#!")) return undefined;
  const words = line.slice(2).trim().split(/\s+/);
  const prog = (words[0]?.endsWith("/env") ? words.find((w, i) => i > 0 && !w.startsWith("-")) : words[0]) ?? "";
  return langOfProgram(prog.slice(prog.lastIndexOf("/") + 1));
}

function langOfProgram(prog: string): string | undefined {
  if (/^(ba|z|da|k)?sh$/.test(prog)) return "bash";
  if (/^python[0-9.]*$/.test(prog)) return "python";
  if (prog === "node" || prog === "deno" || prog === "bun") return "javascript";
  if (prog === "ruby" || prog === "perl" || prog === "lua") return prog;
  if (prog === "psql" || prog === "sqlite3" || prog === "mysql") return "sql";
  return undefined;
}

/** What a value of several lines reads as: code in a language, Markdown, or plain text. */
export type Kind = { kind: "code"; lang: string } | { kind: "markdown" } | { kind: "text" };

const MD_BLOCK = /^(#{1,6} |\s*[-*+] |\s*\d+[.)] |\s*```|\s*> |\|.*\|\s*$)/;
const MD_INLINE = /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)/;

/** How to show `text`, from a file's path when there is one, else its first line, JSON, or Markdown's marks. */
export function kindOf(text: string, path?: string): Kind {
  const byPath = path ? langOfPath(path) : undefined;
  if (byPath) return { kind: "code", lang: byPath };
  if (path && /\.(md|markdown|mdx)$/i.test(path)) return { kind: "markdown" };
  if (path && /\.(txt|text|log|csv|tsv)$/i.test(path)) return { kind: "text" };
  const first = text.slice(0, text.indexOf("\n") >>> 0);
  const bang = langOfShebang(first);
  if (bang) return { kind: "code", lang: bang };
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { JSON.parse(text); return { kind: "code", lang: "json" }; } catch { /* not JSON */ }
  }
  const lines = text.split("\n", 200);
  if (lines.some((l) => MD_BLOCK.test(l)) || MD_INLINE.test(text)) return { kind: "markdown" };
  return { kind: "text" };
}

/** A heredoc's opening (`<<'PY'`, `<<-EOF`, `<< "END"`): its marker word. One pass, no backtracking across words. */
const HEREDOC = /(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;

/** The grammar a heredoc's body takes from the command that reads it: `python3 - <<'PY'`, `cat > x.json <<EOF`. */
function langOfHeredoc(line: string, at: number): string | undefined {
  const before = line.slice(0, at);
  const file = /(?:>|\btee(?:\s+-a)?)\s*([^\s|;&<>]+)\s*$/.exec(before) ?? /(?:>|\btee(?:\s+-a)?)\s*([^\s|;&<>]+)/.exec(line.slice(at));
  if (file) return langOfPath(file[1]!);
  const words = before.split(/[|;&]/).at(-1)!.trim().split(/\s+/);
  const prog = words.find((w) => w !== "sudo" && w !== "env" && !w.includes("=") && !w.startsWith("-")) ?? "";
  return langOfProgram(prog.slice(prog.lastIndexOf("/") + 1));
}

/** A shell script cut into its own lines and the heredoc bodies it feeds to other programs, each with its grammar. */
export function heredocs(script: string): { lang?: string; text: string; sub: boolean }[] {
  const lines = script.split("\n");
  const out: { lang?: string; text: string; sub: boolean }[] = [];
  let shell: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    shell.push(line);
    const m = HEREDOC.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.replace(/^\t+/, "") : l) === m[3]);
    // No closing line, or no body at all: the lines stay with the script.
    if (end < 0 || end === i + 1) continue;
    out.push({ lang: "bash", text: shell.join("\n"), sub: false });
    shell = [];
    out.push({ lang: langOfHeredoc(line, m.index), text: lines.slice(i + 1, end).join("\n"), sub: true });
    i = end - 1;
  }
  if (shell.length) out.push({ lang: "bash", text: shell.join("\n"), sub: false });
  return out;
}

/** hast from the highlighter as React: spans with their classes, and text. */
function toReact(nodes: RootContent[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "text") return <Fragment key={i}>{n.value}</Fragment>;
    if (n.type !== "element") return null;
    const cls = n.properties.className;
    return <span key={i} className={Array.isArray(cls) ? cls.join(" ") : undefined}>{toReact(n.children)}</span>;
  });
}

/** The grammars, once they have loaded; a re-render when they arrive. */
function useGrammars(want: boolean): Lowlight | undefined {
  const [, ready] = useState(0);
  useEffect(() => {
    if (!want || lowlight) return;
    const done = () => ready((n) => n + 1);
    waiting.add(done);
    void load();
    return () => { waiting.delete(done); };
  }, [want]);
  return lowlight;
}

function colour(ll: Lowlight | undefined, lang: string | undefined, text: string): ReactNode {
  if (!ll || !lang || !ll.registered(lang) || text.length > MAX_COLOURED) return text;
  try { return toReact(ll.highlight(lang, text).children); } catch { return text; }
}

/**
 * `text` coloured as `lang`; a shell script's heredocs as the program they feed, each set off by a faint rule.
 * `plain` (a field she is still writing) shows it uncoloured, so a half-written string can't colour the rest.
 */
export function Highlighted({ text, lang, plain }: { text: string; lang?: string; plain?: boolean }) {
  const ll = useGrammars(Boolean(lang) && !plain);
  return useMemo(() => {
    if (plain || !lang) return <>{text}</>;
    if (lang !== "bash" || !text.includes("<<")) return <>{colour(ll, lang, text)}</>;
    // A body is a block of its own; the newline closing each piece keeps the text as written, and before a block adds no line.
    const parts = heredocs(text);
    return <>{parts.map((p, i) => {
      const nl = i < parts.length - 1 ? "\n" : "";
      return p.sub ? <span key={i} className="heredoc">{colour(ll, p.lang, p.text)}{nl}</span> : <Fragment key={i}>{colour(ll, p.lang, p.text)}{nl}</Fragment>;
    })}</>;
  }, [ll, text, lang, plain]);
}
