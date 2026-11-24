import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { outside } from "@lyrica/core";

// Prompt injection (principle 6; docs/workspace.md, "Outside content"): what
// an outsider can shape reaches her between markers, so injected text is easy
// to recognise. The web tools mark their own results; this marks an MCP
// server's answer and a command's output. It runs after every other
// extension, so the notes Lyrica adds to a result stay outside the markers.

/** The status line Pi ends a failed, stopped or timed-out command's output with (exit-codes.ts may have added its meaning). */
const STATUS = /\n\nCommand (?:exited with code|aborted|timed out after|terminated without)[^\n]*$/;

/** Who answered: the server and tool of an MCP call, the command for bash and a job's output; undefined for anything else. */
function source(tool: string, input: Record<string, unknown>): { from: string; kind: "mcp" | "output" } | undefined {
  // A background command's result is Lyrica's line saying it started; its output comes later through jobs.
  if (tool === "bash") return input.background === true ? undefined : { from: "the command's output", kind: "output" };
  if (tool === "jobs") return input.action === "output" ? { from: `${typeof input.id === "string" ? input.id : "the command"}'s kept output`, kind: "output" } : undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return mcp ? { from: `the MCP server ${mcp[1]}'s ${mcp[2]}`, kind: "mcp" } : undefined;
}

/**
 * The result with the outsider's text between the markers: every text block
 * of an MCP answer (all of it is the server's), the first block of a command's
 * output or a job's page. Lyrica's own lines stay outside: a job page's first
 * line, later blocks of a command's result, and Pi's status line, which ends
 * the output only when Pi marked the call failed (`isError`), so a command
 * that prints a status-shaped line can't get it out.
 */
export function markOutside(tool: string, input: Record<string, unknown>, content: readonly { type: string; text?: string }[], isError = false) {
  const where = source(tool, input);
  if (!where) return undefined;
  const mark = (text: string, keepStatus: boolean) => {
    // A job's page starts with Lyrica's line about the job.
    const head = tool === "jobs" ? text.slice(0, text.indexOf("\n") + 1) : "";
    const status = keepStatus ? STATUS.exec(text)?.[0] ?? "" : "";
    const body = text.slice(head.length, text.length - status.length);
    if (!body.trim() || body.trim() === "(no output)") return undefined;
    return `${head}${outside(where.from, body, where.kind)}${status}`;
  };
  const first = content.findIndex((c) => c.type === "text");
  let changed = false;
  const out = content.map((c, j) => {
    if (c.type !== "text" || typeof c.text !== "string" || (where.kind !== "mcp" && j !== first)) return c;
    const text = mark(c.text, tool === "bash" && isError);
    if (text === undefined) return c;
    changed = true;
    return { type: "text" as const, text };
  });
  return changed ? out : undefined;
}

/** Last in every session's extensions (session.ts). */
export function createOutsideExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", (event) => {
      const content = markOutside(event.toolName, (event.input ?? {}) as Record<string, unknown>, event.content as { type: string; text?: string }[], !!event.isError);
      return content ? { content: content as typeof event.content } : undefined;
    });
  };
}
