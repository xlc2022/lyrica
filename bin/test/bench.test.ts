import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { PersonaStore, Users, Workspace } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { benchExtensions } from "../bench.ts";

// What `lyrica dev` loads, driven through a real Pi session with pi-ai's fake
// model instead of the TUI. Like the sandbox tests, it runs only as an
// unprivileged user with bubblewrap and gocryptfs installed. Pi may run the
// tool calls in parallel, so the read can see the file before or after the edit.

const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };
const runnable = process.getuid?.() !== 0 && has("bwrap") && has("gocryptfs") && has("fusermount3");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!runnable)("lyrica dev", () => {
  it("reads, edits and runs commands in a granted folder, and is refused outside it", async () => {
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

    const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: join(host, "project", "README.md") }, { id: "1" }),
        fauxToolCall("edit", { path: join(host, "project", "README.md"), edits: [{ oldText: "Hello", newText: "Goodbye" }] }, { id: "2" }),
        fauxToolCall("bash", { command: `cd ${join(host, "project")} && ls && pwd` }, { id: "3" }),
        fauxToolCall("read", { path: join(host, "elsewhere", "secret.txt") }, { id: "4" }),
        fauxToolCall("bash", { command: `cat ${join(host, "elsewhere", "secret.txt")}` }, { id: "5" }),
        fauxToolCall("write", { path: join(host, "elsewhere", "new.txt"), content: "x" }, { id: "6" }),
      ]),
      fauxAssistantMessage("done"),
    ]);
    const bench = await benchExtensions(keyring, users, tester);
    const loader = new DefaultResourceLoader({
      cwd: host, agentDir: host, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
      extensionFactories: [(pi) => pi.registerProvider(faux.provider), ...bench.factories.map((f) => f.factory)],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: host, agentDir: host, resourceLoader: loader, sessionManager: SessionManager.inMemory(host), noTools: "builtin",
    });
    await session.bindExtensions({});
    await session.setModel(faux.getModel());
    try {
      await session.prompt("look at the project");
    } finally {
      session.dispose();
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
});
