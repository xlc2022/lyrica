import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, SandboxDenied, Users, Workspace, type Grant } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

// Escaping the sandbox is the main failure. These tests must run as an
// unprivileged user, because root hides permission bugs; as root they are
// skipped (see core/README.md). CI sets LYRICA_SANDBOX_TESTS=require so they
// can never be skipped there.

const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };
const root = process.getuid?.() === 0;
const runnable = !root && has("bwrap");
const homeRunnable = runnable && has("gocryptfs") && has("fusermount3");
if (process.env.LYRICA_SANDBOX_TESTS === "require" && !homeRunnable) {
  throw new Error(`sandbox tests required but can't run here (${root ? "running as root" : "bwrap, gocryptfs or fusermount3 missing"})`);
}

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
const box = (network = false, extra: Grant[] = []) => new Sandbox({ workdir: p("work"), grants: [...grants(), ...extra], network });

async function sh(command: string, sandbox = box()): Promise<{ code: number | null; out: string }> {
  let out = "";
  const { exitCode } = await sandbox.ops().bash.exec(command, "/workspace", { onData: (d) => { out += d.toString(); } });
  return { code: exitCode, out };
}

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
    expect(r.out).not.toMatch(/node|vitest/);
    expect(r.out).not.toContain("LYRICA_TEST_SECRET");
    expect(r.out).not.toContain("ALIVE");
    expect((await sh("ls /proc | grep -c '^[0-9]'")).out.trim()).toMatch(/^[1-5]$/);
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
      await expect(ops.write.writeFile(p("rw", link), "overwritten")).rejects.toThrow(/No such file|nonexistent/);
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
    await expect(sh("ls", box(false, [swap]))).rejects.toThrow(/O_NOFOLLOW|ELOOP|ENOTDIR|resolves to/);
    // A symlink earlier in the path is caught too: the opened folder isn't where the grant says.
    mkdirSync(p("outside", "sub"));
    symlinkSync(p("outside"), p("via"));
    await expect(sh("ls", box(false, [{ path: p("via", "sub"), writable: true }]))).rejects.toThrow(/resolves to/);
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
    expect((await sh(`exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3`, box(true))).out).toContain("hello from the host");
  });

  it("keeps long output under Pi's limits, so Pi writes no temp file", async () => {
    const r = await sh("seq 1 200000");
    expect(Buffer.byteLength(r.out)).toBeLessThan(50 * 1024);
    expect(r.out.split("\n").length).toBeLessThan(2000);
    expect(r.out).toContain("bytes of output left out");
    expect(r.out.trimEnd().endsWith("200000")).toBe(true);
  });
});

describe.skipIf(!homeRunnable)("the home workspace", () => {
  it("is encrypted on disk and readable only while mounted", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
    await users.authenticate("li", "pw");
    const workspace = new Workspace(keyring, users);
    const thread = { userId: li.id, pool: "general" as const, threadId: "t1" };
    try {
      await workspace.mountHome(li.id);
      expect(await workspace.saveUpload(thread, "letter.txt", Buffer.from("Dear Li, a secret plan"))).toBe("/workspace/uploads/letter.txt");
      const ops = workspace.targetFor(thread).ops();
      expect((await ops.read.readFile("/workspace/uploads/letter.txt")).toString()).toBe("Dear Li, a secret plan");

      const cipher = join(users.userDir(li.id), "home.crypt");
      const all = execFileSync("sh", ["-c", `find ${cipher} -type f -exec cat {} +; find ${cipher}`]).toString("latin1");
      expect(all).not.toContain("secret plan");
      expect(all).not.toContain("letter");
      expect(all).not.toContain("uploads");
    } finally {
      await workspace.unmountHome(li.id);
    }
    expect(readdirSync(workspace.homeDir(li.id))).toEqual([]);
    expect(() => workspace.targetFor(thread)).toThrow(/not mounted/);

    // Mounting again with the same key brings the files back.
    await workspace.mountHome(li.id);
    try {
      expect((await workspace.targetFor(thread).ops().read.readFile("/workspace/uploads/letter.txt")).toString()).toContain("secret plan");
    } finally {
      await workspace.unmountHome(li.id);
    }
  });
});
