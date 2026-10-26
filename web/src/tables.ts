// A Markdown table a model wrote on one line, put back on its own lines so it renders (docs/ux.md §6, Tables in a message).

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

/** Every one-line table in `text` unfolded; a fenced code block stays as written. */
export function unfoldTables(text: string): string {
  if (!text.includes("|")) return text;
  let fence = "";
  return text.split("\n").map((line) => {
    const open = FENCE.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = "";
      return line;
    }
    if (open) { fence = open; return line; }
    return unfoldLine(line);
  }).join("\n");
}
