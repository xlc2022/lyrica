import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExecutionTarget, ThreadWorkspace, ToolOps } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceExtension } from "../src/index.ts";

// Runs the workspace tools in a real Pi session against pi-ai's fake model,
// with a target that records what it is asked to do.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeTarget(files: Map<string, string>, commands: string[]): ExecutionTarget {
  const read = async (p: string) => {
    const text = files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    return Buffer.from(text);
  };
  const write = async (p: string, c: string) => { files.set(p, c); };
  const ops: ToolOps = {
    read: { readFile: read, access: async (p) => { await read(p); }, detectImageMimeType: async () => null },
    write: { writeFile: write, mkdir: async () => {} },
    edit: { readFile: read, writeFile: write, access: async (p) => { await read(p); } },
    bash: { exec: async (command, _cwd, { onData }) => { commands.push(command); onData(Buffer.from("ran\n")); return { exitCode: 0 }; } },
  };
  return { name: "sandbox", cwd: async () => "/workspace", ops: () => ops, folders: () => [] };
}

async function run(mode: ThreadWorkspace["mode"], calls: ReturnType<typeof fauxToolCall>[]) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-ws-"));
  dirs.push(dir);
  const files = new Map([["/workspace/notes.txt", "one\ntwo\n"]]);
  const commands: string[] = [];
  const system: string[] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  faux.setResponses([
    (ctx) => {
      system.push(JSON.stringify(ctx.messages.filter((m) => (m as { role: string }).role === "system")));
      return fauxAssistantMessage(calls);
    },
    fauxAssistantMessage("done"),
  ]);
  const settings: ThreadWorkspace = { grants: [{ path: "/srv/music", writable: false }], internet: false, services: false, hosts: [], mode, target: "sandbox", parent: null };
  const workspace = createWorkspaceExtension({ target: () => fakeTarget(files, commands), settings: () => settings, network: () => ({ internet: false, services: false, hosts: ["nas.lan:8080"] }) });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), workspace],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin",
  });
  await session.bindExtensions({});
  await session.setModel(faux.getModel());
  try {
    await session.prompt("go");
  } finally {
    session.dispose();
  }
  return { files, commands, system: system.join("\n") };
}

describe("workspace tools in a Pi session", () => {
  it("send read, write, edit and bash to the thread's target", async () => {
    const { files, commands, system } = await run("auto", [
      fauxToolCall("read", { path: "notes.txt" }, { id: "1" }),
      fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText: "two", newText: "three" }] }, { id: "2" }),
      fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "3" }),
      fauxToolCall("bash", { command: "ls" }, { id: "4" }),
    ]);
    expect(files.get("/workspace/notes.txt")).toBe("one\nthree\n");
    expect(files.get("/workspace/new.md")).toBe("hello");
    expect(commands).toEqual(["ls"]);
    expect(system).toContain("/srv/music (read-only)");
    expect(system).toContain("Internet for commands: off.");
    expect(system).toContain("Hosts you may reach: nas.lan:8080.");
  });

  it("ask before changes, and block them when no one can answer", async () => {
    const { files, commands } = await run("ask-changes", [
      fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "1" }),
      fauxToolCall("bash", { command: "ls" }, { id: "2" }),
      fauxToolCall("read", { path: "notes.txt" }, { id: "3" }),
    ]);
    expect(files.has("/workspace/new.md")).toBe(false);
    expect(commands).toEqual([]);
  });

  it("ask before commands only", async () => {
    const { files, commands } = await run("ask-commands", [
      fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "1" }),
      fauxToolCall("bash", { command: "ls" }, { id: "2" }),
    ]);
    expect(files.get("/workspace/new.md")).toBe("hello");
    expect(commands).toEqual([]);
  });
});
