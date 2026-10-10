import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileChanges, Users, type ExecutionTarget, type ToolOps } from "@lyrica/core";
import { recording } from "@lyrica/extension";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { applyRemoval, removalPlan, type Entry, type RemovalContext } from "../src/removal.ts";

/** Stands in for the sandbox: the same operations, on the host, in a temp folder. Paths are host paths. */
function localTarget(cwd: string): ExecutionTarget {
  const ops: ToolOps = {
    read: { readFile: (p) => readFile(p), access: async () => {}, detectImageMimeType: async () => null },
    write: { writeFile: (p, c) => writeFile(p, c), mkdir: async (d) => { mkdirSync(d, { recursive: true }); } },
    edit: { readFile: (p) => readFile(p), writeFile: (p, c) => writeFile(p, c), access: async () => {} },
    bash: {
      exec: (command, dir, { onData }) => new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], { cwd: dir });
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("close", (code) => resolve({ exitCode: code }));
      }),
    },
  };
  return { name: "sandbox", cwd: async () => cwd, ops: () => ops, folders: () => [cwd] };
}

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
  await users.authenticate("li", "pw");
  const root = mkdtempSync(join(tmpdir(), "lyrica-removal-"));
  const home = join(root, "home");
  const ws = join(root, "ws");
  mkdirSync(home);
  mkdirSync(ws);
  const changes = new FileChanges(users.openUserDb(li.id), () => home);
  const target = localTarget(ws);
  /** Runs a write through the recording wrapper, as her write tool would in tool call `call`. */
  const write = (call: string, path: string, text: string) =>
    recording(target, target.ops().write, call, (c) => changes.record("general", "web/t", c)).writeFile(path, text);
  const ctx = (removed: Entry[], extra: Partial<RemovalContext> = {}): RemovalContext => ({
    pool: "general", thread: "web/t", removed, subagents: [], pins: 0, uploadsKept: new Set(), changes, target, grants: [{ path: ws, writable: true }], ...extra,
  });
  return { home, ws, changes, target, write, ctx };
}

/** Her reply with the given tool calls, as Pi stores it. */
const reply = (n: number, ...calls: { id: string; name: string; args: unknown }[]): Entry => ({
  n, data: { type: "message", message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })) } },
});
const said = (n: number, text: string): Entry => ({ n, data: { type: "message", message: { role: "user", content: text } } });

