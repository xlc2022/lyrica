import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@lyrica/core";
import { createSyntaxExtension, syntaxCheck } from "../src/syntax.ts";

/** She writes each file in turn; the fake target's checker fails for a path with "bad" in it, and is missing on `nonode`. */
async function scenario(writes: { path: string; machine?: string; fail?: boolean }[]) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-syntax-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "coder" }] });
  const runs: { machine: string; argv: string[] }[] = [];
  const results: string[] = [];
  const target = (machine = "sandbox"): ExecutionTarget => ({
    name: machine, cwd: async () => "/workspace", ops: () => ({}) as never, folders: () => [], secrets: () => ["sekret-token"],
    run: async (argv: string[]) => {
      runs.push({ machine, argv });
      if (machine === "nonode") return { code: 127, stdout: Buffer.alloc(0), stderr: Buffer.from("node: not found\n") };
      const bad = argv.at(-1)!.includes("bad");
      return { code: bad ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.from(bad ? `${argv.at(-1)}:3\n  const = sekret-token\n        ^\nSyntaxError: Unexpected token '='\n` : "") };
    },
  });
  faux.setResponses([
    ...writes.map((w) => () => fauxAssistantMessage(fauxToolCall(w.fail ? "edit" : "write", { path: w.path, ...(w.machine ? { machine: w.machine } : {}) }), { stopReason: "toolUse" })),
    () => fauxAssistantMessage("Done"),
  ]);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [createSyntaxExtension({ target }), (pi) => {
      pi.registerProvider(faux.provider);
      for (const name of ["write", "edit"]) pi.registerTool({ name, label: name, description: name, parameters: Type.Object({ path: Type.String(), machine: Type.Optional(Type.String()) }),
        execute: async (_id, p: { path: string }) => { if (p.path.includes("fails")) throw new Error("no such file"); return { content: [{ type: "text", text: "written" }], details: {} }; } });
    }] });
  try {
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" });
    try {
      await session.bindExtensions({});
      await session.setModel(faux.getModel());
      await session.prompt("Write the files");
      for (const m of session.messages) if (m.role === "toolResult") results.push(m.content.map((c) => (c.type === "text" ? c.text : "")).join(" "));
      return { runs, results };
    } finally { session.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("syntax check after a write", () => {
  it("knows the checker for each kind of file, and none for the rest", () => {
    expect(syntaxCheck("src/a.js")).toEqual(["node", "--check", "src/a.js"]);
    expect(syntaxCheck("a.MJS")?.[0]).toBe("node");
    expect(syntaxCheck("package.json")?.[1]).toBe("-e");
    expect(syntaxCheck("tool.py")).toEqual(["python3", "-I", "-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])", "tool.py"]);
    for (const p of ["a.ts", "a.tsx", "README.md", "Makefile", "a.jsonc"]) expect(syntaxCheck(p)).toBeUndefined();
  });

  it("appends the error to a broken file's result, with secrets masked, and nothing to a good one; a .ts file runs nothing", async () => {
    const r = await scenario([{ path: "bad.js" }, { path: "good.py" }, { path: "web/a.ts" }, { path: "cfg.json", machine: "nonode" }, { path: "fails.js" }]);
    // Each check runs where the file went, on its absolute path; a failed write isn't checked.
    expect(r.runs.map((x) => `${x.machine}: ${x.argv.join(" ")}`)).toEqual([
      "sandbox: node --check /workspace/bad.js",
      "sandbox: python3 -I -c import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1]) /workspace/good.py",
      'nonode: node -e JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) /workspace/cfg.json',
    ]);
    expect(r.results[0]).toBe("written Syntax check failed: node says\n/workspace/bad.js:3\n  const = [credential hidden]\n        ^\nSyntaxError: Unexpected token '='");
    expect(r.results.slice(1, 4)).toEqual(["written", "written", "written"]);
    expect(r.results[4]).toContain("no such file");
  });
});
