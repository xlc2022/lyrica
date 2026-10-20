import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as connectTcp, createServer, type Server } from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeWorktrees, worktreeGrants, removeWorktrees, FilesRefused, Sandbox, SandboxDenied, ThreadFiles, Users, Workspace, type Worktree, type Grant, type Network } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

// Escaping the sandbox is the main failure. These tests must run as an
// unprivileged user, because root hides permission bugs; as root they are
// skipped (see core/README.md). CI sets LYRICA_SANDBOX_TESTS=require so they
// can never be skipped there.

const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };
const root = process.getuid?.() === 0;
const runnable = !root && has("bwrap");
const homeRunnable = runnable && has("gocryptfs") && has("fusermount3") && existsSync("/dev/fuse");
if (process.env.LYRICA_SANDBOX_TESTS === "require" && !homeRunnable) {
  throw new Error(`sandbox tests required but can't run here (${root ? "running as root" : "bwrap, gocryptfs, fusermount3 or /dev/fuse missing"})`);
}

// Each test starts real sandboxes, often several at once, and a CI runner
// busy with other jobs runs them 3 to 5 times slower than an idle one.
vi.setConfig({ testTimeout: 120_000 });

// Making a file someone else owns needs root; CI's runner has passwordless sudo.
const sudo = runnable && (() => { try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (process.env.LYRICA_SANDBOX_TESTS === "require" && runnable && !sudo) throw new Error("sandbox tests required but sudo -n isn't available");

let dir: string;
let server: Server;
let port: number;
const p = (...parts: string[]) => join(dir, ...parts);

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-sandbox-")));
  for (const d of ["runtime", "work", "rw", "ro", "other-user", "outside", "swap"]) mkdirSync(p(d));
  writeFileSync(p("runtime", "self.db"), "keys");
  writeFileSync(p("other-user", "diary.txt"), "someone else's");
  writeFileSync(p("outside", "secret.txt"), "s3cr3t");
  writeFileSync(p("ro", "song.txt"), "la la la\n");
  writeFileSync(p("rw", "notes.txt"), "one\ntwo\n");
  symlinkSync(p("outside", "secret.txt"), p("rw", "abs-link"));
  symlinkSync("../outside/secret.txt", p("rw", "rel-link"));
  server = createServer((s) => s.end("hello from the host\n"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const grants = (): Grant[] => [{ path: p("rw"), writable: true }, { path: p("ro"), writable: false }];
const OFF: Network = { internet: false, services: false, hosts: [] };
// `self: []`: these tests use the host's own LAN address as a stand-in for another machine.
const box = (network: Partial<Network> = {}, extra: Grant[] = [], exclude: number[] = []) =>
  new Sandbox({ workdir: p("work"), grants: [...grants(), ...extra], network: { ...OFF, ...network }, exclude, self: [] });

async function sh(command: string, sandbox = box()): Promise<{ code: number | null; out: string }> {
  let out = "";
  const { exitCode } = await sandbox.ops().bash.exec(command, "/workspace", { onData: (d) => { out += d.toString(); } });
  return { code: exitCode, out };
}

describe("a project chat's sandbox", () => {
  // Three runs had a project chat build the whole thing in its own folder instead of starting a thread.
  it("refuses writes to its folder and /shared, and still reads them", () => {
    const chat = new Sandbox({ workdir: "/tmp/never-mounted", shared: "/tmp/never-mounted-shared", grants: [], network: OFF, self: [], readOnly: true });
    expect(() => chat.allow("/workspace/page.html", true)).toThrow(/read-only in a project chat: start a code thread/);
    expect(() => chat.allow("/shared/page.html", true)).toThrow(/read-only in a project chat/);
    expect(chat.allow("/shared/page.html", false)).toBe("/shared/page.html");
    expect(chat.allow("/workspace/notes.md", false)).toBe("/workspace/notes.md");
  });
});

describe.skipIf(!runnable)("the sandbox", () => {
  it("lets her work in her folder and her grants", async () => {
    const ops = box().ops();
    await ops.write.writeFile("/workspace/draft.md", "hello");
    expect(readFileSync(p("work", "draft.md"), "utf8")).toBe("hello");
    await ops.edit.access(p("rw", "notes.txt"));
    await ops.edit.writeFile(p("rw", "notes.txt"), "one\nthree\n");
    expect(readFileSync(p("rw", "notes.txt"), "utf8")).toBe("one\nthree\n");
    expect((await ops.read.readFile(p("ro", "song.txt"))).toString()).toBe("la la la\n");
    const r = await sh(`cat draft.md && ls ${p("ro")}`);
    expect(r).toEqual({ code: 0, out: "hellosong.txt\n" });
  });

  it("puts the gh and tea wrappers first on a run with repositories, and tea's login, with a placeholder, only on that run's /tmp", async () => {
    const git = new Sandbox({ workdir: p("work"), grants: grants(), network: OFF, self: [],
      credentials: { forge: [{ name: "ada/home", account: { kind: "forgejo", host: "forge.lan", account: "ada", token: "forge-token" } }] } });
    const r = await sh("command -v gh tea; git init -q home && git -C home remote add origin https://forge.lan/ada/home.git && cd home && "
      + "{ s=$(date +%s%N); PATH=/nowhere:$PATH timeout 10 tea >/dev/null 2>&1; echo \"TEA=$? $(( ($(date +%s%N) - s) / 1000000 ))ms\"; grep -q \"token: 'lyrica_\" /tmp/lyrica-forge/tea/config.yml && echo HAS-PLACEHOLDER; cat /tmp/lyrica-forge/tea/config.yml; }; cd .. && rm -rf home", git);
    expect(r.out).toContain("/run/lyrica/bin/gh\n/run/lyrica/bin/tea\n");
    // tea answers at once, through the relay or not at all: never the wrapper again, wherever a profile put it on PATH.
    expect(r.out).toMatch(/TEA=\d+ \d{1,4}ms\n/);
    expect(r.out).toContain("HAS-PLACEHOLDER");
    // What she sees never shows even the placeholder, and the token is nowhere in the run.
    expect(r.out).toContain("token: '[credential hidden]'");
    expect((await sh("env; echo \"$LYRICA_GIT_TOKEN_0\"; cat /run/lyrica/certs/run.pem", git)).out).not.toContain("forge-token");
    expect((await sh("ls /tmp/lyrica-forge 2>&1 || true", git)).out).toContain("No such file");
    expect((await sh("command -v gh || echo NONE")).out).not.toContain("/run/lyrica");
  });

  it("mounts the thread's own Claude Code folder outside its folder, and only for a run with Claude Code", async () => {
    mkdirSync(p("claude-own"), { recursive: true });
    const own = new Sandbox({ workdir: p("work"), grants: grants(), network: OFF, self: [], claudeDir: p("claude-own") });
    expect((await sh("echo kept > /run/lyrica/claude/notes && ls -A /workspace | grep -c claude || true", own)).out).toBe("0\n");
    expect(readFileSync(p("claude-own", "notes"), "utf8")).toBe("kept\n");
    expect((await sh("ls /run/lyrica/claude 2>&1 || true")).out).toContain("No such file");
  });

  it("mounts a project chat's own folder and /shared read-only, leaving /tmp for a command's scratch", async () => {
    mkdirSync(p("chat-shared"), { recursive: true });
    const chat = new Sandbox({ workdir: p("work"), grants: grants(), network: OFF, self: [], shared: p("chat-shared"), readOnly: true });
    const r = await sh("touch /workspace/x 2>&1; touch /shared/x 2>&1; touch /tmp/x && echo TMP-OK", chat);
    expect(r.out).toMatch(/Read-only file system[\s\S]*Read-only file system[\s\S]*TMP-OK/);
  });

  it("mounts a family's shared folder at /shared, read-write, for every thread given it", async () => {
    mkdirSync(p("family"), { recursive: true });
    mkdirSync(p("child-work"), { recursive: true });
    const parent = new Sandbox({ workdir: p("work"), grants: grants(), network: OFF, self: [], shared: p("family") });
    const child = new Sandbox({ workdir: p("child-work"), grants: [], network: OFF, self: [], shared: p("family") });
    await parent.ops().write.writeFile("/shared/page.html", "<h1>pagoda</h1>");
    expect((await child.ops().read.readFile("/shared/page.html")).toString()).toBe("<h1>pagoda</h1>");
    expect((await sh("cd /shared && cat page.html", child)).out).toBe("<h1>pagoda</h1>");
    expect((await sh("ls /shared 2>&1 || true")).out).toContain("No such file");
  });

  it("gives a run with Claude Code the wrapper and its relay, and never the token", async () => {
    const TOKEN = "sk-ant-oat01-made-up-for-tests-only";
    const seen: string[] = [];
    const upstream = createHttpServer((req, res) => { seen.push(String(req.headers.authorization)); req.resume(); res.end("ok"); });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    try {
      const claude = new Sandbox({ workdir: p("work"), grants: grants(), network: OFF, self: [], credentials: { forge: [], anthropic: TOKEN, upstreams: { "api.anthropic.com": `http://127.0.0.1:${(upstream.address() as { port: number }).port}` } } });
      const r = await sh('command -v claude; env; curl -s -H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" "$ANTHROPIC_BASE_URL/v1/messages"', claude);
      expect(r.out).toContain("/run/lyrica/bin/claude\n");
      expect(r.out).toMatch(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
      expect(r.out).not.toContain(TOKEN);
      expect(r.out.endsWith("ok")).toBe(true);
      expect(seen).toEqual([`Bearer ${TOKEN}`]);
    } finally {
      upstream.close();
    }
    expect((await sh("command -v claude || echo NONE")).out).not.toContain("/run/lyrica");
  });

  it("closes a run's Claude Code relay when the run is stopped", async () => {
    const claude = new Sandbox({ workdir: p("work"), grants: grants(), network: OFF, self: [], credentials: { forge: [], anthropic: "sk-ant-oat01-made-up-for-tests-only", upstreams: { "api.anthropic.com": "http://127.0.0.1:9" } } });
    const stop = new AbortController();
    let out = "";
    const done = claude.ops().bash.exec('echo "$ANTHROPIC_BASE_URL"; sleep 30', "/workspace", {
      signal: stop.signal, onData: (d) => { out += d.toString(); if (out.includes("\n")) stop.abort(); },
    }).catch(() => undefined);
    await done;
    const base = out.trim();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await new Promise((r) => setTimeout(r, 200));
    await expect(fetch(`${base}/v1/messages`, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("mounts a thread's clones at /workspace/repos, read-only for a read-only subagent", async () => {
    mkdirSync(p("clones", "lyrica"), { recursive: true });
    writeFileSync(p("clones", "lyrica", "README.md"), "hello\n");
    const clones = (reposReadOnly?: boolean) => new Sandbox({ workdir: p("work"), grants: [], network: OFF, self: [], repos: p("clones"), reposReadOnly });
    expect((await sh("cat repos/lyrica/README.md && echo more >> repos/lyrica/README.md", clones())).code).toBe(0);
    const r = await sh("echo x >> repos/lyrica/README.md; touch repos/new", clones(true));
    expect(r.out).toContain("Read-only file system");
    expect(readFileSync(p("clones", "lyrica", "README.md"), "utf8")).toBe("hello\nmore\n");
    expect(readdirSync(p("clones"))).toEqual(["lyrica"]);
  });

  it("hides lyricad's runtime directory, other users' files and everything else on the host", async () => {
    for (const path of [p("runtime"), p("other-user"), p("outside"), "/home", "/root", "/var", "/etc/shadow"]) {
      const r = await sh(`ls -a ${path}`);
      expect(r.code, path).not.toBe(0);
      expect(r.out).toContain("No such file or directory");
    }
    const top = (await sh("ls /")).out.split("\n");
    expect(top).toContain("workspace");
    for (const d of ["home", "root", "var", "srv", "opt", "run", "mnt", "boot"]) expect(top).not.toContain(d);
  });

  it("can't see or signal lyricad's process", async () => {
    process.env.LYRICA_TEST_SECRET = "in lyricad's environment";
    const r = await sh(`cat /proc/[0-9]*/cmdline | tr '\\0' ' '; echo; env; kill -0 ${process.pid} && echo AL""IVE`);
    delete process.env.LYRICA_TEST_SECRET;
    // Not /node/: on NixOS the sandbox's own bwrap lists Node's store path among its mounts.
    expect(r.out).not.toContain("vitest");
    expect(r.out).not.toContain(process.execPath);
    expect(r.out).not.toContain("LYRICA_TEST_SECRET");
    expect(r.out).not.toContain("ALIVE");
    expect((await sh("ls /proc | grep -c '^[0-9]'")).out.trim()).toMatch(/^[1-5]$/);
  });

  it("isolates project worktrees with unique paths in shared git metadata", async () => {
    const repo = p("project-repo"); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.name=Example", "-c", "user.email=example@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial");
    const initial = [{ path: repo, writable: true }];
    const threads = ["part-a", "part-b"].map((id) => {
      const workdir = p(id); mkdirSync(workdir);
      const workdirAlias = `/thread-workspaces/${id}`;
      return { workdir, workdirAlias, grants: initial, network: OFF, self: [] };
    });
    const worktrees: Worktree[][] = [];
    for (const [i, spec] of threads.entries()) {
      const target = new Sandbox(spec);
      const made = await makeWorktrees(target, initial, `part-${i}`, 1, undefined,
        { branch: `lyrica/project/part-${i}`, directory: `${await target.worktreeRoot()}/worktrees` });
      expect(typeof made).not.toBe("string");
      if (typeof made === "string") throw new Error(made);
      worktrees.push(made[0]!);
    }
    const boxes = threads.map((spec, i) => new Sandbox({ ...spec, grants: worktreeGrants(initial, worktrees[i]!, true) }));
    const a = worktrees[0]![0]!; const b = worktrees[1]![0]!;
    await boxes[0]!.ops().write.writeFile(`${a.path}/physics.ts`, "export const speed = 1;\n");
    expect((await sh(`test ! -e ${b.path}/physics.ts`, boxes[1])).code).toBe(0);
    expect((await sh(`echo unsafe > ${repo}/unsafe.ts`, boxes[0])).code).not.toBe(0);
    expect((await sh(`git -C ${a.path} add . && git -c user.name=Example -c user.email=example@example.invalid -C ${a.path} commit -qm physics`, boxes[0])).code).toBe(0);
    expect(git("worktree", "list")).toContain(a.path);
    expect(git("worktree", "list")).toContain(b.path);
    await removeWorktrees(boxes[0]!, worktrees[0]!);
    expect(existsSync(join(threads[0]!.workdir, "worktrees", "project-repo"))).toBe(false);
    expect(git("branch", "--list", a.branch)).toContain(a.branch);
    expect(existsSync(join(threads[1]!.workdir, "worktrees", "project-repo"))).toBe(true);
    await removeWorktrees(boxes[1]!, worktrees[1]!);
  });

  it("can't write to a read-only grant", async () => {
    const r = await sh(`echo x > ${p("ro", "song.txt")}; touch ${p("ro", "new")}; rm ${p("ro", "song.txt")}`);
    expect(r.out).toContain("Read-only file system");
    expect(readFileSync(p("ro", "song.txt"), "utf8")).toBe("la la la\n");
    expect(readdirSync(p("ro"))).toEqual(["song.txt"]);
    await expect(box().ops().write.writeFile(p("ro", "song.txt"), "x")).rejects.toThrow(SandboxDenied);
    await expect(box().ops().edit.access(p("ro", "song.txt"))).rejects.toThrow(/read-only/);
  });

  it("can't leave the grants through .., symlinks or absolute paths", async () => {
    const ops = box().ops();
    // Path checks refuse these outright.
    for (const path of [p("rw", "..", "outside", "secret.txt"), "/workspace/../etc/passwd", p("runtime", "self.db"), "/etc/shadow"]) {
      await expect(ops.read.readFile(path), path).rejects.toThrow(SandboxDenied);
    }
    // Symlinks pass the path check, but resolve inside the sandbox, where the target doesn't exist.
    for (const link of ["abs-link", "rel-link"]) {
      await expect(ops.read.readFile(p("rw", link))).rejects.toThrow(/No such file/);
      await expect(ops.write.writeFile(p("rw", link), "overwritten")).rejects.toThrow(/is a symlink/);
    }
    // And commands, which skip the checks, are confined by the mounts alone.
    const r = await sh(`cat ${p("rw", "..", "outside", "secret.txt")} ${p("rw", "abs-link")} rw-link 2>&1; cd ${p("rw")}/../.. && ls`);
    expect(r.out).not.toContain("s3cr3t");
    expect(readFileSync(p("outside", "secret.txt"), "utf8")).toBe("s3cr3t");
    // A symlink she makes in her own folder resolves inside the sandbox too.
    await sh(`ln -s ${p("outside")} /workspace/out`);
    await expect(ops.read.readFile("/workspace/out/secret.txt")).rejects.toThrow(/No such file/);
  });

  it("refuses to mount a grant that has been swapped for a symlink", async () => {
    const swap: Grant = { path: p("swap"), writable: true };
    rmSync(p("swap"), { recursive: true });
    symlinkSync(p("outside"), p("swap"));
    await expect(sh("ls", box({}, [swap]))).rejects.toThrow(/O_NOFOLLOW|ELOOP|ENOTDIR|resolves to/);
    // A symlink earlier in the path is caught too: the opened folder isn't where the grant says.
    mkdirSync(p("outside", "sub"));
    symlinkSync(p("outside"), p("via"));
    await expect(sh("ls", box({}, [{ path: p("via", "sub"), writable: true }]))).rejects.toThrow(/resolves to/);
  });

  it("has no network when it's off, and the host's when it's on", async () => {
    const tries = [
      `curl -sS --max-time 3 http://127.0.0.1:${port}/`,
      `curl -sS --max-time 3 http://1.1.1.1/`,
      `exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3`,
      `exec 3<>/dev/tcp/1.1.1.1/53 && echo REACHED`,
      `python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP); s.sendto(b'x', ('1.1.1.1', 0)); print('RE' + 'ACHED')"`,
    ];
    for (const t of tries) {
      if (/^(curl|python3)/.test(t) && !has(t.split(" ")[0]!)) continue;
      const r = await sh(t);
      expect(r.code, t).not.toBe(0);
      expect(r.out, t).not.toMatch(/hello from the host|REACHED/);
    }
    expect((await sh("cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' '")).out.trim()).toBe("lo");
  });

  it("writes in place, keeping the owner, when the folder won't take a temp file", async () => {
    mkdirSync(p("rw", "locked"));
    writeFileSync(p("rw", "locked", "f.txt"), "old");
    const inode = statSync(p("rw", "locked", "f.txt")).ino;
    chmodSync(p("rw", "locked"), 0o555);
    try {
      await box().ops().write.writeFile(p("rw", "locked", "f.txt"), "new");
      expect(readFileSync(p("rw", "locked", "f.txt"), "utf8")).toBe("new");
      expect(statSync(p("rw", "locked", "f.txt")).ino).toBe(inode);
    } finally {
      chmodSync(p("rw", "locked"), 0o755);
    }
  });

  it.skipIf(!sudo)("writes in place a file someone else owns, so it keeps its owner", async () => {
    const file = p("rw", "theirs.txt");
    writeFileSync(file, "old", { mode: 0o666 });
    chmodSync(file, 0o666);
    execFileSync("sudo", ["-n", "chown", "0:0", file]);
    await box().ops().write.writeFile(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).uid).toBe(0);
    expect(readdirSync(p("rw")).filter((f) => f.startsWith(".theirs.txt."))).toEqual([]);
  });

  it("writes atomically: parallel reads see the old file or the new one, never a partial one", async () => {
    const ops = box().ops();
    const file = p("rw", "big.txt");
    const versions = ["a", "b", "c", "d"].map((c) => c.repeat(4 * 1024 * 1024));
    writeFileSync(file, versions[0]!);
    chmodSync(file, 0o640);
    const writes = versions.slice(1).map((v) => ops.write.writeFile(file, v));
    const reads = Array.from({ length: 24 }, () => ops.read.readFile(file).then((b) => b.toString()));
    const seen = await Promise.all(reads);
    await Promise.all(writes);
    for (const text of seen) expect(versions.includes(text), `read ${text.length} bytes starting ${JSON.stringify(text.slice(0, 1))}`).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(p("rw")).filter((f) => f.startsWith(".big.txt."))).toEqual([]);
    await ops.write.writeFile(p("rw", "new.txt"), "fresh");
    expect(statSync(p("rw", "new.txt")).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("keeps long output under Pi's limits, so Pi writes no temp file", async () => {
    const r = await sh("seq 1 200000");
    expect(Buffer.byteLength(r.out)).toBeLessThan(50 * 1024);
    expect(r.out.split("\n").length).toBeLessThan(2000);
    expect(r.out).toContain("bytes of output left out");
    expect(r.out.trimEnd().endsWith("200000")).toBe(true);
  });
});

// On NixOS (the CI nix job sets these): only the closure is in /nix/store.
const nixTools = process.env.LYRICA_SANDBOX_TOOLS;
describe.skipIf(!runnable)("the Files panel", () => {
  const notes: [string, string[]][] = [];
  const origins: [string, ...string[]][] = [];
  const files = () => new ThreadFiles(box(), grants(), (kind, names) => notes.push([kind, names]), undefined, {
    added: (ps) => origins.push(["added", ...ps]), moved: (from, to) => origins.push(["moved", from, to]), removed: (ps) => origins.push(["removed", ...ps]),
  });

  it("lists one folder at a time, folders first, and searches names under a root", async () => {
    mkdirSync(p("work", "notes"), { recursive: true });
    writeFileSync(p("work", "notes", "plan.md"), "# plan");
    writeFileSync(p("work", "zebra.txt"), "z");
    mkdirSync(p("work", ".lyrica", "thumbs"), { recursive: true });
    const f = files();
    expect(f.roots()).toEqual([{ path: "/workspace", writable: true, kind: "thread" }, { path: p("rw"), writable: true, kind: "grant" }, { path: p("ro"), writable: false, kind: "grant" }]);
    const top = await f.list("/workspace");
    expect(top.more).toBe(false);
    expect(top.entries.map((e) => [e.name, e.kind])).toEqual(expect.arrayContaining([["notes", "folder"], ["zebra.txt", "file"]]));
    expect(top.entries[0]!.kind).toBe("folder");
    expect(top.entries.map((e) => e.name)).not.toContain(".lyrica");
    expect(top.entries.find((e) => e.name === "zebra.txt")).toMatchObject({ path: "/workspace/zebra.txt", size: 1 });
    expect((await f.list(p("ro"))).entries.map((e) => e.name)).toEqual(["song.txt"]);
    const hits = await f.search("/workspace", "PLA");
    expect(hits.entries.map((e) => e.path)).toEqual(["/workspace/notes/plan.md"]);
    await expect(f.list("/etc")).rejects.toThrow(FilesRefused);
    await expect(f.list(p("rw", "..", "outside"))).rejects.toThrow(FilesRefused);
  });

  it("serves a file by its bytes, and follows no symlink out", async () => {
    const f = files();
    const { stream, size, type } = await f.read(p("ro", "song.txt"));
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    expect([Buffer.concat(chunks).toString(), size, type]).toEqual(["la la la\n", 9, "text/plain; charset=utf-8"]);
    await expect(f.read(p("rw", "abs-link"))).rejects.toThrow();
    await expect(f.read(p("outside", "secret.txt"))).rejects.toThrow(FilesRefused);
    await expect(f.read("/workspace/notes")).rejects.toThrow(/not a file/);
  });

  it("uploads under a free name, makes folders, renames and deletes, and refuses a read-only grant, the roots and escapes", async () => {
    notes.length = 0;
    origins.length = 0;
    const f = files();
    expect(await f.upload("/workspace/notes", "../../etc/x.txt", Buffer.from("one"))).toBe("/workspace/notes/x.txt");
    expect(await f.upload("/workspace/notes", "x.txt", Buffer.from("two"))).toBe("/workspace/notes/x-2.txt");
    expect(readFileSync(p("work", "notes", "x-2.txt"), "utf8")).toBe("two");
    await f.mkdir("/workspace/pout");
    await f.rename("/workspace/notes/x-2.txt", "/workspace/pout/y.txt");
    expect(readFileSync(p("work", "pout", "y.txt"), "utf8")).toBe("two");
    await expect(f.rename("/workspace/notes/x.txt", "/workspace/pout/y.txt")).rejects.toThrow(/already there/);
    await f.remove(["/workspace/pout", "/workspace/notes/x.txt"]);
    expect(readdirSync(p("work"))).not.toContain("pout");
    expect(readdirSync(p("work", "notes"))).toEqual(["plan.md"]);
    expect(notes).toEqual([
      ["added", ["/workspace/notes/x.txt"]], ["added", ["/workspace/notes/x-2.txt"]], ["added", ["/workspace/pout"]],
      ["removed", ["/workspace/notes/x-2.txt"]], ["added", ["/workspace/pout/y.txt"]], ["removed", ["/workspace/pout", "/workspace/notes/x.txt"]],
    ]);
    // The record of which thread wrote a file hears of uploads, the rename and the delete, never of a new folder.
    expect(origins).toEqual([
      ["added", "/workspace/notes/x.txt"], ["added", "/workspace/notes/x-2.txt"], ["moved", "/workspace/notes/x-2.txt", "/workspace/pout/y.txt"],
      ["removed", "/workspace/pout", "/workspace/notes/x.txt"],
    ]);
    for (const call of [
      () => f.upload(p("ro"), "new.txt", Buffer.from("x")), () => f.mkdir(p("ro", "d")), () => f.rename(p("ro", "song.txt"), p("ro", "hymn.txt")),
      () => f.remove([p("ro", "song.txt")]), () => f.remove(["/workspace"]), () => f.rename(p("rw"), p("rw", "..", "moved")),
      () => f.upload("/workspace/../etc", "x", Buffer.from("x")), () => f.remove([p("outside", "secret.txt")]), () => f.mkdir("/workspace/.lyrica"),
    ]) await expect(call()).rejects.toThrow(FilesRefused);
    expect(readdirSync(p("ro"))).toEqual(["song.txt"]);
    expect(readFileSync(p("outside", "secret.txt"), "utf8")).toBe("s3cr3t");
  });

  it("keeps a name with a tab or a newline whole, in a listing and in a zip", async () => {
    const f = files();
    mkdirSync(p("work", "odd"));
    writeFileSync(p("work", "odd", "a\tb.txt"), "tab");
    writeFileSync(p("work", "odd", "c\nd.txt"), "newline");
    const { entries } = await f.list("/workspace/odd");
    expect(entries.map((e) => [e.name, e.size])).toEqual([["a\tb.txt", 3], ["c\nd.txt", 7]]);
    expect((await f.search("/workspace", "b.txt")).entries.map((e) => e.path)).toEqual(["/workspace/odd/a\tb.txt"]);
    const chunks: Buffer[] = [];
    for await (const c of await f.zip(["/workspace/odd"])) chunks.push(c as Buffer);
    const zip = Buffer.concat(chunks).toString("latin1");
    expect(zip).toContain("odd/a\tb.txttab");
    expect(zip).toContain("odd/c\nd.txtnewline");
    await f.remove(["/workspace/odd"]);
  });

  it("zips files and folders as it streams, with nothing written to disk", async () => {
    const f = files();
    const before = readdirSync(p("work"));
    const chunks: Buffer[] = [];
    for await (const c of await f.zip(["/workspace/notes", p("ro", "song.txt")])) chunks.push(c as Buffer);
    const zip = Buffer.concat(chunks);
    expect(readdirSync(p("work"))).toEqual(before);
    const names = [...zip.toString("latin1").matchAll(/PK\x01\x02[\s\S]{42}([^\x00]+?)(?=PK)/g)].map((m) => m[1]);
    expect(names).toEqual(["notes/plan.md", "song.txt"]);
    await expect(f.zip([p("outside")])).rejects.toThrow(FilesRefused);
  });
});

describe.skipIf(!runnable || !nixTools)("the sandbox with the NixOS tools", () => {
  it("sees only the closure's store paths, never the rest of the store", async () => {
    const closure = readFileSync(process.env.LYRICA_SANDBOX_CLOSURE!, "utf8").split("\n").filter(Boolean);
    // Into a file: the listing is longer than the output a command may show.
    expect((await sh("ls /nix/store > /workspace/store.txt")).code).toBe(0);
    expect(readFileSync(p("work", "store.txt"), "utf8").split("\n").filter(Boolean).sort()).toEqual(closure.map((c) => c.slice("/nix/store/".length)).sort());
    // The closure file's own store path isn't in the closure.
    const own = process.env.LYRICA_SANDBOX_CLOSURE!.split("/").slice(0, 4).join("/");
    expect((await sh(`ls ${own}`)).code).not.toBe(0);
    expect((await sh("ls /usr/bin/bash")).code).toBe(0);
  });

  it("refuses tools outside /nix/store", async () => {
    process.env.LYRICA_SANDBOX_TOOLS = "/usr";
    try {
      await expect(sh("true")).rejects.toThrow(SandboxDenied);
    } finally {
      process.env.LYRICA_SANDBOX_TOOLS = nixTools;
    }
  });
});

// Her screenshots (web/e2e/shot.ts) need a headless Chromium in the sandbox's
// /usr: the NixOS tools' chromium, or the one install.sh links. Skipped where
// neither is installed.
const chromium = nixTools ? `${nixTools}/bin/chromium` : ["/usr/local/bin/chromium-headless-shell", "/usr/bin/chromium"].find((f) => existsSync(f));
describe.skipIf(!runnable || !chromium || !existsSync(chromium))("a browser in the sandbox", () => {
  it("renders a page to PNG with internet off", async () => {
    writeFileSync(p("work", "page.html"), "<p style='font: 32px sans-serif'>Hello</p>");
    const bin = nixTools ? "/usr/bin/chromium" : chromium;
    const r = await sh(`${bin} --headless --no-sandbox --disable-gpu --window-size=320,200 --screenshot=/workspace/page.png file:///workspace/page.html`);
    expect(r.code).toBe(0);
    expect(readFileSync(p("work", "page.png")).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

describe.skipIf(!homeRunnable)("the home workspace", () => {
  it("is encrypted on disk and readable only while mounted", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const thread = { userId: ada.id, pool: "general" as const, threadId: "t1" };
    try {
      await workspace.mountHome(ada.id);
      expect(await workspace.saveUpload(thread, "letter.txt", Buffer.from("Dear Ada, a secret plan"))).toBe("/workspace/uploads/letter.txt");
      // An image upload gets a random name, so pasted screenshots (all "image.png") never collide (docs/briefs/chat-view.md).
      expect(await workspace.saveUpload(thread, "image.png", Buffer.from("not really a png"))).toMatch(/^\/workspace\/uploads\/[0-9a-f]{12}\.png$/);
      const ops = workspace.targetFor(thread).ops();
      expect((await ops.read.readFile("/workspace/uploads/letter.txt")).toString()).toBe("Dear Ada, a secret plan");

      const cipher = join(users.userDir(ada.id), "home.crypt");
      const all = execFileSync("sh", ["-c", `find ${cipher} -type f -exec cat {} +; find ${cipher}`]).toString("latin1");
      expect(all).not.toContain("secret plan");
      expect(all).not.toContain("letter");
      expect(all).not.toContain("uploads");
    } finally {
      await workspace.unmountHome(ada.id);
    }
    expect(readdirSync(workspace.homeDir(ada.id))).toEqual([]);
    expect(() => workspace.targetFor(thread)).toThrow(/not mounted/);

    // Mounting again with the same key brings the files back.
    await workspace.mountHome(ada.id);
    try {
      expect((await workspace.targetFor(thread).ops().read.readFile("/workspace/uploads/letter.txt")).toString()).toContain("secret plan");
    } finally {
      await workspace.unmountHome(ada.id);
    }
  });
});

describe.skipIf(!homeRunnable)("a project chat's uploads", () => {
  it("land in its shared folder, which its threads read at /shared", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const chat = { userId: ada.id, pool: "general" as const, threadId: "p1", coordinates: true };
    try {
      await workspace.mountHome(ada.id);
      workspace.settings(ada.id).inheritSettings("p1", "c1", "general");
      const path = await workspace.saveUpload(chat, "mockup.txt", Buffer.from("a header and three cards"));
      expect(path).toBe("/workspace/shared/uploads/mockup.txt");
      expect((await workspace.targetFor(chat).ops().read.readFile(path)).toString()).toBe("a header and three cards");
      const code = workspace.targetFor({ userId: ada.id, pool: "general", threadId: "c1" }).ops();
      expect((await code.read.readFile("/shared/uploads/mockup.txt")).toString()).toBe("a header and three cards");
    } finally {
      await workspace.unmountHome(ada.id);
    }
  });
});

describe.skipIf(!homeRunnable)("a running child thread's folders", () => {
  it("narrow with its parent's: its Files panel and its next sandbox run lose what the parent lost", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    for (const d of ["rw", "ro"]) workspace.allowedPaths.allow(ada, ada.id, "general", p(d));
    const settings = workspace.settings(ada.id);
    const child = { userId: ada.id, pool: "general" as const, threadId: "child" };
    settings.setThread("parent", "general", { grants: [{ path: p("rw"), writable: true }, { path: p("ro"), writable: false }] });
    settings.inheritSettings("parent", "child", "general");
    const file = p("rw", "child-thread.txt");
    writeFileSync(file, "kept\n");
    await workspace.mountHome(ada.id);
    try {
      const roots = () => workspace.files(child).roots().map((r) => `${r.path} ${r.writable ? "rw" : "ro"}`);
      expect(roots()).toEqual(["/workspace rw", `${p("rw")} rw`, `${p("ro")} ro`]);
      expect((await sh(`cat ${file}`, workspace.targetFor(child) as Sandbox)).out).toContain("kept");

      // Read-only in the parent: the child's next run can read the folder and not write it.
      settings.setThread("parent", "general", { grants: [{ path: p("rw"), writable: false }, { path: p("ro"), writable: false }] });
      expect(roots()).toContain(`${p("rw")} ro`);
      const wrote = await sh(`echo three >> ${file}`, workspace.targetFor(child) as Sandbox);
      expect(wrote.code).not.toBe(0);
      expect(readFileSync(file, "utf8")).toBe("kept\n");

      // Taken off the parent: gone from the child's panel and its next run, refused as outside its folders.
      settings.setThread("parent", "general", { grants: [{ path: p("ro"), writable: false }] });
      expect(roots()).toEqual(["/workspace rw", `${p("ro")} ro`]);
      const ops = workspace.targetFor(child).ops();
      await expect(ops.read.readFile(file)).rejects.toThrow(/outside this thread's folders/);
      expect((await sh(`cat ${file}`, workspace.targetFor(child) as Sandbox)).out).not.toContain("kept");
      expect(workspace.folders(child)).toEqual([p("ro")]);
    } finally {
      await workspace.unmountHome(ada.id);
    }
  });
});

describe.skipIf(!homeRunnable)("a project chat's folders", () => {
  it("are read-only to it, and writable to the thread it starts", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    workspace.allowedPaths.allow(ada, ada.id, "general", p("rw"));
    const settings = workspace.settings(ada.id);
    settings.setThread("chat", "general", { grants: [{ path: p("rw"), writable: true }] });
    settings.inheritSettings("chat", "part", "general");
    const chat = { userId: ada.id, pool: "general" as const, threadId: "chat", coordinates: true };
    const part = { userId: ada.id, pool: "general" as const, threadId: "part" };
    const file = p("rw", "project-chat.txt");
    writeFileSync(file, "kept\n");
    await workspace.mountHome(ada.id);
    try {
      expect(workspace.forThread(chat).settings().grants).toEqual([{ path: p("rw"), writable: false }]);
      const ran = await sh(`cat ${file}; echo chat >> ${file}`, workspace.targetFor(chat) as Sandbox);
      expect(ran.out).toContain("kept");
      expect(ran.code).not.toBe(0);
      expect((await sh(`echo part >> ${file}`, workspace.targetFor(part) as Sandbox)).code).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("kept\npart\n");
    } finally {
      await workspace.unmountHome(ada.id);
    }
  });
});

describe.skipIf(!homeRunnable)("a thread's clones", () => {
  it("are its own: a project's thread works in the project's folder but sees only its own repos/, and they go with its folder", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const settings = workspace.settings(ada.id);
    settings.inheritSettings("project", "thread", "general");
    const project = { userId: ada.id, pool: "general" as const, threadId: "project" };
    const thread = { ...project, threadId: "thread" };
    await workspace.mountHome(ada.id);
    try {
      await sh("mkdir -p repos/lyrica && echo project > repos/lyrica/who && echo shared > notes.txt", workspace.targetFor(project) as Sandbox);
      const seen = await sh("cat notes.txt; ls repos; mkdir -p repos/lyrica && echo thread > repos/lyrica/who", workspace.targetFor(thread) as Sandbox);
      expect(seen.out).toBe("shared\n");
      expect((await sh("cat repos/lyrica/who", workspace.targetFor(project) as Sandbox)).out).toBe("project\n");
      expect(workspace.reposDir(thread)).toBe(join(workspace.homeDir(ada.id), "threads", "thread", "repos"));
      expect(readFileSync(join(workspace.reposDir(thread), "lyrica", "who"), "utf8")).toBe("thread\n");
    } finally {
      await workspace.unmountHome(ada.id);
    }
  });
});

// The host's own LAN address stands in for a machine on the network: the
// sandbox has an address of its own, so the host is just another peer to it.
const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
const netRunnable = runnable && has("pasta") && has("nft") && existsSync("/dev/net/tun");
if (process.env.LYRICA_SANDBOX_TESTS === "require" && (!netRunnable || !lan)) throw new Error("network tests required but pasta, nft, /dev/net/tun or a LAN address is missing");

describe.skipIf(!netRunnable || !lan)("a sandbox's network switches", () => {
  const servers: Server[] = [];
  const listen = async (host: string, reply: string) => {
    const srv = createServer((c) => c.end(`${reply}\n`));
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, host, resolve));
    return (srv.address() as { port: number }).port;
  };
  let peer: number, peerOther: number, lyricad: number, abstract: string;
  beforeAll(async () => {
    peer = await listen(lan!, "PEER");
    peerOther = await listen(lan!, "OTHER");
    lyricad = await listen("0.0.0.0", "LYRICAD"); // reachable on loopback and the LAN address alike
    abstract = `lyrica-test-${process.pid}`;
    const srv = createServer((c) => c.end("ABSTRACT\n"));
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(`\0${abstract}`, resolve));
  });
  afterAll(() => { for (const s of servers) s.close(); });

  const tcp = (host: string, port: number) => `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port} && cat <&3'`;
  const reach = async (net: Partial<Network>, host: string, port: number, exclude: number[] = []) =>
    (await sh(tcp(host, port), box(net, [], exclude))).out;

  it("gives git a placeholder for a repository's token, and the run's relay swaps in the token for that repository only", async () => {
    const token = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";
    const seen: string[] = [];
    const github = createHttpServer((req, res) => {
      req.resume();
      if (!req.headers.authorization) return res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end();
      seen.push(`${req.url} ${req.headers.authorization}`);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
    try {
      const sandbox = new Sandbox({ workdir: p("work"), grants: grants(), network: { ...OFF, internet: true }, self: [], credentials: {
        forge: [{ name: "xlc2022/lyrica", account: { kind: "github", host: "github.com", account: "lyrica-bot", token } }],
        upstreams: { "github.com": `http://127.0.0.1:${(github.address() as { port: number }).port}` },
      } });
      const fill = (path: string) => `printf 'protocol=https\\nhost=github.com\\npath=${path}\\n\\n' | git credential fill 2>&1`;
      const r = await sh(`printenv GH_TOKEN || echo NONE; ${fill("xlc2022/lyrica.git")}; ${fill("xlc2022/other.git")}; git ls-remote https://github.com/xlc2022/lyrica.git 2>&1; env`, sandbox);
      expect(r.out).toContain("NONE\nprotocol=https\nhost=github.com\npath=xlc2022/lyrica.git\nusername=lyrica-bot\npassword=[credential hidden]\n");
      expect(r.out).toContain("could not read Username for 'https://github.com/xlc2022/other.git'");
      expect(r.out).not.toContain(token);
      expect(seen).toEqual([`/xlc2022/lyrica.git/info/refs?service=git-upload-pack Basic ${Buffer.from(`lyrica-bot:${token}`).toString("base64")}`]);
    } finally {
      github.close();
    }
    expect((await sh("printenv LYRICA_GIT_TOKEN_0 || echo NONE", box({ internet: true }))).out).toBe("NONE\n");
  });

  it("with internet only, reaches the network but not this machine's loopback", async () => {
    expect(await reach({ internet: true }, lan!, peer)).toContain("PEER");
    expect(await reach({ internet: true }, "127.0.0.1", port)).not.toContain("hello from the host");
    expect((await sh("cat /etc/resolv.conf", box({ internet: true }))).out).toMatch(/^nameserver /m);
  });

  it("with this machine's services only, reaches its loopback but nothing else", async () => {
    expect(await reach({ services: true }, "127.0.0.1", port)).toContain("hello from the host");
    expect(await reach({ services: true }, lan!, peer)).not.toContain("PEER");
    expect((await sh("cat /etc/resolv.conf", box({ services: true }))).out.trim()).toBe("");
  });

  it("never reaches lyricad's ports, on any address, whatever the switches say", async () => {
    const all = { internet: true, services: true };
    expect(await reach(all, "127.0.0.1", port, [lyricad])).toContain("hello from the host");
    expect(await reach(all, "127.0.0.1", lyricad, [lyricad])).not.toContain("LYRICAD");
    expect(await reach(all, lan!, lyricad, [lyricad])).not.toContain("LYRICAD");
    expect(await reach({ hosts: [`${lan}:${lyricad}`, lan!] }, lan!, lyricad, [lyricad])).not.toContain("LYRICAD");
    expect(await reach(all, lan!, lyricad)).toContain("LYRICAD"); // the control: only the exclusion stops it
  });

  it("counts this machine's own addresses as this machine, and never reaches its front door there", async () => {
    // The real host addresses this time: the LAN address is this machine, not a peer.
    const real = (net: Partial<Network>) => new Sandbox({ workdir: p("work"), grants: [], network: { ...OFF, ...net }, front: [lyricad] });
    const at = async (net: Partial<Network>, port: number) => (await sh(tcp(lan!, port), real(net))).out;
    expect(await at({ internet: true }, peer)).not.toContain("PEER");
    expect(await at({ hosts: [lan!] }, peer)).not.toContain("PEER");
    expect(await at({ internet: true, services: true }, peer)).toContain("PEER");
    // The front port (Caddy, in front of lyricad) stays shut on this machine's addresses, whatever the switches say.
    expect(await at({ internet: true, services: true, hosts: [lan!] }, lyricad)).not.toContain("LYRICAD");
  });

  it("never reaches the front door on an external proxy's address or Lyrica's name", async () => {
    // The LAN address stands in for another machine running the proxy (self: []), listed as a front-door host.
    // Names go through resolveAddresses (core/test/workspace.test.ts).
    const proxied = new Sandbox({ workdir: p("work"), grants: [], network: { ...OFF, internet: true }, self: [], front: [lyricad], frontHosts: [lan!] });
    expect((await sh(tcp(lan!, lyricad), proxied)).out).not.toContain("LYRICAD");
    expect((await sh(tcp(lan!, peer), proxied)).out).toContain("PEER");
  });

  it("never reaches the host's abstract sockets", async () => {
    const connect = `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('\\0${abstract}'); print(s.recv(99))"`;
    for (const net of [{}, { internet: true }, { services: true }, { internet: true, services: true }, { hosts: [lan!] }]) {
      expect((await sh(connect, box(net))).out, JSON.stringify(net)).not.toContain("ABSTRACT");
    }
  });

  it("with internet off, reaches a listed host and port and nothing else", async () => {
    const net = { hosts: [`${lan}:${peer}`] };
    expect(await reach(net, lan!, peer)).toContain("PEER");
    expect(await reach(net, lan!, peerOther)).not.toContain("OTHER");
    expect(await reach(net, "127.0.0.1", port)).not.toContain("hello from the host");
    expect(await reach({ hosts: [lan!] }, lan!, peerOther)).toContain("OTHER");
  });

  it("pins a listed hostname in /etc/hosts and gives no DNS", async () => {
    const pinned = await lookup("github.com").catch(() => undefined);
    if (!pinned) return; // no DNS where the tests run
    const r = await sh(`getent hosts github.com; getent hosts example.com || echo NO-DNS; timeout 5 bash -c 'exec 3<>/dev/tcp/github.com/443' && echo HTTPS-OK`,
      box({ hosts: ["https://github.com"] }));
    expect(r.out).toMatch(/^\S+\s+github\.com$/m);
    expect(r.out).toContain("NO-DNS");
    if (await new Promise((resolve) => { const c = connectTcp(443, pinned.address, () => { c.end(); resolve(true); }); c.on("error", () => resolve(false)); })) {
      expect(r.out).toContain("HTTPS-OK");
    }
  });
});

describe.skipIf(!netRunnable)("the network self-test", () => {
  it("passes on this host, and refuses network modes when a networked sandbox can't start", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const thread = { userId: ada.id, pool: "general" as const, threadId: "t1" };

    const ok = new Workspace(keyring, users, { excludePorts: [] });
    expect(await ok.selfTest()).toBeUndefined();
    expect(ok.forThread(thread).network().internet).toBe(true);

    const broken = new Workspace(keyring, users, { excludePorts: [], pasta: "/nonexistent/pasta" });
    expect(await broken.selfTest()).toMatch(/didn't start/);
    expect(broken.forThread(thread).network()).toEqual({ internet: false, services: false, hosts: [] });
  });
});

describe.skipIf(!homeRunnable || !netRunnable)("a thread's switches", () => {
  it("cut the network in either pool", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const thread = (pool: "general" | "private", threadId: string) => ({ userId: ada.id, pool, threadId });
    workspace.settings(ada.id).setThread("general-off", "general", { internet: false });
    workspace.settings(ada.id).setThread("private-on", "private", { services: true });
    const reach = async (t: ReturnType<typeof thread>) => (await sh(`exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3`, workspace.targetFor(t) as Sandbox)).out;
    await workspace.mountHome(ada.id);
    try {
      expect(await reach(thread("general", "general-default"))).not.toContain("hello from the host");
      expect(await reach(thread("general", "general-off"))).not.toContain("hello from the host");
      expect(await reach(thread("private", "private-default"))).not.toContain("hello from the host");
      expect(await reach(thread("private", "private-on"))).toContain("hello from the host");
    } finally {
      await workspace.unmountHome(ada.id);
    }
  });
});
