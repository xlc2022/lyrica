import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Models, PersonaStore, Users, Workspace } from "@lyrica/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { openBench } from "../bench.ts";

// What `lyrica dev` runs, driven headless against a fake OpenAI-compatible
// server instead of the TUI. Like the sandbox tests, it runs only as an
// unprivileged user with bubblewrap and gocryptfs installed. Pi may run the
// tool calls in parallel, so the read can see the file before or after the edit.

const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };
const runnable = process.getuid?.() !== 0 && has("bwrap") && has("gocryptfs") && has("fusermount3");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A tester whose general folders are host/project, with chat on a fake local endpoint. */
async function setup() {
  const host = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-bench-")));
  dirs.push(host);
  mkdirSync(join(host, "project"));
  mkdirSync(join(host, "elsewhere"));
  writeFileSync(join(host, "project", "README.md"), "Hello from the project\n");
  writeFileSync(join(host, "elsewhere", "secret.txt"), "s3cr3t\n");

  const keyring = await freshKeyring();
  new PersonaStore(keyring.self()).importSeed(fileURLToPath(new URL("../../persona", import.meta.url)));
  const users = new Users(keyring);
  const tester = await users.createUser("tester", "pw", profile("Tester"), { admin: true });
  await users.authenticate("tester", "pw");
  new Workspace(keyring, users, { excludePorts: [] }).allowedPaths.allow(tester, tester.id, "general", join(host, "project"));

  const server = await fakeOpenAI({ models: [{ id: "m1" }] });
  const models = new Models(keyring, users);
  const gpu = models.addEndpoint(tester, { name: "gpu", kind: "local", baseUrl: server.baseUrl });
  const [m1] = await models.discover(tester, gpu.id);
  for (const p of ["local", "custom"] as const) models.setProfile(tester.id, p, "chat", { offeringId: m1!.id });
  models.setDefaultProfile(tester.id, "custom");
  return { host, keyring, users, tester, server, models };
}

describe.skipIf(!runnable)("lyrica dev", () => {
  it("reads, edits and runs commands in a granted folder, and is refused outside it", async () => {
    const { host, keyring, users, tester, server } = await setup();
    server.reply({ tools: [
      { id: "1", name: "read", args: { path: join(host, "project", "README.md") } },
      { id: "2", name: "edit", args: { path: join(host, "project", "README.md"), edits: [{ oldText: "Hello", newText: "Goodbye" }] } },
      { id: "3", name: "bash", args: { command: `cd ${join(host, "project")} && ls && pwd` } },
      { id: "4", name: "read", args: { path: join(host, "elsewhere", "secret.txt") } },
      { id: "5", name: "bash", args: { command: `cat ${join(host, "elsewhere", "secret.txt")}` } },
      { id: "6", name: "write", args: { path: join(host, "elsewhere", "new.txt"), content: "x" } },
    ] }, { text: "done" });
    const bench = await openBench(keyring, users, tester);
    const { session } = bench;
    try {
      await session.prompt("look at the project");
    } finally {
      await bench.close();
    }
    const results = session.messages.filter((m) => m.role === "toolResult")
      .map((m) => ({ id: m.toolCallId, error: m.isError, text: JSON.stringify(m.content) }));
    const r = (id: string) => results.find((x) => x.id === id)!;
    expect(r("1")).toMatchObject({ error: false, text: expect.stringContaining("from the project") });
    expect(r("2").error).toBe(false);
    expect(readFileSync(join(host, "project", "README.md"), "utf8")).toBe("Goodbye from the project\n");
    expect(r("3")).toMatchObject({ error: false, text: expect.stringContaining("README.md") });
    expect(r("4")).toMatchObject({ error: true, text: expect.stringContaining("outside this thread's folders") });
    expect(r("5")).toMatchObject({ error: true, text: expect.stringContaining("No such file") });
    expect(r("6")).toMatchObject({ error: true, text: expect.stringContaining("outside this thread's folders") });
    expect(JSON.stringify(results)).not.toContain("s3cr3t");
  });

  it("lets a subagent work in the thread's folders, read-only when asked", async () => {
    const { host, keyring, users, tester, server } = await setup();
    const readme = join(host, "project", "README.md");
    server.reply(
      { tools: [{ id: "d", name: "delegate", args: { task: "Read the README, then try to change it", role: "worker", readOnly: true } }] },
      { tools: [{ id: "r", name: "read", args: { path: readme } }, { id: "w", name: "write", args: { path: readme, content: "changed" } }] },
      { text: "It says hello; I couldn't change it." },
      { text: "done" },
    );
    const bench = await openBench(keyring, users, tester);
    try {
      await bench.session.prompt("ask a subagent");
    } finally {
      await bench.close();
    }
    const worker = JSON.stringify(server.requests[2]!.messages);
    expect(worker).toContain("Hello from the project");
    expect(worker).toMatch(/read-only|Read-only file system|EROFS/i);
    expect(readFileSync(readme, "utf8")).toBe("Hello from the project\n");
  });

  it("brings a background subagent's result to a later turn", async () => {
    const { keyring, users, tester, server } = await setup();
    let parentTurns = 0;
    server.respond((r) => {
      if (JSON.stringify(r.messages).includes("You are a subagent")) return { text: "The project has one README." };
      parentTurns++;
      return parentTurns === 1 ? { tools: [{ name: "delegate", args: { task: "Survey the project", role: "scout", background: true } }] } : { text: "ok" };
    });
    const bench = await openBench(keyring, users, tester);
    try {
      await bench.session.prompt("survey the project in the background");
      await vi.waitFor(() => expect(JSON.stringify(bench.session.messages)).toContain("The project has one README."), { timeout: 10_000 });
      await bench.session.prompt("what did it find?");
    } finally {
      await bench.close();
    }
    expect(JSON.stringify(server.requests.at(-1)!.messages)).toContain("The project has one README.");
  });

  it("gives two parallel writers their own git worktrees in the sandbox", async () => {
    const { host, keyring, users, tester, server } = await setup();
    const project = join(host, "project");
    const git = (...a: string[]) => execFileSync("git", ["-C", project, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    let parentTurns = 0;
    server.respond((r) => {
      const msgs = JSON.stringify(r.messages);
      if (msgs.includes("You are a subagent")) {
        if (r.messages.at(-1)!.role === "tool") return { text: "committed" };
        const tree = /worktree (\S+), branch/.exec(msgs)?.[1];
        if (!tree) return { text: "no worktree given" };
        const name = msgs.includes("note A") ? "a" : "b";
        return { tools: [{ name: "bash", args: { command: `cd ${tree} && echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=s -c user.email=s@s commit -qm ${name} && git log --oneline | wc -l` } }] };
      }
      parentTurns++;
      return parentTurns === 1 ? { tools: [{ name: "delegate", args: { tasks: [{ task: "Write note A" }, { task: "Write note B" }] } }] } : { text: "ok" };
    });
    const bench = await openBench(keyring, users, tester);
    try {
      await bench.session.prompt("write two notes at once");
    } finally {
      await bench.close();
    }
    const result = JSON.stringify(bench.session.messages.find((m) => m.role === "toolResult"));
    expect(result).not.toContain("one at a time");
    const runId = /branch lyrica\/(d-[0-9a-f]+)-1/.exec(result)![1];
    expect(git("show", "--stat", `lyrica/${runId}-1`)).toContain("a.txt");
    expect(git("show", "--stat", `lyrica/${runId}-2`)).toContain("b.txt");
    expect(existsSync(join(project, "a.txt"))).toBe(false);
  });
});
