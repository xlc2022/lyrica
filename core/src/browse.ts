import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { FETCH_UA } from "./web.ts";
import { BROWSER_PROFILE } from "./workspace/sandbox.ts";

// The `browse` tool's browser (docs/briefs/browse.md): one Chromium per
// thread, in its sandbox, driven by browse.cjs there. lyricad talks to the
// driver over the process's stdin and stdout, one JSON line each way.

/** The driver, run by the sandbox's node (browse.cjs). */
export const BROWSE_SCRIPT = readFileSync(new URL("./browse.cjs", import.meta.url), "utf8");
/** A browser nobody used for this long is closed; its profile stays. */
export const BROWSE_IDLE_MS = 10 * 60_000;
/**
 * How long one action, or the browser's start, may take before it is taken as stuck and closed. A first start
 * reads all of Chromium from disk, which took 10 to 30 seconds on a busy machine (CI's runners), so a start
 * gets as long as an action does.
 */
export const BROWSE_MS = 90_000;

/** The command that starts the driver. */
export const browseArgv = (): string[] => ["node", "-e", BROWSE_SCRIPT, BROWSER_PROFILE, FETCH_UA];

export const BROWSE_ACTIONS = ["open", "read", "click", "type", "select", "attach", "scroll", "back", "screenshot", "close"] as const;
export type BrowseAction = typeof BROWSE_ACTIONS[number];
/** The actions that only look: Plan mode's. */
export const BROWSE_READS: ReadonlySet<string> = new Set(["open", "read", "scroll", "back", "screenshot", "close"]);

/** A form an action would send: where, and what is in it (a password as dots). */
export interface BrowseForm { site: string; to: string; method: string; button: string; fields: { name: string; value: string }[] }
/** The driver's answer: the page as it is now, or a screenshot. */
export interface BrowseReply { url?: string; title?: string; text?: string; notes?: string[]; fail?: string; image?: string; sends?: BrowseForm | null; unapproved?: BrowseForm; site?: string; what?: string; downloads?: BrowseDownload[] }
/**
 * A file the action downloaded: the site's name for it, and where it was saved in her folder (`path`, with its
 * size), or that it is still `going` (its size so far; a later action answers it again), or why not. `file` is the driver's id for it in the profile, until lyricad moves it.
 */
export interface BrowseDownload { name: string; file?: string; bytes?: number; path?: string; fail?: string; going?: boolean }
export interface BrowseCall { action: BrowseAction; url?: string; ref?: number; text?: string; submit?: boolean; direction?: "up" | "down"; path?: string }

export type BrowserProcess = { stdin: Writable; stdout: Readable; kill(signal?: NodeJS.Signals): boolean; on(event: "close", listener: () => void): unknown };

/** What the approval card shows for a form: where it goes, then each field. */
export function browseFormText(f: BrowseForm): string {
  return [`${f.method} to ${f.to}${f.button ? ` (${f.button})` : ""}`, ...f.fields.map((x) => `${x.name}: ${x.value}`)].join("\n");
}

/** The card's sentence. */
export const browseFormWarning = (f: BrowseForm): string => `This sends a form${f.to === f.site ? ` on ${f.site}` : ` from ${f.site} to ${f.to}`}.`;

/** The reason she gets when a form is sent without the hook's go-ahead for that call: it never is. */
export const BROWSE_UNAPPROVED = "That would send a form, which needs the user's go-ahead. Nothing was sent.";
/** The same for attaching a file, which gives it to the site: it always asks. */
export const BROWSE_UNAPPROVED_FILE = "Attaching a file gives it to the site, which needs the user's go-ahead. Nothing was attached.";

export class Browser {
  private child: BrowserProcess | undefined;
  private starting: Promise<BrowserProcess> | undefined;
  private next = 1;
  private buffer = "";
  private readonly waiting = new Map<number, { resolve: (r: BrowseReply) => void; reject: (e: Error) => void }>();
  /** The calls the user said yes to, by tool call id: each is good for one action. */
  private readonly approved = new Set<string>();
  private idle: NodeJS.Timeout | undefined;

  /** `save` moves a download (its id in the profile, the site's name) into her folder and answers the path she sees. */
  constructor(private readonly start: () => Promise<BrowserProcess>, private readonly idleMs = BROWSE_IDLE_MS, private readonly limitMs = BROWSE_MS,
    private readonly save?: (file: string, name: string) => Promise<string>,
    /** Copies a file of hers (a path in her folder) into the profile, for a file field; answers its path in the browser's run. */
    private readonly stage?: (path: string) => Promise<string>) {}

  get running(): boolean { return !!this.child; }

