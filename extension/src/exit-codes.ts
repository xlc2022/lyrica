import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Principle 5: a non-zero exit isn't always a failure. She read rg's "no
// matches" and gh pr checks' "still pending" as errors, so a bash result
// says what a well-known exit code means.

const STATUS = /\n?Command exited with code (\d+)$/;

/** What an exit code means for the command that ended the line, if it is a well-known one; `ok` when it isn't a failure. */
export function exitMeaning(command: string, code: number): { text: string; ok: boolean } | undefined {
  const words = lastCommand(command);
  const name = words[0]?.split("/").pop() ?? "";
  if (code === 1 && (["rg", "grep", "egrep", "fgrep", "ag"].includes(name) || (name === "git" && words[1] === "grep"))) return { text: `${name === "git" ? "git grep" : name}: no matches`, ok: true };
  if (code === 1 && ["diff", "cmp"].includes(name)) return { text: `${name}: the files differ`, ok: true };
  if (code === 1 && ["test", "["].includes(name)) return { text: "the test was false", ok: true };
  if (name === "gh" && words[1] === "pr" && words[2] === "checks") {
    if (code === 8) return { text: "gh pr checks: some checks are still pending", ok: true };
    if (code === 1) return { text: "gh pr checks: a check failed, or gh itself did; read a failed check's log (gh run view <run> --log-failed) and fix it", ok: false };
  }
  if (code === 124 && name === "timeout") return { text: "timeout: the command ran out of time", ok: false };
  if (code === 127) return { text: "command not found", ok: false };
  if (code === 126) return { text: "not executable", ok: false };
  if (code === 137) return { text: "killed (SIGKILL), often for running out of memory", ok: false };
  if (code === 143) return { text: "terminated (SIGTERM)", ok: false };
  return undefined;
}

/** The words of the last simple command in a shell line: the one whose exit code the line returns. */
function lastCommand(command: string): string[] {
  let segment = "";
  let last = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) { if (c === quote) quote = ""; segment += c; continue; }
    if (c === "'" || c === '"') { quote = c; segment += c; continue; }
    // `2>&1` and `&>` are redirections, not a separator.
    const redirect = c === "&" && (/[<>]$/.test(segment) || command[i + 1] === ">");
    if (!redirect && (c === ";" || c === "\n" || c === "|" || c === "&")) { if (segment.trim()) last = segment; segment = ""; continue; }
    segment += c;
  }
  const words = (segment.trim() ? segment : last).trim().replace(/^[({]\s*|\s*[)}]$/g, "").match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  // Leading assignments and wrappers don't change what ran.
  while (words.length && (/^\w+=/.test(words[0]!) || ["sudo", "command", "time", "exec", "nice", "env"].includes(words[0]!))) words.shift();
  return words;
}

export function registerExitCodes(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || !event.isError) return;
    const last = event.content.at(-1);
    const match = last?.type === "text" ? STATUS.exec(last.text) : null;
    const command = (event.input as { command?: unknown }).command;
    if (!match || typeof command !== "string") return;
    const meaning = exitMeaning(command, Number(match[1]));
    if (!meaning) return;
    const text = last!.type === "text" ? last!.text.replace(STATUS, (m) => `${m} (${meaning.text}${meaning.ok ? ", not a failure" : ""})`) : "";
    return { content: [...event.content.slice(0, -1), { type: "text", text }], isError: !meaning.ok };
  });
}
