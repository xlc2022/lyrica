import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace, type ExecutionTarget } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";
import type { EndpointInfo, MessagePage, PermissionRequest, ThreadSummary } from "../src/api.ts";

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const commands: string[] = [];
  const runs: string[][] = [];
  vi.spyOn(Workspace.prototype, "targetFor").mockImplementation(() => ({
    name: "sandbox", cwd: async () => "/workspace", folders: () => [],
    run: async (argv: string[]) => { runs.push(argv); return { code: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }; },
    ops: () => ({ bash: { exec: async (command: string, _cwd: string, opts: { onData: (b: Buffer) => void }) => { commands.push(command); opts.onData(Buffer.from("ran")); return { exitCode: 0 }; } } }),
  } as unknown as ExecutionTarget));
  const rt = await runtime();
  const dm = await daemon(rt, { delegation: { depth: 3 } });
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ models: [{ id: "chat" }] });
  const sub = await fakeOpenAI({ models: [{ id: "worker" }] });
  await localModel(ada, rt.ada.id, model.baseUrl, "chat");
  const endpoint = (await ada.post<EndpointInfo>(`/api/u/${rt.ada.id}/endpoints`, { name: "workers", kind: "local", baseUrl: sub.baseUrl })).body;
  for (const tier of ["strong", "cheap"]) await ada.put(`/api/u/${rt.ada.id}/columns/general/subagent.${tier}`, { model: { offeringId: endpoint.models[0]!.id } });
  const u = `/api/u/${rt.ada.id}/threads/general`;
  const project = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", project: true })).body;
  const path = `${u}/${enc(project.id)}`;
  await ada.patch(path, { watchThreads: false });
  const view = dm.d.services!.memory.openThreadView(rt.ada.id, "general");
  const child = view.own.createThread({ interface: "web", parent: project.id, child: true, title: "Work" });
  view.close();
  dm.d.services!.workspace.inheritSettings({ userId: rt.ada.id, pool: "general", threadId: project.id }, child.id);
  return { ...dm, rt, ada, model, sub, path, childPath: `${u}/${enc(child.id)}`, commands, runs, project };
}
const bash = (command: string) => ({ tools: [{ name: "bash", args: { command } }] });

