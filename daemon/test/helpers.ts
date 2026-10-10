import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keyring, PersonaStore, PRONOUN_PRESETS, SystemdCredentials, Users } from "@lyrica/core";
import { afterEach } from "vitest";
import type { EndpointInfo, ThreadEvent } from "../src/api.ts";
import { Lyricad, type LyricadOptions } from "../src/lyricad.ts";

const ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const SEED = fileURLToPath(new URL("../../persona", import.meta.url));

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

/** A runtime with self.db ("passphrase"), the persona, and users li (admin, password "pw") and sam ("pw2"). */
export async function runtime() {
  const home = mkdtempSync(join(tmpdir(), "lyricad-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const keyring = new Keyring(home, ARGON2);
  await keyring.initSelf("passphrase");
  new PersonaStore(keyring.self()).importSeed(SEED);
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", { displayName: "Li", pronouns: PRONOUN_PRESETS.she }, { admin: true });
  const sam = await users.createUser("sam", "pw2", { displayName: "Sam", pronouns: PRONOUN_PRESETS.they }, { admin: false });
  keyring.self().close();
  const sealed = join(home, "credentials");
  const loaded = join(home, "loaded-credentials");
  return { home, li, sam, sealed, loaded };
}

/** "systemd decrypting at start": copies sealed (here, plain) files into the loaded directory as `lyrica_<name>`. */
export function systemdStart(rt: { sealed: string; loaded: string }): void {
  rmSync(rt.loaded, { recursive: true, force: true });
  mkdirSync(rt.loaded, { recursive: true });
  for (const f of readdirSync(rt.sealed)) cpSync(join(rt.sealed, f), join(rt.loaded, `lyrica_${f}`));
}

/** A started lyricad on a free port, with captured logs and a plain-file credential store. */
export async function daemon(rt: Awaited<ReturnType<typeof runtime>>, opts: Partial<LyricadOptions> = {}) {
  const logs: string[] = [];
  const d = new Lyricad({
    home: rt.home, port: 0, argon2: ARGON2, selfTest: false, webDir: join(rt.home, "no-web"),
    credentials: new SystemdCredentials(rt.sealed, rt.loaded, async (_id, secret, out) => writeFileSync(out, secret)),
    log: (l) => logs.push(l), ...opts,
  });
  await d.start();
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  cleanup.push(stop);
  return { d, logs, base: `http://127.0.0.1:${d.port}`, stop };
}

/** A browser: a cookie jar and the right Origin. */
export function browser(base: string, origin = base) {
  let cookie: string | undefined;
  let setCookie: string | undefined;
  const call = async <T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin } : {}),
        ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers,
      },
      body: body === undefined ? undefined : raw ? (body as Buffer) : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) {
      setCookie = sc;
      const value = sc.split(";")[0]!;
      cookie = value.endsWith("=") ? undefined : value;
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
  };
  return {
    call,
    get: <T = unknown>(p: string) => call<T>("GET", p),
    post: <T = unknown>(p: string, b?: unknown, h?: Record<string, string>) => call<T>("POST", p, b ?? {}, h),
    patch: <T = unknown>(p: string, b: unknown) => call<T>("PATCH", p, b),
    put: <T = unknown>(p: string, b: unknown) => call<T>("PUT", p, b),
    del: <T = unknown>(p: string, b?: unknown) => call<T>("DELETE", p, b),
    get cookie() { return cookie; },
    set cookie(c: string | undefined) { cookie = c; },
    get setCookie() { return setCookie; },
    events: (path: string, lastEventId?: string) => sse(base + path, { ...(cookie ? { cookie } : {}), ...(lastEventId ? { "last-event-id": lastEventId } : {}) }),
  };
}

export type Browser = ReturnType<typeof browser>;

/** Reads an SSE stream. `until` waits for an event matching a test, collecting everything up to it. */
export function sse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const events: { id: string; event: ThreadEvent }[] = [];
  const waiters: { test: (e: ThreadEvent) => boolean; from: number; resolve: () => void }[] = [];
  let ended!: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const ready = (async () => {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status !== 200) throw new Error(`events: ${res.status}`);
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const id = /^id: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!id || !data) continue;
            events.push({ id, event: JSON.parse(data) });
            for (const w of [...waiters]) {
              if (events.slice(w.from).some((e) => w.test(e.event))) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
            }
          }
        }
      } catch { /* aborted */ }
      ended();
    })();
  })();
  return {
    events,
    ready,
    /** Resolves when the server ends the stream. */
    done,
    /** Waits for an event matching `test`, from position `from` on. */
    async until(test: (e: ThreadEvent) => boolean, from = 0, ms = 10_000): Promise<void> {
      await ready;
      if (events.slice(from).some((e) => test(e.event))) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting; got ${events.map((e) => e.event.type).join(", ")}`)), ms);
        waiters.push({ test, from, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
    close: () => controller.abort(),
  };
}

/** Logs in on a fresh browser. */
export async function login(base: string, login: string, password: string): Promise<Browser> {
  const b = browser(base);
  const r = await b.post("/api/login", { login, password });
  if (r.status !== 200) throw new Error(`login ${login}: ${r.status} ${JSON.stringify(r.body)}`);
  return b;
}

/** Gives the user a local endpoint on `baseUrl` and makes its model the chat model of the local and custom profiles, and Custom their default. */
export async function localModel(b: Browser, userId: string, baseUrl: string, modelId = "qwen3.8-27b") {
  const ep = await b.post<EndpointInfo>(`/api/u/${userId}/endpoints`, { name: "gpu", kind: "local", baseUrl });
  if (ep.status !== 200) throw new Error(JSON.stringify(ep.body));
  const offering = ep.body.models.find((m) => m.modelId === modelId);
  if (!offering) throw new Error(`gpu doesn't list ${modelId}`);
  const ref = { offeringId: offering.id };
  for (const p of ["custom", "local"]) await b.put(`/api/u/${userId}/profiles/${p}/chat`, { model: ref });
  await b.patch(`/api/u/${userId}/profiles`, { default: "custom" });
  return ref;
}

export const enc = encodeURIComponent;
