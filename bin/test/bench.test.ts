import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Models, PersonaStore, Users, Workspace } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
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
  new Workspace(keyring, users).settings(tester.id).allow("general", join(host, "project"));

  const server = await fakeOpenAI({ models: [{ id: "m1" }] });
  const models = new Models(keyring, users);
  models.addEndpoint(tester, { name: "gpu", kind: "local", baseUrl: server.baseUrl });
  await models.discover(tester, "gpu");
  models.setProfile(tester.id, "cloud", "chat", { endpointId: "gpu", modelId: "m1" });
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
      { tools: [{ id: "d", name: "delegate", args: { task: "Read the README, then try to change it", tier: "cheap", readOnly: true } }] },
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
    expect(worker).toMatch(/read-only|outside this thread's folders|not writable|EROFS/i);
    expect(readFileSync(readme, "utf8")).toBe("Hello from the project\n");
  });
});
