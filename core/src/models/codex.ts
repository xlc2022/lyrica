// Principles 1 and 2: ChatGPT Images runs the user's own unmodified Codex (docs/models.md, "Image canvases").
// Everything Codex keeps or writes lives in the user's encrypted home workspace; prompts go over stdin, never argv or logs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { HostRefused } from "./host.ts";
import { cleanPng, type GeneratedImage, type ImageInput, type ImageRequest } from "./images.ts";

/** Where `codex` is: the daemon's path. */
export function codexInstalled(path = process.env.PATH ?? ""): boolean {
  return path.split(":").some((d) => d && existsSync(join(d, "codex")));
}

/** Codex's environment: its home in the encrypted workspace and nothing else of the daemon's, so no key or token leaks in. */
const env = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", CODEX_HOME: home, HOME: home, LANG: "C.UTF-8" });

interface Run { code: number | null; out: string }
function run(home: string, args: string[], input: string, signal?: AbortSignal, timeoutMs = 600_000, cwd = home): Promise<Run> {
  return new Promise((done, fail) => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const child = spawn("codex", args, { cwd, env: env(home), stdio: ["pipe", "pipe", "pipe"], signal, timeout: timeoutMs });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    child.on("error", (e) => (e.name === "AbortError" ? fail(e) : done({ code: -1, out: "" })));
    child.on("close", (code) => done({ code, out: Buffer.concat(out).toString() }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Whether Codex has a sign-in in this home. */
export async function codexSignedIn(home: string): Promise<boolean> {
  if (!existsSync(join(home, "auth.json"))) return false;
  return (await run(home, ["login", "status"], "", undefined, 30_000)).code === 0;
}

export async function codexSignOut(home: string): Promise<void> {
  await run(home, ["logout"], "", undefined, 30_000);
  rmSync(join(home, "auth.json"), { force: true });
}

export interface CodexSignIn { url: string; code: string; done: Promise<boolean>; cancel(): void }

/** Codex's own device sign-in: its link and one-time code, then whether it finished. */
export function codexSignIn(home: string): Promise<CodexSignIn> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const child = spawn("codex", ["login", "--device-auth"], { cwd: home, env: env(home), stdio: ["ignore", "pipe", "pipe"], timeout: 16 * 60_000 });
  const done = new Promise<boolean>((r) => { child.on("close", (code) => r(code === 0)); child.on("error", () => r(false)); });
  return new Promise((ok, fail) => {
    let text = "";
    const read = (d: Buffer) => {
      // Codex colours its output; the link and code are what's left.
      text += d.toString().replace(/\x1b\[[0-9;]*m/g, "");
      const url = /https:\/\/auth\.openai\.com\/\S+/.exec(text)?.[0], code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(text)?.[0];
      if (url && code) { clearTimeout(late); ok({ url, code, done, cancel: () => child.kill() }); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    // A Codex that never shows a link and code is stopped rather than left waiting.
    const late = setTimeout(() => child.kill(), 30_000);
    void done.then(() => fail(new HostRefused("unavailable", "Codex couldn't start its sign-in.")));
    void done.finally(() => clearTimeout(late));
  });
}

const ext = (i: ImageInput) => (i.type === "image/jpeg" ? "jpg" : i.type === "image/webp" ? "webp" : "png");
const shape = (s: { width: number; height: number }) => (s.width > s.height * 1.2 ? "landscape" : s.height > s.width * 1.2 ? "portrait" : "square");

/** What Codex is asked: one image-tool call and nothing else. The user's prompt follows, verbatim. */
function instructions(r: Exclude<ImageRequest, { action: "upscale" }>, references: number): string {
  const what = r.action === "edit" ? "Edit the first attached image" : "Generate one image";
  const extra = [
    r.action === "create" && r.size ? `Make it ${shape(r.size)}.` : "",
    r.action === "create" ? (r.tier === "fast" ? "Draft quality is fine." : "Use high quality.") : "",
    references ? `The other attached image${references > 1 ? "s are references" : " is a reference"}.` : "",
  ].filter(Boolean).join(" ");
  return `${what} with the image generation tool, exactly once. Don't run commands, read files or write files. ${extra}\nWhen it's done, reply "done".\n\nPrompt:\n${r.prompt}`;
}

/** The saved image's path from Codex's JSON events: the deepest `saved_path` it reports. */
function savedPaths(out: string): string[] {
  const paths: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) k === "saved_path" && typeof x === "string" ? paths.push(x) : walk(x);
  };
  for (const line of out.split("\n")) { try { walk(JSON.parse(line)); } catch { /* not an event */ } }
  return [...new Set(paths)];
}

/** A fixed line for a failed run: Codex's own output can contain the prompt. */
function failure(out: string): HostRefused {
  if (/not logged in|log ?in again|sign in again|401|unauthori[sz]ed|refresh token/i.test(out)) return new HostRefused("invalid", "Codex is signed out: sign in under Settings → Codex.");
  if (/usage limit|rate limit|429/i.test(out)) return new HostRefused("unavailable", "Codex reached its usage limit.");
  if (/content[_ ]policy|moderation|safety system|refus/i.test(out)) return new HostRefused("image_refusal", "Image generation was refused (image_refusal).");
  return new HostRefused("unavailable", "Codex couldn't make the image.");
}

/**
 * Makes images with Codex: one `codex exec` per image, with image generation on,
 * a read-only sandbox, no approvals and no saved session. Inputs are written
 * to a folder of the call's own in `home`, and it and every image Codex saved
 * are removed afterwards. `home` must be in the encrypted home workspace.
 */
export async function codexImage(home: string, r: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (r.action === "upscale" || (r.action === "edit" && r.mask)) throw new HostRefused("unsupported", "Codex can't do this request.");
  if (!codexInstalled()) throw new HostRefused("unavailable", "Codex isn't installed on this server.");
  if (!(await codexSignedIn(home))) throw new HostRefused("invalid", "Codex is signed out: sign in under Settings → Codex.");
  const images: GeneratedImage[] = [];
  for (let n = 0; n < (r.count ?? 1); n++) {
    signal?.throwIfAborted();
    const call = join(home, "calls", randomUUID());
    mkdirSync(call, { recursive: true, mode: 0o700 });
    const saved: string[] = [];
    try {
      const inputs = [...(r.action === "edit" ? [r.image] : []), ...(r.references ?? [])].map((i, k) => {
        const file = join(call, `input-${k}.${ext(i)}`);
        writeFileSync(file, i.bytes, { mode: 0o600 });
        return file;
      });
      const args = ["exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
        "--sandbox", "read-only", "-c", 'approval_policy="never"', "--enable", "image_generation", "--cd", call,
        ...inputs.flatMap((f) => ["--image", f]), "-"];
      const { code, out } = await run(home, args, instructions(r, r.action === "edit" ? inputs.length - 1 : inputs.length), signal, undefined, call);
      signal?.throwIfAborted();
      // Only files inside Codex's home count: a path elsewhere is never read.
      saved.push(...savedPaths(out).map((p) => resolve(call, p)).filter((p) => !relative(home, p).startsWith("..") && existsSync(p)));
      if (code !== 0 && !saved.length) throw failure(out);
      if (!saved.length) throw new HostRefused("invalid", "Codex returned no image.");
      images.push(cleanPng(readFileSync(saved[saved.length - 1]!)));
    } finally {
      rmSync(call, { recursive: true, force: true });
      for (const p of saved) {
        rmSync(p, { force: true });
        const dir = dirname(p);
        const under = relative(join(home, "generated_images"), dir);
        if (under && !under.startsWith("..")) rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return images;
}