describe("removing turns that changed files", () => {
  it("deletes what they made, puts back what they changed, and keeps what changed since", async () => {
    const { ws, write, ctx, target, changes } = await setup();
    const made = join(ws, "made.txt");
    const changed = join(ws, "changed.txt");
    const since = join(ws, "since.txt");
    writeFileSync(changed, "original\n");
    writeFileSync(since, "before\n");
    await write("c1", made, "new file");
    await write("c1", changed, "first edit");
    await write("c2", changed, "second edit");
    await write("c2", since, "hers");
    writeFileSync(since, "someone else's\n");
    await write("kept", join(ws, "other.txt"), "from a turn that stays");

    const plan = await removalPlan(ctx([reply(5, { id: "c1", name: "write", args: {} }), reply(7, { id: "c2", name: "edit", args: {} })]));
    expect(plan.files.map(({ path, action, reason, ticked }) => ({ path, action, reason, ticked }))).toEqual([
      { path: made, action: "delete", reason: undefined, ticked: true },
      { path: changed, action: "restore", reason: undefined, ticked: true },
      { path: since, action: "keep", reason: "changed since", ticked: false },
    ]);

    expect(await applyRemoval(plan, target, changes, new Set())).toEqual({ files: 2, branches: 0 });
    expect(existsSync(made)).toBe(false);
    expect(readFileSync(changed, "utf8")).toBe("original\n");
    expect(readFileSync(since, "utf8")).toBe("someone else's\n");
    expect(readFileSync(join(ws, "other.txt"), "utf8")).toBe("from a turn that stays");
    // Settled: the removed turns' records and snapshots are gone.
    expect(changes.forCalls("general", "web/t", ["c1", "c2"])).toEqual([]);
  });

  it("puts back what a file held before the earliest change, a subagent's or hers", async () => {
    const { ws, ctx, target, changes } = await setup();
    const shared = join(ws, "shared.txt");
    writeFileSync(shared, "original\n");
    // Her subagent changes it first, then she does.
    await recording(target, target.ops().write, "s1", (c) => changes.record("general", "web/sub", c)).writeFile(shared, "subagent's");
    await new Promise((r) => setTimeout(r, 5));
    await recording(target, target.ops().write, "c1", (c) => changes.record("general", "web/t", c)).writeFile(shared, "hers");
    const plan = await removalPlan(ctx([reply(3, { id: "c1", name: "write", args: {} })], { subagents: [{ thread: "web/sub", entries: [] }] }));
    await applyRemoval(plan, target, changes, new Set());
    expect(readFileSync(shared, "utf8")).toBe("original\n");
  });

    it("leaves an unticked item as it is", async () => {
    const { ws, write, ctx, target, changes } = await setup();
    const made = join(ws, "made.txt");
    await write("c1", made, "new file");
    const plan = await removalPlan(ctx([reply(3, { id: "c1", name: "write", args: {} })]));
    await applyRemoval(plan, target, changes, new Set([plan.files[0]!.id]));
    expect(readFileSync(made, "utf8")).toBe("new file");
  });

  it("puts back a file's bytes exactly, and never records one it couldn't read", async () => {
    const { ws, write, ctx, target, changes } = await setup();
    const bin = join(ws, "data.bin");
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0xc3, 0x28]);
    writeFileSync(bin, bytes);
    await write("c1", bin, "text now");
    await applyRemoval(await removalPlan(ctx([reply(2, { id: "c1", name: "write", args: {} })])), target, changes, new Set());
    expect(readFileSync(bin)).toEqual(bytes);

    // A file that exists but can't be read (a directory stands in) can't be put back, so it isn't recorded.
    const unreadable = join(ws, "dir");
    mkdirSync(unreadable);
    await write("c2", unreadable, "x").catch(() => {});
    expect(changes.forCalls("general", "web/t", ["c2"])).toEqual([]);
  });

  it("deletes uploads only the removed messages mention", async () => {
    const { ws, ctx, target, changes } = await setup();
    mkdirSync(join(ws, "uploads"));
    for (const f of ["a.png", "b.png"]) writeFileSync(join(ws, "uploads", f), f);
    const plan = await removalPlan(ctx([said(4, `see ${ws}/uploads/a.png and ${ws}/uploads/b.png, and ${ws}/uploads/gone.png`)], { uploadsKept: new Set([`${ws}/uploads/b.png`]) }));
    expect(plan.files).toEqual([{ id: expect.any(String), path: `${ws}/uploads/a.png`, action: "delete", reason: "upload", ticked: true }]);
    await applyRemoval(plan, target, changes, new Set());
    expect(readdirSync(join(ws, "uploads"))).toEqual(["b.png"]);
    // Punctuation after a path isn't part of it.
    expect((await removalPlan(ctx([said(5, `here: ${ws}/uploads/b.png.`)]))).files.map((f) => f.path)).toEqual([`${ws}/uploads/b.png`]);
  });

  it("lists branches the removed commands made: without commits ticked, with commits not", async () => {
    const { ws, ctx, target, changes } = await setup();
    const git = (...args: string[]) => execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "first");
    git("branch", "empty");
    git("checkout", "-q", "-b", "busy");
    git("commit", "-q", "--allow-empty", "-m", "work");
    git("checkout", "-q", "main");

    const removed = [reply(9,
      { id: "b1", name: "bash", args: { command: "git checkout -b empty && git checkout main" } },
      { id: "b2", name: "bash", args: { command: `cd ${ws} && git switch -c busy` } },
      { id: "b3", name: "bash", args: { command: "ls" } },
    )];
    const plan = await removalPlan(ctx(removed));
    expect(plan.branches.map(({ branch, commits, ticked }) => ({ branch, commits, ticked }))).toEqual([
      { branch: "empty", commits: false, ticked: true },
      { branch: "busy", commits: true, ticked: false },
    ]);
    expect(plan.commands).toHaveLength(3);
    expect(await applyRemoval(plan, target, changes, new Set())).toEqual({ files: 0, branches: 1 });
    expect(git("branch", "--format=%(refname:short)").toString().trim().split("\n").sort()).toEqual(["busy", "main"]);
  });

  it("says what it can't reach when the thread's home is locked", async () => {
    const { ws, write, ctx } = await setup();
    await write("c1", join(ws, "made.txt"), "x");
    const plan = await removalPlan(ctx([reply(2, { id: "c1", name: "write", args: {} })], { target: undefined }));
    expect(plan.files).toEqual([expect.objectContaining({ action: "keep", reason: "unreachable", ticked: false })]);
  });
});

describe("the sweep of change records", () => {
  it("removes records and snapshots older than its cutoff, and snapshots no record names", async () => {
    const { home, ws, write, changes } = await setup();
    writeFileSync(join(ws, "f.txt"), "old");
    await write("c1", join(ws, "f.txt"), "new");
    const stray = join(home, "snapshots", "0".repeat(32));
    writeFileSync(stray, "x");
    utimesSync(stray, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    expect(changes.sweep(new Date(Date.now() - 864e5))).toEqual({ records: 0, snapshots: 1 });
    expect(changes.sweep(new Date(Date.now() + 1000))).toEqual({ records: 1, snapshots: 0 });
    expect(readdirSync(join(home, "snapshots"))).toEqual([]);
  });
});
