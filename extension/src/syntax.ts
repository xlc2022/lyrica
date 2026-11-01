import { posix } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { maskSecrets, type ExecutionTarget } from "@lyrica/core";
import { tail } from "./checks.ts";

// Principle 2: a file she just wrote that doesn't parse is said in the write's
// own result, so she fixes it before building on it (docs/briefs/code-evidence.md,
// part B; from hermes-agent's lint tier). One file-local check on the target
// the file went to; TypeScript and the rest wait for the project's checks,
// which know the project's own configuration.

export const SYNTAX_TIMEOUT_MS = 10_000;
const REPORT_LINES = 20;
const REPORT_CHARS = 1500;

/** The check for a file, by its extension: argv with the file's path last. None for other files. */
export function syntaxCheck(path: string): string[] | undefined {
  const ext = posix.extname(path).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ["node", "--check", path];
  if (ext === ".json") return ["node", "-e", 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))', path];
  // ast.parse, never py_compile: that would write __pycache__. -I keeps a stray ast.py in the working folder from shadowing the module.
  if (ext === ".py") return ["python3", "-I", "-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])", path];
  return undefined;
}

export interface SyntaxOptions {
  /** Where her tools run: the sandbox, or one of the thread's machines by name. */
  target(machine?: string): ExecutionTarget;
}

/**
 * After a successful `write` or `edit` of a .js, .mjs, .cjs, .json or .py
 * file, runs its check where the file went, within 10 seconds. A failure is
 * appended to the tool's result; a pass, a missing checker or a check that
 * ran out of time adds nothing.
 */
export function createSyntaxExtension(o: SyntaxOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (e, ctx) => {
      if (e.isError || (e.toolName !== "write" && e.toolName !== "edit") || typeof e.input.path !== "string") return;
      const argv = syntaxCheck(e.input.path);
      if (!argv) return;
      let target: ExecutionTarget;
      try { target = o.target((e.input.machine as string | undefined) || undefined); } catch { return; }
      if (!target.run) return;
      let r: { code: number | null; stdout: Buffer; stderr: Buffer };
      try {
        const cwd = await target.cwd();
        r = await target.run([...argv.slice(0, -1), posix.resolve(cwd, argv.at(-1)!)], { timeoutMs: SYNTAX_TIMEOUT_MS, signal: ctx.signal });
      } catch { return; } // the checker isn't there, or the run was stopped
      // 127: the checker isn't on this target. null: it ran out of time, which says nothing about the file.
      if (r.code === 0 || r.code === 127 || r.code === null) return;
      const secrets = target.secrets?.() ?? [];
      const output = tail(maskSecrets(Buffer.concat([r.stdout, r.stderr]), secrets).toString().replace(/\r\n/g, "\n"), REPORT_LINES, REPORT_CHARS).trim();
      return { content: [...e.content, { type: "text" as const, text: `Syntax check failed: ${argv[0]} says\n${output || `exit code ${r.code}`}` }] };
    });
  };
}
