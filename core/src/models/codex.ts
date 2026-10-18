// Principles 1 and 2: ChatGPT Images runs the user's own unmodified Codex (docs/models.md, "Image canvases").
// Codex runs in Lyrica's sandbox with only its home, which is in the user's encrypted home workspace; prompts go over stdin, never argv or logs.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { HostRefused } from "./host.ts";
import { cleanPng, type GeneratedImage, type ImageInput, type ImageRequest } from "./images.ts";

/**
 * Where Codex runs: Lyrica's sandbox (Workspace.codexBox), which holds only
 * its home and the internet. `home` is that folder on the host, `inner` the
 * same folder as Codex sees it, and `start` runs `codex <args>` with
 * CODEX_HOME at `inner`, in `cwd` (an inner path).
 */
export interface CodexBox {
  home: string;
  inner: string;
  installed: boolean;
  start(args: string[], cwd?: string): Promise<ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable }>;
}

/**
 * Codex's own tools an image call never needs, turned off whatever its
 * defaults (`codex features list`; read it again when the pinned version
 * moves). The sandbox is the fence; this only keeps Codex to the image tool.
 */
export const CODEX_DISABLED = ["shell_tool", "unified_exec", "view_image", "browser_use", "computer_use", "in_app_browser", "apps", "plugins"];

interface Run { code: number | null; out: string }
async function run(box: CodexBox, args: string[], input: string, signal?: AbortSignal, timeoutMs = 600_000, cwd?: string): Promise<Run> {
  let child: Awaited<ReturnType<CodexBox["start"]>>;
  try { child = await box.start(args, cwd); } catch { return { code: -1, out: "" }; }
  return new Promise((done, fail) => {
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    let aborted = false;
    const stop = () => { aborted = true; child.kill("SIGKILL"); };
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (aborted) fail(signal!.reason ?? new Error("aborted"));
      else done({ code, out: Buffer.concat(out).toString() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Whether Codex has a sign-in in this home. */
export async function codexSignedIn(box: CodexBox): Promise<boolean> {
  if (!box.installed || !existsSync(join(box.home, "auth.json"))) return false;
  return (await run(box, ["login", "status"], "", undefined, 30_000)).code === 0;
}

export async function codexSignOut(box: CodexBox): Promise<void> {
  if (box.installed) await run(box, ["logout"], "", undefined, 30_000);
  rmSync(join(box.home, "auth.json"), { force: true });
}

export interface CodexSignIn { url: string; code: string; done: Promise<boolean>; cancel(): void }

/** Codex's own device sign-in: its link and one-time code, then whether it finished. */
export async function codexSignIn(box: CodexBox): Promise<CodexSignIn> {
  const child = await box.start(["login", "--device-auth"]).catch(() => { throw new HostRefused("unavailable", "Codex couldn't start its sign-in."); });
  child.stdin.end();
  const done = new Promise<boolean>((r) => { child.on("close", (code) => r(code === 0)); child.on("error", () => r(false)); });
  // Codex's device codes last 15 minutes.
  const expiry = setTimeout(() => child.kill(), 16 * 60_000);
  void done.finally(() => clearTimeout(expiry));
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

/** Each Codex home's calls, one at a time: they share one sign-in, and the user's plan isn't hit several wide. */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(home: string, f: () => Promise<T>): Promise<T> {
  const next = (queues.get(home) ?? Promise.resolve()).catch(() => {}).then(f);
  queues.set(home, next);
  void next.finally(() => { if (queues.get(home) === next) queues.delete(home); }).catch(() => {});
  return next;
}

/**
 * Makes images with Codex: one `codex exec` per image, in Lyrica's sandbox,
 * with image generation on, its other tools off, no approvals and no saved
 * session. Inputs are written to a folder of the call's own in Codex's home,
 * and it and every image Codex saved are removed afterwards. The home must
 * be in the encrypted home workspace.
 */
export async function codexImage(box: CodexBox, r: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  if (r.action === "upscale" || (r.action === "edit" && r.mask)) throw new HostRefused("unsupported", "Codex can't do this request.");
  if (!box.installed) throw new HostRefused("unavailable", "Codex isn't installed on this server.");
  return queued(box.home, async () => {
    if (!(await codexSignedIn(box))) throw new HostRefused("invalid", "Codex is signed out: sign in under Settings → Codex.");
    const images: GeneratedImage[] = [];
    for (let n = 0; n < (r.count ?? 1); n++) {
      signal?.throwIfAborted();
      const id = randomUUID();
      const call = join(box.home, "calls", id), inner = posix.join(box.inner, "calls", id);
      mkdirSync(call, { recursive: true, mode: 0o700 });
      const saved: string[] = [];
      try {
        const inputs = [...(r.action === "edit" ? [r.image] : []), ...(r.references ?? [])].map((i, k) => {
          const name = `input-${k}.${ext(i)}`;
          writeFileSync(join(call, name), i.bytes, { mode: 0o600 });
          return posix.join(inner, name);
        });
        // Codex's own sandbox can't start inside Lyrica's, which is the fence.
        const args = ["exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
          "--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "--enable", "image_generation",
          ...CODEX_DISABLED.flatMap((f) => ["--disable", f]), "--cd", inner,
          ...inputs.flatMap((f) => ["--image", f]), "-"];
        const { code, out } = await run(box, args, instructions(r, r.action === "edit" ? inputs.length - 1 : inputs.length), signal, undefined, inner);
        signal?.throwIfAborted();
        // Only files inside Codex's home count, mapped back to the host: a path elsewhere is never read.
        saved.push(...savedPaths(out).map((p) => posix.relative(box.inner, posix.resolve(inner, p)))
          .filter((p) => p && !p.startsWith("..")).map((p) => join(box.home, p)).filter((p) => existsSync(p)));
        if (code !== 0 && !saved.length) throw failure(out);
        if (!saved.length) throw new HostRefused("invalid", "Codex returned no image.");
        images.push(cleanPng(readFileSync(saved[saved.length - 1]!)));
      } finally {
        rmSync(call, { recursive: true, force: true });
        for (const p of saved) {
          rmSync(p, { force: true });
          const dir = dirname(p);
          const under = relative(join(box.home, "generated_images"), dir);
          if (under && !under.startsWith("..")) rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    return images;
  });
}
