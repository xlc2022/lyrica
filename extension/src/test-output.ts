import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Principle 8: a test run's passing lines are what she reads least and pays
// for most, since every later step re-reads them. A long test run's result
// keeps its failures and its summary; the passing lines are left out.

/** A command line that runs a test suite. */
const TEST_RUN = /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:vitest|jest|mocha|pytest|playwright\s+test)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|e2e)\b|\b(?:cargo|go)\s+test\b/;
/** A line that reports a failure or what went wrong in one. */
const FAILURE = /\b(?:FAIL|FAILED|Failed|failed|Error|AssertionError|Expected|Received|expected|Timeout|timed out)\b|[✗×✘❯]|^\s*\d+\)\s/;
/** Results shorter than this are kept whole. */
export const TRIM_FROM = 120;
/** Lines kept after each failure line, for its message and where it happened. */
const AFTER = 8;
/** The last lines, with the totals and the exit status, always kept. */
const TAIL = 40;
/** Failure lines kept at most, before the tail. */
const MOST = 200;

/** A test run's output with only its failures (and a few lines after each) and its last lines; undefined when it is short. */
export function trimTestOutput(text: string): string | undefined {
  const lines = text.split("\n");
  if (lines.length <= TRIM_FROM) return undefined;
  const tailFrom = lines.length - TAIL;
  const keep = new Set<number>();
  for (let i = 0; i < tailFrom && keep.size < MOST; i++) {
    if (FAILURE.test(lines[i]!)) for (let j = i; j <= Math.min(i + AFTER, tailFrom - 1); j++) keep.add(j);
  }
  const out: string[] = [];
  let gap = false;
  for (let i = 0; i < tailFrom; i++) {
    if (keep.has(i)) { out.push(lines[i]!); gap = false; }
    else if (!gap) { out.push("…"); gap = true; }
  }
  const left = tailFrom - keep.size;
  return [`[Test output trimmed: ${left} of ${lines.length} lines left out, passing tests mostly; failures and the last ${TAIL} lines are kept. For more, rerun just the failing test.]`, ...out, ...lines.slice(tailFrom)].join("\n");
}

export function registerTestOutput(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !TEST_RUN.test(command)) return;
    const i = event.content.findIndex((c) => c.type === "text");
    const block = event.content[i];
    if (!block || block.type !== "text") return;
    const trimmed = trimTestOutput(block.text);
    if (!trimmed) return;
    return { content: event.content.map((c, j) => (j === i ? { type: "text" as const, text: trimmed } : c)) };
  });
}
