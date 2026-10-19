// Principles 1 and 2: ChatGPT Images runs the user's own unmodified Codex (docs/models.md, "Image canvases").
// Codex runs in Lyrica's sandbox with only its home, which is in the user's encrypted home workspace; prompts go over stdin, never argv or logs.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
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
  /** For the journal: exit codes, event types and counts, never text Codex wrote. */
  log?: (line: string) => void;
  start(args: string[], cwd?: string): Promise<ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable }>;
}

/**
 * Codex's own tools an image call never needs, turned off whatever its
 * defaults. Only the ones the installed Codex lists are passed, since
 * versions differ (nixpkgs' isn't pinned) and a missing one doesn't exist
 * there. The sandbox is the fence; this only keeps Codex to the image tool.
 */
export const CODEX_DISABLED = ["shell_tool", "unified_exec", "view_image", "browser_use", "computer_use", "in_app_browser", "apps", "plugins", "memories", "goals"];

interface Run { code: number | null; out: string; stopped?: boolean }
/** Runs Codex; `enough`, checked every second, stops it early (`stopped`) once it has what was asked for. */
async function run(box: CodexBox, args: string[], input: string, signal?: AbortSignal, timeoutMs = 600_000, cwd?: string, enough?: () => boolean): Promise<Run> {
  let child: Awaited<ReturnType<CodexBox["start"]>>;
  try { child = await box.start(args, cwd); } catch { return { code: -1, out: "" }; }
  return new Promise((done, fail) => {
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    let aborted = false;
    const stop = () => { aborted = true; child.kill("SIGKILL"); };
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let stopped = false;
    const watch = enough && setInterval(() => { if (!stopped && enough()) { stopped = true; child.kill("SIGTERM"); } }, 1000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      signal?.removeEventListener("abort", stop);
      if (aborted) fail(signal!.reason ?? new Error("aborted"));
      else done({ code, out: Buffer.concat(out).toString(), stopped });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** The features this Codex knows (`codex features list`), once per home; none when it can't say, which refuses the call. */
const featureLists = new Map<string, Promise<Set<string>>>();
function features(box: CodexBox): Promise<Set<string>> {
  let f = featureLists.get(box.home);
  if (!f) {
    f = run(box, ["features", "list"], "", undefined, 30_000).then(({ code, out }) => {
      const names = new Set(out.split("\n").map((l) => /^([a-z0-9_]+)\s/.exec(l)?.[1]).filter((n): n is string => !!n));
      if (code !== 0 || !names.has("image_generation")) throw new HostRefused("unavailable", "Codex couldn't list its tools.");
      return names;
    });
    f.catch(() => featureLists.delete(box.home));
    featureLists.set(box.home, f);
  }
  return f;
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

/** Codex's last reply in words, on one line and at most 300 characters. */
function lastReply(out: string): string | undefined {
  let text: string | undefined;
  for (const line of out.split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") text = e.item.text;
    } catch { /* not an event */ }
  }
  const one = text?.replace(/\s+/g, " ").trim();
  return one ? (one.length > 300 ? `${one.slice(0, 299)}…` : one) : undefined;
}

/** Every image file under `dir`, newest last. */
function imageFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files = (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((e) => e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)).map((e) => join(e.parentPath, e.name));
  return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/** What a run's events were, by type only: "thread.started, item.completed:image_generation, …". */
function eventShape(out: string): string {
  const types: string[] = [];
  for (const line of out.split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: unknown; item?: { type?: unknown } };
      const t = typeof e.type === "string" ? e.type + (typeof e.item?.type === "string" ? `:${e.item.type}` : "") : undefined;
      if (t && /^[\w.:-]{1,60}$/.test(t) && types.at(-1) !== t) types.push(t);
    } catch { /* not an event */ }
  }
  return types.slice(0, 20).join(", ") || "none";
}

/** A fixed line for a failed run: Codex's own output can contain the prompt. */
function failure(out: string): HostRefused {
  if (/not logged in|log ?in again|sign in again|401|unauthori[sz]ed|refresh token/i.test(out)) return new HostRefused("invalid", "Codex is signed out: sign in under Settings → Claude Code and Codex.");
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
    if (!(await codexSignedIn(box))) throw new HostRefused("invalid", "Codex is signed out: sign in under Settings → Claude Code and Codex.");
    const known = await features(box);
    const disabled = CODEX_DISABLED.filter((f) => known.has(f));
    const images: GeneratedImage[] = [];
    for (let n = 0; n < (r.count ?? 1); n++) {
      signal?.throwIfAborted();
      const id = randomUUID();
      const call = join(box.home, "calls", id), inner = posix.join(box.inner, "calls", id);
      mkdirSync(call, { recursive: true, mode: 0o700 });
      // Codex saves under generated_images/<session>/, by a name that varies between
      // versions. Calls here run one at a time, so everything there is this call's:
      // it starts empty and is removed after, with the call's inputs.
      const generated = join(box.home, "generated_images");
      rmSync(generated, { recursive: true, force: true });
      try {
        const inputs = [...(r.action === "edit" ? [r.image] : []), ...(r.references ?? [])].map((i, k) => {
          const name = `input-${k}.${ext(i)}`;
          writeFileSync(join(call, name), i.bytes, { mode: 0o600 });
          return posix.join(inner, name);
        });
        // Codex's own sandbox can't start inside Lyrica's, which is the fence.
        const args = ["exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
          "--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "--enable", "image_generation",
          ...disabled.flatMap((f) => ["--disable", f]), "--cd", inner,
          ...inputs.flatMap((f) => ["--image", f]), "-"];
        // One image per run: once a saved image stops growing, Codex is stopped, so a second
        // image-tool call can't spend more of the user's plan.
        let size = -1;
        const enough = () => {
          const last = imageFiles(generated).at(-1);
          const now = last ? statSync(last).size : -1;
          const settled = now > 0 && now === size;
          size = now;
          return settled;
        };
        const { code, out, stopped } = await run(box, args, instructions(r, r.action === "edit" ? inputs.length - 1 : inputs.length), signal, undefined, inner, enough);
        signal?.throwIfAborted();
        // A saved_path Codex reports, mapped back to the host and only inside its home; else the newest image it saved.
        const reported = savedPaths(out).map((p) => posix.relative(box.inner, posix.resolve(inner, p)))
          .filter((p) => p && !p.startsWith("..")).map((p) => join(box.home, p)).filter((p) => existsSync(p));
        const found = imageFiles(generated);
        const file = reported.at(-1) ?? found.at(-1);
        box.log?.(`codex exec: ${stopped ? "stopped after its image" : `exit ${code}`}, ${found.length} image file${found.length === 1 ? "" : "s"} saved, events: ${eventShape(out)}`);
        if (code !== 0 && !file) throw failure(out);
        // A finished run with words and no image is Codex declining; its reply says why. It goes
        // only to the tool result, never the journal.
        const reply = lastReply(out);
        if (!file && reply) throw new HostRefused("image_refusal", `Codex made no image (image_refusal). It said: "${reply}"`);
        if (!file) throw new HostRefused("unavailable", "Codex returned no image.");
        images.push(cleanPng(readFileSync(file)));
      } finally {
        rmSync(call, { recursive: true, force: true });
        rmSync(generated, { recursive: true, force: true });
        // --ephemeral keeps no session, but Codex still opens its databases (state, logs,
        // goals, memories), which can hold a prompt; only auth.json needs to outlast a call.
        for (const f of readdirSync(box.home)) if (/\.sqlite(-wal|-shm|-journal)?$/.test(f)) rmSync(join(box.home, f), { force: true });
      }
    }
    return images;
  });
}
