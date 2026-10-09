import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Runs a program with `input` on stdin; rejects with its error output if it fails. */
export function runTool(cmd: string, args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    child.on("error", reject);
    // "exit", not "close": gocryptfs leaves a daemon holding the pipes open.
    child.on("exit", (code) => {
      const text = Buffer.concat(out).toString().trim();
      code === 0 ? resolve(text) : reject(new Error(`${cmd} failed: ${text}`));
    });
    child.stdin.on("error", () => {}); // it may exit without reading its input; the exit code says why
    child.stdin.end(input);
  });
}

/** Whether `dir` is a mount point, from /proc/self/mountinfo. */
export function isMounted(dir: string): boolean {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((l) => unescape(l.split(" ")[4] ?? "") === dir);
}

/**
 * Mounts a gocryptfs folder at `mountpoint`, creating it in `cipherdir` the
 * first time. The password (a hex key) goes over stdin, never argv or disk.
 */
export async function mountGocryptfs(cipherdir: string, mountpoint: string, key: Buffer): Promise<void> {
  if (isMounted(mountpoint)) return;
  const password = `${key.toString("hex")}\n`;
  mkdirSync(cipherdir, { recursive: true, mode: 0o700 });
  mkdirSync(mountpoint, { recursive: true, mode: 0o700 });
  if (!existsSync(join(cipherdir, "gocryptfs.conf"))) {
    if (readdirSync(cipherdir).length) throw new Error(`${cipherdir} is not empty and has no gocryptfs.conf`);
    await runTool("gocryptfs", ["-init", "-q", "-nosyslog", cipherdir], password);
  }
  await runTool("gocryptfs", ["-q", "-nosyslog", cipherdir, mountpoint], password);
}

export async function unmountGocryptfs(mountpoint: string): Promise<void> {
  if (!isMounted(mountpoint)) return;
  // Lazy, so a sandbox still running detaches cleanly instead of blocking the lock.
  await runTool("fusermount3", ["-u", "-z", mountpoint]).catch(() => runTool("fusermount", ["-u", "-z", mountpoint]));
}
