import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { call, lyrica, pair, startHost } from "./helpers.ts";

// host/update.sh against a temporary world, as an unprivileged user: a local
// origin with update tags, a checkout of it, a stand-in install.sh, and a
// fake host-api answering its status and Pause and Resume.

const UPDATE = fileURLToPath(new URL("../update.sh", import.meta.url));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

async function world() {
  const root = mkdtempSync(join(tmpdir(), "lyrica-host-update-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), work = join(root, "work"), checkout = join(root, "lyrica"), dir = join(root, "update"), fake = join(root, "fake");
  mkdirSync(fake);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "T");
  mkdirSync(join(work, "host"));
  // Releases are made elsewhere and pushed; the host's checkout only fetches.
  const release = (name: string, o: { broken?: boolean; lightweight?: boolean; branch?: string } = {}) => {
    if (o.branch) git(work, "checkout", "-q", "-B", o.branch);
    writeFileSync(join(work, "host", "version"), name);
    if (o.broken) writeFileSync(join(work, "host", "BROKEN"), ""); else rmSync(join(work, "host", "BROKEN"), { force: true });
    git(work, "add", "-A"); git(work, "commit", "-q", "-m", name);
    if (o.lightweight) git(work, "tag", `update/${name}`); else git(work, "tag", "-a", `update/${name}`, "-m", `Update ${name}`);
    git(work, "push", "-q", "origin", o.branch ?? "main", "--tags");
    const commit = git(work, "rev-parse", "HEAD");
    if (o.branch) git(work, "checkout", "-q", "main");
    return commit;
  };
  const first = release("one");
  execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "ignore" });
  mkdirSync(join(dir, "status"), { recursive: true });
  mkdirSync(join(dir, "inbox"));
  execFileSync("git", ["init", "-q", "--bare", join(dir, "repo.git")]);
  execFileSync("git", ["--git-dir", join(dir, "repo.git"), "remote", "add", "origin", origin]);

  // host-api: its state, and the commit install.sh left it on.
  const api = { state: "running", calls: [] as string[] };
  const commitNow = () => git(checkout, "rev-parse", "HEAD");
  const server: Server = createServer((req, res) => {
    api.calls.push(`${req.method} ${req.url}`);
    if (req.url === "/host/v1/pause") api.state = "paused";
    if (req.url === "/host/v1/resume") api.state = "running";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ state: api.state, commit: commitNow() }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  // install.sh: fails on a broken release, as one that doesn't build would.
  writeFileSync(join(fake, "install"), `#!/usr/bin/env bash\necho "$(cat "${checkout}/host/version")" >>"${fake}/installs"\n[ ! -e "${checkout}/host/BROKEN" ]\n`);
  chmodSync(join(fake, "install"), 0o755);

  const env = {
    ...process.env, LYRICA_TEST: "1", LYRICA_HOST_DIR: join(checkout, "host"), LYRICA_HOST_UPDATE_DIR: dir,
    LYRICA_HOST_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LYRICA_HOST_INSTALL: join(fake, "install"),
    LYRICA_HOST_DRAIN_SECONDS: "2", LYRICA_HOST_PROBATION_SECONDS: "2", LYRICA_HOST_POLL: "1",
  };
  const run = (...args: string[]) => new Promise<{ code: number; err: string }>((resolve) => {
    execFile(UPDATE, args, { env, timeout: 30_000 }, (err, _out, errOut) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, err: errOut }));
  });
  const state = () => JSON.parse(readFileSync(join(dir, "status", "state.json"), "utf8"));
  const installs = () => (existsSync(join(fake, "installs")) ? readFileSync(join(fake, "installs"), "utf8").trim().split("\n") : []);
  return { dir, api, first, release, run, state, installs, commitNow };
}

