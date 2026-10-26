// Her Markdown made ready to render (docs/ux.md §6, Tables in a message): a table a model wrote on one line put back
// on its own lines, and math written between \( \) or \[ \] given the $$ marks the parser reads.

/** A line's cells: split on each pipe a backslash doesn't escape, the outer pipes dropped. */
const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);

const DELIMITER = /^\s*:?-+:?\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * One line that holds a whole table, "| a | b | |---|---| | c | d |", as its rows: a row's closing pipe and the next
 * row's opening one leave an empty cell between them, so with n columns every (n+1)th cell is empty. The header's
 * width comes from the delimiter row that follows it. Anything else comes back as it was.
 */
export function unfoldLine(line: string): string {
  if (!line.trimStart().startsWith("|")) return line;
  const cells = cellsOf(line);
  let n = 1;
  while (n < cells.length && cells[n]!.trim() !== "") n++;
  if (n + 1 + n > cells.length) return line;
  const delimiter = cells.slice(n + 1, n + 1 + n);
  if (!delimiter.every((c) => DELIMITER.test(c))) return line;
  const rows: string[][] = [];
  for (let i = 0; i < cells.length; i += n + 1) {
    const row = cells.slice(i, i + n);
    if (row.every((c) => c.trim() === "")) continue;
    if (i + n < cells.length && cells[i + n]!.trim() !== "") return line;
    rows.push(row);
  }
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  return rows.map((r) => `${indent}|${r.join("|")}|`).join("\n");
}

/** `text` cut into runs of lines outside fenced code blocks and the blocks themselves, in order. */
function runs(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; lines: string[] }[] = [];
  let fence = "";
  for (const line of text.split("\n")) {
    const open = FENCE.exec(line)?.[1];
    const code = Boolean(fence || open);
    if (fence) { if (open && open[0] === fence[0] && open.length >= fence.length) fence = ""; }
    else if (open) fence = open;
    const last = out.at(-1);
    if (last && last.code === code) last.lines.push(line); else out.push({ code, lines: [line] });
  }
  return out.map((r) => ({ code: r.code, text: r.lines.join("\n") }));
}

/** Every one-line table in `text` unfolded; a fenced code block stays as written. */
export function unfoldTables(text: string): string {
  if (!text.includes("|")) return text;
  return runs(text).map((r) => (r.code ? r.text : r.text.split("\n").map(unfoldLine).join("\n"))).join("\n");
}

/**
 * Math between \( \) inline and \[ \] on its own lines, as models often write it, in the $$ marks remark-math reads
 * (a single $ is left alone: it is a price far more often than math). Fenced and inline code stay as written.
 */
export function mathMarks(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  return runs(text).map((r) => (r.code ? r.text : r.text.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => `\n\n$$\n${tex.trim()}\n$$\n\n`)
    .replace(/\\\((.+?)\\\)/g, (_, tex: string) => `$$${tex.trim()}$$`))).join(""))).join("\n");
}

/** Her Markdown as the renderer reads it. */
export const prepareMarkdown = (text: string) => mathMarks(unfoldTables(text));
