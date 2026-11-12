import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keyring, PersonaStore, PRONOUN_PRESETS, SystemdCredentials, Users } from "@lyrica/core";
import { afterEach } from "vitest";
import type { EndpointInfo, ThreadEvent } from "../src/api.ts";
import { Lyricad, type LyricadOptions } from "../src/lyricad.ts";

export const ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
/** One SQLCipher round for the self.db passphrase: lyricad must open it with the same count. */
export const KDF_ITER = 1;
const SEED = fileURLToPath(new URL("../../persona", import.meta.url));

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

/** A runtime with self.db ("passphrase"), the persona, and users ada (admin, password "pw") and sam ("pw2"). */
export async function runtime() {
  const home = mkdtempSync(join(tmpdir(), "lyricad-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const keyring = new Keyring(home, ARGON2, KDF_ITER);
  await keyring.initSelf("passphrase");
  new PersonaStore(keyring.self()).importSeed(SEED);
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", { displayName: "Ada", pronouns: PRONOUN_PRESETS.she }, { admin: true });
  const sam = await users.createUser("sam", "pw2", { displayName: "Sam", pronouns: PRONOUN_PRESETS.they }, { admin: false });
  keyring.self().close();
  const sealed = join(home, "credentials");
  const secrets = new Map<string, Buffer>();
  return { home, ada, sam, sealed, secrets };
}

/** A started lyricad on a free port, with captured logs and an in-memory fake unsealer. */
export async function daemon(rt: Awaited<ReturnType<typeof runtime>>, opts: Partial<LyricadOptions> = {}) {
  const logs: string[] = [];
  const d = new Lyricad({
    home: rt.home, port: 0, argon2: ARGON2, kdfIter: KDF_ITER, selfTest: false, webDir: join(rt.home, "no-web"),
    credentials: new SystemdCredentials(rt.sealed, async (id, secret, out) => { rt.secrets.set(id, Buffer.from(secret)); writeFileSync(out, "sealed"); }, async (id) => {
      const secret = rt.secrets.get(id);
      if (!secret) throw new Error("bad sealed credential");
      return Buffer.from(secret);
    }, (line) => logs.push(line)),
    // A child's report wakes its parent at once unless a test is about batching them.
    log: (l) => logs.push(l), childWakeMs: 0, ...opts,
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

/** Gives the user a local endpoint on `baseUrl` and makes its model the chat model of the private and general columns. */
export async function localModel(b: Browser, userId: string, baseUrl: string, modelId = "qwen3.8-27b") {
  const ep = await b.post<EndpointInfo>(`/api/u/${userId}/endpoints`, { name: "gpu", kind: "local", baseUrl });
  if (ep.status !== 200) throw new Error(JSON.stringify(ep.body));
  const offering = ep.body.models.find((m) => m.modelId === modelId);
  if (!offering) throw new Error(`gpu doesn't list ${modelId}`);
  const ref = { offeringId: offering.id };
  for (const column of ["private", "general"] as const) await b.put(`/api/u/${userId}/columns/${column}/chat`, { model: ref });
  return ref;
}

export const enc = encodeURIComponent;

/**
 * A fake `tailscale` that records its arguments in `calls` (one JSON array a
 * line) and keeps her device's state in `status.json`, in `dir`. Login
 * with `key` joins her to example.ts.net. `fail-login` makes
 * login fail quoting the key, as a CLI error might.
 */
export function fakeTailscale(key: string, dir: string) {
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
const st = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
const save = (s) => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(s));
const rec = { args };
const cmd = args[2];
if (cmd === "login") {
  const file = args.find((a) => a.startsWith("--auth-key=file:")).slice("--auth-key=file:".length);
  rec.keyFileMode = (fs.statSync(file).mode & 0o777).toString(8);
  rec.keyFileHoldsKey = fs.readFileSync(file, "utf8") === ${JSON.stringify(key)};
}
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify(rec) + "\\n");
const s = st();
switch (cmd) {
  case "status": process.stdout.write(JSON.stringify(s)); break;
  case "login":
    if (fs.existsSync(path.join(dir, "fail-login"))) { process.stderr.write("backend error: invalid key: " + ${JSON.stringify(key)} + "\\n"); process.exit(1); }
    save({ ...s, BackendState: "Running", Self: { ...s.Self, DNSName: "lyrica.example.ts.net.", TailscaleIPs: ["100.101.102.103", "fd7a::1"] },
      CurrentTailnet: { Name: "example.ts.net", MagicDNSSuffix: "example.ts.net", MagicDNSEnabled: true }, CertDomains: ["lyrica.example.ts.net"] });
    break;
  case "set": save({ ...s, Self: { ...s.Self, HostName: args[3].split("=")[1] } }); break;
  case "up": save({ ...s, BackendState: "Running" }); break;
  case "down": save({ ...s, BackendState: "Stopped" }); break;
  case "logout": save({ Version: s.Version, BackendState: "NeedsLogin", Self: { HostName: s.Self.HostName } }); break;
  case "cert":
    if (!(s.CertDomains || []).includes(args[5])) { process.stderr.write("invalid domain " + args[5] + "\\n"); process.exit(1); }
    process.stdout.write("-----BEGIN CERTIFICATE-----\\n" + (fs.existsSync(path.join(dir, "renewed")) ? "TEST-RENEWED-" : "TEST-LEAF-") + args[5] + "\\n-----END CERTIFICATE-----\\n-----BEGIN CERTIFICATE-----\\nTEST-CA\\n-----END CERTIFICATE-----\\n-----BEGIN EC PRIVATE KEY-----\\nTEST-KEY\\n-----END EC PRIVATE KEY-----\\n");
    break;
}
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ Version: "1.90.1-t123", BackendState: "NeedsLogin", Self: { HostName: "lyrica-host" } }));
  return {
    bin,
    calls: (): { args: string[]; keyFileMode?: string; keyFileHoldsKey?: boolean }[] =>
      existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
    /** tailscaled renewed her certificate: the next `cert` gives a new one. */
    renew: () => writeFileSync(join(dir, "renewed"), ""),
    failLogin: (on: boolean) => (on ? writeFileSync(join(dir, "fail-login"), "") : rmSync(join(dir, "fail-login"), { force: true })),
  };
}