  /**
   * What a call on a numbered thing would do, for the gate: the form it
   * would send, if any, and the action in words for a card (`click button
   * "Add to cart" on shop.example`). Nothing while the browser is closed:
   * there is no page to act on.
   */
  async look(call: Pick<BrowseCall, "action" | "ref" | "submit" | "text" | "path">, signal?: AbortSignal): Promise<{ form?: BrowseForm; words: string; gives?: string }> {
    if (!this.child || call.ref === undefined) return { words: call.action };
    // Attaching gives a file to the site: it always asks, naming the file and the site.
    if (call.action === "attach") {
      const r = await this.ask({ op: "sends", action: "attach", ref: call.ref }, signal);
      return { words: `attach ${call.path ?? ""} to ${r.what || `number ${call.ref}`}${r.site ? ` on ${r.site}` : ""}`, gives: r.site || "the site" };
    }
    const r = await this.ask({ op: "sends", action: call.action, ref: call.ref, submit: !!call.submit }, signal);
    const on = `${r.what || `number ${call.ref}`}${r.site ? ` on ${r.site}` : ""}`;
    const words = call.action === "type" ? `type ${JSON.stringify(call.text ?? "")} into ${on}${call.submit ? ", then Enter" : ""}`
      : call.action === "select" ? `choose ${JSON.stringify(call.text ?? "")} in ${on}` : `${call.action} ${on}`;
    return { ...(r.sends ? { form: r.sends } : {}), words };
  }

  /** The user's yes to one call. */
  approve(toolCallId: string): void { this.approved.add(toolCallId); }

  /** One action. Without a yes for this call, the driver sends no form. */
  async act(toolCallId: string, call: BrowseCall, signal?: AbortSignal): Promise<BrowseReply> {
    const approved = this.approved.delete(toolCallId);
    if (call.action === "close") { await this.close(); return {}; }
    const { action, ...rest } = call;
    if (action === "attach") {
      if (!approved) return { fail: BROWSE_UNAPPROVED_FILE };
      if (!this.stage || !call.path) return { fail: "there is no file to attach" };
      const file = await this.stage(call.path).catch((err: Error) => err);
      if (file instanceof Error) return { fail: `couldn't read ${call.path}: ${file.message}` };
      return this.ask({ op: "attach", ref: call.ref, file }, signal);
    }
    const r = await this.ask({ op: action, ...rest, ...(approved ? { approved: true } : {}) }, signal);
    if (r.unapproved) return { fail: BROWSE_UNAPPROVED };
    for (const d of r.downloads ?? []) {
      if (!d.file) continue;
      try { d.path = this.save ? await this.save(d.file, d.name) : undefined; } catch (err) { d.fail = (err as Error).message; }
      if (!d.path) d.fail ??= "there is nowhere to save it";
      delete d.file;
    }
    return r;
  }

  /** Closes the browser, letting it write its cookies first. */
  async close(): Promise<void> {
    clearTimeout(this.idle);
    const child = this.child ?? (await this.starting?.catch(() => undefined));
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 8000);
      child.on("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }

  private async open(): Promise<BrowserProcess> {
    if (this.child) return this.child;
    this.starting ??= (async () => {
      const child = await this.start();
      let late = false;
      const ready = new Promise<void>((resolve, reject) => { this.waiting.set(0, { resolve: () => resolve(), reject: (e) => reject(late ? new Error(`the browser didn't start in ${this.limitMs / 1000} seconds`) : e) }); });
      child.stdin.on("error", () => {});
      child.stdout.on("data", (d: Buffer) => this.read(d));
      child.on("close", () => {
        if (this.child === child) this.child = undefined;
        clearTimeout(this.idle);
        this.buffer = "";
        for (const w of this.waiting.values()) w.reject(new Error("the browser closed"));
        this.waiting.clear();
      });
      const timer = setTimeout(() => { late = true; child.kill("SIGKILL"); }, this.limitMs);
      try { await ready; } finally { clearTimeout(timer); }
      this.child = child;
      return child;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private read(d: Buffer): void {
    this.buffer += d.toString("utf8");
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      let m: BrowseReply & { id?: number; ready?: boolean };
      try { m = JSON.parse(line); } catch { continue; }
      const id = m.ready || (m.id === undefined && m.fail) ? 0 : m.id;
      const w = id === undefined ? undefined : this.waiting.get(id);
      if (!w) continue;
      this.waiting.delete(id!);
      id === 0 && m.fail ? w.reject(new Error(m.fail)) : w.resolve(m);
    }
  }

  private async ask(op: Record<string, unknown>, signal?: AbortSignal): Promise<BrowseReply> {
    const child = await this.open();
    clearTimeout(this.idle);
    const id = this.next++;
    try {
      return await new Promise<BrowseReply>((resolve, reject) => {
        // Past the limit the browser is taken as stuck and closed, so the next call starts a fresh one.
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`the browser didn't answer in ${this.limitMs / 1000} seconds and was closed`)); }, this.limitMs);
        const onAbort = () => { this.waiting.delete(id); clearTimeout(timer); reject(new Error("aborted")); };
        signal?.addEventListener("abort", onAbort, { once: true });
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
        this.waiting.set(id, { resolve: (r) => { done(); resolve(r); }, reject: (e) => { done(); reject(e); } });
        if (signal?.aborted) return onAbort();
        child.stdin.write(JSON.stringify({ id, ...op }) + "\n");
      });
    } finally {
      if (this.child) { this.idle = setTimeout(() => { void this.close(); }, this.idleMs); this.idle.unref?.(); }
    }
  }
}