describe("project command rules through lyricad", () => {
  it("forbids in Auto in the project chat and its thread, preserving rules across other settings", async () => {
    const s = await setup();
    expect((await s.ada.patch(s.path, { commandRules: [{ prefix: "git push", decision: "forbid" }] })).status).toBe(200);
    const changed = await s.ada.patch<ThreadSummary>(s.path, { threadsThinking: "high" });
    expect(changed.body.projectSettings!.commandRules).toEqual([{ prefix: "git push", decision: "forbid" }]);
    for (const path of [s.path, s.childPath]) {
      s.model.respond(c => c.messages.some(m => m.role === "tool") ? { text: "Refused." } : bash("ls && git push"));
      const stream = s.ada.events(`${path}/events`);
      await s.ada.post(`${path}/messages`, { text: "Try the command" });
      await stream.until(e => e.type === "turn_end");
      expect(stream.events.some(e => e.event.type === "permission")).toBe(false);
      expect(JSON.stringify(s.model.requests.at(-1)!.messages)).toContain("This project's rules forbid");
      stream.close();
    }
    expect(s.commands).toEqual([]);
    expect((await s.ada.patch(s.childPath, { commandRules: [] })).status).toBe(400);
  });
  it("Always allow stores the server prefix, then runs the next match in Ask without a card", async () => {
    const s = await setup();
    await s.ada.patch(`${s.path}/settings`, { mode: "ask" });
    s.model.reply(bash("npm run test"), { text: "First done." });
    const stream = s.ada.events(`${s.path}/events`);
    await s.ada.post(`${s.path}/messages`, { text: "Test" });
    await stream.until(e => e.type === "permission");
    const p = stream.events.find(e => e.event.type === "permission")!.event as PermissionRequest;
    expect(p.alwaysAllow).toBe("npm run test");
    expect((await s.ada.post(`${s.path}/permissions/${p.requestId}`, { allow: true, alwaysAllow: true, prefix: "git push" })).status).toBe(200);
    await stream.until(e => e.type === "turn_end");
    expect((await s.ada.get<ThreadSummary>(s.path)).body.projectSettings!.commandRules).toEqual([{ prefix: "npm run test", decision: "allow" }]);
    const from = stream.events.length;
    s.model.reply(bash("npm run test -- --watch=false"), { text: "Next done." });
    await s.ada.post(`${s.path}/messages`, { text: "Test again" });
    await stream.until(e => e.type === "turn_end", from);
    expect(stream.events.slice(from).some(e => e.event.type === "permission")).toBe(false);
    expect(s.commands).toEqual(["npm run test", "npm run test -- --watch=false"]);
    stream.close();
  });
  it("a project thread's worker inherits forbid and allow, and Always allow belongs to the project", async () => {
    const s = await setup();
    await s.ada.patch(s.path, { commandRules: [{ prefix: "git push", decision: "forbid" }, { prefix: "npm test", decision: "allow" }] });
    await s.ada.patch(`${s.path}/settings`, { mode: "ask" });
    s.model.reply({ tools: [{ name: "delegate", args: { task: "Run commands", role: "worker", background: true } }] }, { text: "Started." });
    s.sub.reply(bash("git push"), bash("npm test"), bash("npm run test"), bash("npm run test -- --coverage"), { text: "Done." });
    const stream = s.ada.events(`${s.childPath}/events`);
    await s.ada.post(`${s.childPath}/messages`, { text: "Start a worker" });
    await stream.until(e => e.type === "permission");
    const p = stream.events.find(e => e.event.type === "permission")!.event as PermissionRequest;
    expect(p).toMatchObject({ alwaysAllow: "npm run test", subagent: { role: "worker" } });
    expect(JSON.stringify(s.sub.requests)).toContain("This project's rules forbid");
    expect(s.commands).toEqual(["npm test"]);
    await s.ada.post(`${s.childPath}/permissions/${p.requestId}`, { allow: true, alwaysAllow: true });
    await stream.until(e => e.type === "notice" && e.status === "finished");
    expect(stream.events.filter(e => e.event.type === "permission")).toHaveLength(1);
    expect(s.commands).toEqual(["npm test", "npm run test", "npm run test -- --coverage"]);
    expect((await s.ada.get<ThreadSummary>(s.path)).body.projectSettings!.commandRules).toContainEqual({ prefix: "npm run test", decision: "allow" });
    stream.close();
  });
  it("nested subagents keep live project rules at every depth", async () => {
    const s = await setup();
    await s.ada.patch(s.path, { commandRules: [{ prefix: "git push", decision: "forbid" }, { prefix: "npm test", decision: "allow" }] });
    await s.ada.patch(`${s.path}/settings`, { mode: "ask" });
    s.model.reply({ tools: [{ name: "delegate", args: { task: "Outer", role: "scout" } }] }, { text: "Done." });
    s.sub.respond(c => {
      const text = JSON.stringify(c.messages.filter(m => m.role === "user"));
      const results = c.messages.filter(m => m.role === "tool").length;
      if (text.includes("Inner")) return results === 0 ? bash("git push") : results === 1 ? bash("npm test") : { text: "Inner done." };
      return results === 0 ? { tools: [{ name: "delegate", args: { task: "Inner", role: "scout" } }] } : { text: "Outer done." };
    });
    const stream = s.ada.events(`${s.childPath}/events`);
    await s.ada.post(`${s.childPath}/messages`, { text: "Delegate twice" });
    await stream.until(e => e.type === "turn_end");
    expect(JSON.stringify(s.sub.requests)).toContain("This project's rules forbid");
    expect(s.commands).toEqual(["npm test"]);
    expect(stream.events.some(e => e.event.type === "permission")).toBe(false);
    stream.close();
  });

});

describe("project checks through lyricad", () => {
  it("are set on the project chat only, and run when a code thread of the project ends a turn that changed something", async () => {
    const s = await setup();
    expect((await s.ada.patch(s.path, { checks: ["npm test\nrm -rf x"] })).status).toBe(400);
    expect((await s.ada.patch(s.childPath, { checks: ["npm test"] })).status).toBe(400);
    const set = await s.ada.patch<ThreadSummary>(s.path, { checks: ["npm test", " "] });
    expect(set.body.projectSettings!.checks).toEqual(["npm test"]);
    expect((await s.ada.patch<ThreadSummary>(s.path, { threadsThinking: "high" })).body.projectSettings!.checks).toEqual(["npm test"]);
    expect((await s.ada.patch(s.path, { setup: "make\ndeps" })).status).toBe(400);
    expect((await s.ada.patch(s.childPath, { setup: "make deps" })).status).toBe(400);
    expect((await s.ada.patch<ThreadSummary>(s.path, { setup: " make deps " })).body.projectSettings!.setup).toBe("make deps");
    expect((await s.ada.patch<ThreadSummary>(s.path, { setup: null })).body.projectSettings!.setup).toBeUndefined();
    await s.ada.patch(`${s.childPath}/settings`, { code: true, mode: "auto" });
    // Code mode runs on the Coding model, the workers endpoint here.
    s.sub.respond(c => c.messages.some(m => m.role === "tool") ? { text: "Done." } : bash("echo built"));
    const stream = s.ada.events(`${s.childPath}/events`);
    await s.ada.post(`${s.childPath}/messages`, { text: "Build it" });
    await stream.until(e => e.type === "turn_end");
    stream.close();
    const notices = async () => (await s.ada.get<MessagePage>(`${s.childPath}/messages`)).body.messages.filter((m) => m.role === "notice").map((m) => m.parts[0]);
    await vi.waitFor(async () => expect(await notices()).toEqual([{ type: "delegation", text: "`npm test`", status: "checks-passed" }]));
    expect(s.runs.filter((r) => r.some((a) => a.includes("npm test")))).toEqual([["sh", "-c", "npm test 2>&1"]]);
  });
});
