import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exitMeaning, registerExitCodes } from "../src/index.ts";

// She read rg's "no matches" and gh pr checks' "pending" as errors in the self-editing trial.

type Handler = (event: unknown) => unknown;
function hook() {
  let handler!: Handler;
  registerExitCodes({ on: (_name: string, h: Handler) => { handler = h; } } as unknown as ExtensionAPI);
  return (command: string, text: string, toolName = "bash") =>
    handler({ type: "tool_result", toolName, input: { command }, content: [{ type: "text", text }], isError: true }) as { content: { text: string }[]; isError: boolean } | undefined;
}

describe("a bash result's exit code", () => {
  it("says what a well-known code means, and that no matches or pending checks aren't failures", () => {
    const run = hook();
    expect(run("rg TODO src 2>&1", "Command exited with code 1")).toEqual({ content: [{ type: "text", text: "Command exited with code 1 (rg: no matches, not a failure)" }], isError: false });
    expect(run("cd web && gh pr checks 12", "some output\n\nCommand exited with code 8")).toEqual({ content: [{ type: "text", text: "some output\n\nCommand exited with code 8 (gh pr checks: some checks are still pending, not a failure)" }], isError: false });
    expect(run("npm test; timeout 5 sleep 9", "Command exited with code 124")).toMatchObject({ isError: true, content: [{ text: "Command exited with code 124 (timeout: the command ran out of time)" }] });
  });

  it("goes by the command that ended the line, and leaves other codes and tools alone", () => {
    const run = hook();
    // The pipeline's last command decides the code: head, not rg.
    expect(run("rg x | head -1", "Command exited with code 1")).toBeUndefined();
    expect(run("npm test", "Command exited with code 1")).toBeUndefined();
    expect(run("rg x", "Command exited with code 1", "read")).toBeUndefined();
    expect(exitMeaning("LANG=C git grep -n foo;", 1)).toEqual({ text: "git grep: no matches", ok: true });
    expect(exitMeaning("echo 'a; rg' && diff a b", 1)).toEqual({ text: "diff: the files differ", ok: true });
    expect(exitMeaning("grep x f &> out", 1)?.ok).toBe(true);
  });
});