describe("lyrica-host-update", () => {
  it("takes a request, pauses the host, installs the release and resumes it", async () => {
    const w = await world();
    const two = w.release("two");
    writeFileSync(join(w.dir, "inbox", "request.json"), JSON.stringify({ tag: "update/two" }));
    const r = await w.run("--request");
    expect(r.code, r.err).toBe(0);
    expect(w.commitNow()).toBe(two);
    expect(w.installs()).toEqual(["two"]);
    expect(w.api.calls).toContain("POST /host/v1/pause");
    expect(w.api.state).toBe("running");
    expect(w.state()).toMatchObject({ state: "idle", last: { tag: "update/two", commit: two, ok: true } });
    expect(existsSync(join(w.dir, "inbox", "request.json"))).toBe(false);
  });

  it("leaves a paused host paused", async () => {
    const w = await world();
    w.release("two");
    w.api.state = "paused";
    expect((await w.run("--tag", "update/two")).code).toBe(0);
    expect(w.api.calls).not.toContain("POST /host/v1/resume");
    expect(w.api.state).toBe("paused");
  });

  it("refuses a tag that isn't annotated, or isn't on main, and changes nothing", async () => {
    const w = await world();
    w.release("light", { lightweight: true });
    w.release("side", { branch: "side" });
    const before = w.commitNow();
    expect((await w.run("--tag", "update/light")).code).not.toBe(0);
    expect(w.state()).toMatchObject({ state: "failed", error: "not an annotated update tag" });
    expect((await w.run("--tag", "update/side")).code).not.toBe(0);
    expect(w.state()).toMatchObject({ state: "failed", error: "not on main" });
    expect((await w.run("--tag", "../../etc")).code).not.toBe(0);
    expect(w.commitNow()).toBe(before);
    expect(w.installs()).toEqual([]);
    expect(w.api.calls).not.toContain("POST /host/v1/pause");
  });

  it("goes back to the running commit when the new one doesn't come up", async () => {
    const w = await world();
    w.release("broken", { broken: true });
    const r = await w.run("--tag", "update/broken");
    expect(r.code).not.toBe(0);
    expect(w.commitNow()).toBe(w.first);
    expect(w.installs()).toEqual(["broken", "one"]);
    expect(w.api.state).toBe("running");
    expect(w.state()).toMatchObject({ state: "failed", error: "probation", last: { tag: "update/broken", ok: false } });
  });
});

describe("POST /host/v1/update", () => {
  it("hands Lyrica's request to the updater, and refuses where there is none or one is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-host-updates-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "inbox")); mkdirSync(join(dir, "status"));
    const { host, tls, local } = await startHost({ updateDir: dir, commit: "a".repeat(40) });
    cleanup.push(() => host.close());
    const me = lyrica();
    const made = await fetch(`http://127.0.0.1:${local}/dashboard/pairing`, { method: "POST" }).then((r) => r.json() as Promise<{ code: string }>);
    const fp = await pair(tls, me, made.code);
    const post = (tag: unknown) => call({ port: tls, path: "/host/v1/update", identity: me, pinned: fp, method: "POST", body: { tag } });

    writeFileSync(join(dir, "status", "state.json"), JSON.stringify({ available: false, reason: "Update this host from its NixOS configuration." }));
    expect(await post("update/two")).toMatchObject({ status: 409, body: { error: { code: "unavailable", message: "Update this host from its NixOS configuration." } } });

    writeFileSync(join(dir, "status", "state.json"), JSON.stringify({ available: true, state: "idle" }));
    expect((await post("../x")).status).toBe(400);
    const ok = await post("update/two");
    expect(ok.status).toBe(202);
    expect(ok.body.update).toMatchObject({ available: true, state: "requested" });
    expect(JSON.parse(readFileSync(join(dir, "inbox", "request.json"), "utf8"))).toEqual({ tag: "update/two" });
    expect((await post("update/two")).body).toMatchObject({ error: { code: "updating" } });

    const status = await call({ port: tls, path: "/host/v1/status", identity: me, pinned: fp });
    expect(status.body).toMatchObject({ commit: "a".repeat(40), update: { state: "requested" } });
  });
});
