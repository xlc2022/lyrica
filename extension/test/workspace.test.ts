import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ExecutionTarget, ThreadWorkspace, ToolOps } from "@lyrica/core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceExtension, setToolsOff, type ThreadTools } from "../src/index.ts";

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

interface Run {
  /** Changes to the thread's settings, which the tools read on every call. */
  settings?: Partial<ThreadWorkspace>;
  /** Each step is one model reply; by default the calls, then "done". */
  steps?: ReturnType<typeof fauxToolCall>[][];
  extensions?: ExtensionFactory[];
  approve?: ThreadTools["approve"];
  proposePlan?: ThreadTools["proposePlan"];
  /** Another turn after the first. */
  again?: boolean;
}

/** Tools any thread has besides the workspace's: memory, and the switched ones, which do nothing here. */
const others: ExtensionFactory = (pi) => {
  for (const name of ["remember", "recall", "web_search", "web_fetch", "image"]) {
    pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }) });
  }
};

async function run(mode: ThreadWorkspace["mode"], calls: ReturnType<typeof fauxToolCall>[], o: Run = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-ws-"));
  dirs.push(dir);
  const files = new Map([["/workspace/notes.txt", "one\ntwo\n"]]);
  const commands: string[] = [];
  const system: string[] = [];
  /** The tools on offer at each model call. */
  const offered: string[][] = [];
  const results: string[] = [];
  let session: AgentSession | undefined;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  const steps = o.steps ?? [calls];
  faux.setResponses([
    ...steps.map((step) => (ctx: { messages: unknown[] }) => {
      system.push(JSON.stringify(ctx.messages.filter((m) => (m as { role: string }).role === "system")));
      offered.push(session!.getActiveToolNames());
      return fauxAssistantMessage(step);
    }),
    (_ctx: unknown) => { offered.push(session!.getActiveToolNames()); return fauxAssistantMessage("done"); },
    ...(o.again ? [(_ctx: unknown) => { offered.push(session!.getActiveToolNames()); return fauxAssistantMessage("again"); }] : []),
  ]);
  const settings: ThreadWorkspace = {
    grants: [{ path: "/srv/music", writable: false }], internet: false, services: false, hosts: [], mode, webSearch: true, images: true,
    target: "sandbox", parent: null, ...o.settings,
  };
  const workspace = createWorkspaceExtension({
    target: () => fakeTarget(files, commands), settings: () => settings, network: () => ({ internet: false, services: false, hosts: ["nas.lan:8080"] }),
    approve: o.approve, proposePlan: o.proposePlan, setMode: (m) => { settings.mode = m; },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), others, ...(o.extensions ?? []), workspace],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin",
  }));
  await session.bindExtensions({});
  await session.setModel(faux.getModel());
  session.subscribe((e) => {
    if (e.type === "tool_execution_end") results.push(`${e.toolName}: ${(e.result as { content: { text: string }[] }).content.map((c) => c.text).join("")}`);
  });
  try {
    await session.prompt("go");
    if (o.again) await session.prompt("and now?");
  } finally {
    session.dispose();
  }
  return { files, commands, system: system.join("\n"), offered, results, settings };
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
    const { files, commands } = await run("ask", [
      fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "1" }),
      fauxToolCall("bash", { command: "ls" }, { id: "2" }),
      fauxToolCall("read", { path: "notes.txt" }, { id: "3" }),
    ]);
    expect(files.has("/workspace/new.md")).toBe(false);
    expect(commands).toEqual([]);
  });

  it("ask before commands only", async () => {
    const { files, commands } = await run("acceptEdits", [
      fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "1" }),
      fauxToolCall("bash", { command: "ls" }, { id: "2" }),
    ]);
    expect(files.get("/workspace/new.md")).toBe("hello");
    expect(commands).toEqual([]);
  });

  it("leaves only the tools that read in Plan mode, and refuses the rest", async () => {
    const { files, commands, offered, results } = await run("plan", [
      fauxToolCall("read", { path: "notes.txt" }, { id: "1" }),
      fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "2" }),
      fauxToolCall("bash", { command: "ls" }, { id: "3" }),
    ]);
    expect(offered[0]!.sort()).toEqual(["propose_plan", "read", "recall", "web_fetch", "web_search"]);
    for (const t of ["write", "edit", "bash", "image", "remember"]) expect(offered[0]).not.toContain(t);
    expect(results.find((r) => r.startsWith("read:"))).toContain("one");
    expect(results.find((r) => r.startsWith("write:"))).toContain("not found");
    expect(files.has("/workspace/new.md")).toBe(false);
    expect(commands).toEqual([]);
  });

  it("switches the mode when a plan is approved, so she can write in the same turn", async () => {
    const plans: string[] = [];
    const { files, offered, results, settings } = await run("plan", [], {
      steps: [[fauxToolCall("propose_plan", { plan: "1. Write new.md" }, { id: "1" })], [fauxToolCall("write", { path: "new.md", content: "hello" }, { id: "2" })]],
      proposePlan: async (r) => { plans.push(r.plan); return "acceptEdits"; },
      again: true,
    });
    expect(plans).toEqual(["1. Write new.md"]);
    expect(results[0]).toContain("Accept edits mode");
    expect(settings.mode).toBe("acceptEdits");
    expect(offered[1]).toContain("write");
    expect(offered[1]).not.toContain("propose_plan");
    expect(files.get("/workspace/new.md")).toBe("hello");
    // And the next turn too.
    expect(offered[3]).toContain("write");
  });

  it("keeps planning when the plan isn't approved", async () => {
    const { offered, results, settings } = await run("plan", [fauxToolCall("propose_plan", { plan: "1. Write" }, { id: "1" })], { proposePlan: async () => undefined });
    expect(results[0]).toContain("keep planning");
    expect(settings.mode).toBe("plan");
    expect(offered[1]).not.toContain("write");
  });

  it("asks before an irreversible action even in Auto", async () => {
    const sent: string[] = [];
    const asked: string[] = [];
    const send: ExtensionFactory = (pi) => pi.registerTool({
      name: "send_email", label: "Send", description: "Sends an email.", parameters: Type.Object({ to: Type.String() }),
      annotations: { openWorldHint: true, destructiveHint: true },
      execute: async (_id, p) => { sent.push(p.to); return { content: [{ type: "text", text: "sent" }], details: undefined }; },
    });
    const calls = [fauxToolCall("send_email", { to: "a@example.net" }, { id: "1" }), fauxToolCall("bash", { command: "ls" }, { id: "2" })];
    await run("auto", calls, { extensions: [send], approve: async (r) => { asked.push(r.tool); return false; } });
    expect(asked).toEqual(["send_email"]);
    expect(sent).toEqual([]);
    await run("auto", calls, { extensions: [send], approve: async () => true });
    expect(sent).toEqual(["a@example.net"]);
  });

  it("removes a switched-off tool from the session and refuses a call to it", async () => {
    const web = await run("auto", [fauxToolCall("web_search", {}, { id: "1" })], { settings: { webSearch: false } });
    expect(web.offered[0]).not.toContain("web_search");
    expect(web.offered[0]).not.toContain("web_fetch");
    expect(web.offered[0]).toContain("image");
    expect(web.results[0]).not.toBe("web_search: ok");
    const images = await run("auto", [], { settings: { images: false } });
    expect(images.offered[0]).not.toContain("image");
    expect(images.offered[0]).toContain("web_search");
  });
});

describe("setToolsOff", () => {
  it("brings back only what a reason took away, once no reason has it off", () => {
    let active = ["read", "write", "remember"];
    const all = ["read", "write", "grep", "remember"];
    const pi = { getActiveTools: () => [...active], getAllTools: () => all.map((name) => ({ name })), setActiveTools: (n: string[]) => { active = n; } } as unknown as ExtensionAPI;
    setToolsOff(pi, undefined, "plan", ["write", "remember"]);
    setToolsOff(pi, undefined, "unlogged", ["remember"]);
    expect(active).toEqual(["read"]);
    setToolsOff(pi, undefined, "plan", []);
    expect(active).toEqual(["read", "write"]);
    setToolsOff(pi, undefined, "unlogged", []);
    // grep was never on, so it stays off.
    expect(active).toEqual(["read", "write", "remember"]);
  });
});
