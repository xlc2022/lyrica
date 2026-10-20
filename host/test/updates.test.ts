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
  // Trees are made read-only for others: writable again first.
  cleanup.push(() => { execFileSync("chmod", ["-R", "u+w", root]); rmSync(root, { recursive: true, force: true }); });
  const origin = join(root, "origin.git"), work = join(root, "work"), checkout = join(root, "lyrica"), dir = join(root, "update"), releases = join(root, "releases"), fake = join(root, "fake");
  mkdirSync(fake);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "T");
  mkdirSync(join(work, "host"));
  // Releases are made elsewhere and pushed.
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
  // The person's checkout, installed by hand: its settings, and code root must never run.
  execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "ignore" });
  const modelsA = join(root, "models-a");
  mkdirSync(modelsA);
  writeFileSync(join(checkout, "host", ".env"), `HOST_NAME=box\nHOST_COMMIT=${first}\nMODELS_DIR=${modelsA}\n`);
  writeFileSync(join(checkout, "host", "install.sh"), `#!/usr/bin/env bash\ntouch "${fake}/checkout-ran"\n`);
  chmodSync(join(checkout, "host", "install.sh"), 0o755);
  mkdirSync(join(dir, "status"), { recursive: true });
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "current"), `${join(checkout, "host")}\n`);
  execFileSync("git", ["init", "-q", "--bare", join(dir, "repo.git")]);
  execFileSync("git", ["--git-dir", join(dir, "repo.git"), "remote", "add", "origin", origin]);

  // host-api: its state, and the commit the last install left it on.
  const api = { state: "running", calls: [] as string[] };
  const running = join(fake, "running"), folder = join(fake, "folder");
  writeFileSync(running, first);
  writeFileSync(folder, modelsA);
  const commitNow = () => readFileSync(running, "utf8").trim();
  const folderNow = () => readFileSync(folder, "utf8").trim();
  const server: Server = createServer((req, res) => {
    api.calls.push(`${req.method} ${req.url}`);
    if (req.url === "/host/v1/pause") api.state = "paused";
    if (req.url === "/host/v1/resume") api.state = "running";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ state: api.state, commit: commitNow(), modelsFolder: { path: folderNow() } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  // install.sh, run in the tree: fails on a broken release, as one that doesn't build would,
  // and comes up on a models folder unless it holds a BROKEN mark.
  writeFileSync(join(fake, "install"), `#!/usr/bin/env bash
echo "$(cat version) $PWD $(cat .env | head -n 1) $*" >>"${fake}/installs"
[ ! -e BROKEN ] || exit 1
echo "$LYRICA_HOST_COMMIT" >"${running}"
if [ "\${2:-}" = --models ]; then
  sed -i "s#^MODELS_DIR=.*#MODELS_DIR=$3#" .env
  [ -e "$3/BROKEN" ] || echo "$3" >"${folder}"
fi
`);
  chmodSync(join(fake, "install"), 0o755);

  const env = {
    ...process.env, LYRICA_TEST: "1", LYRICA_HOST_UPDATE_DIR: dir, LYRICA_HOST_RELEASES: releases,
    LYRICA_HOST_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LYRICA_HOST_INSTALL: join(fake, "install"),
    LYRICA_HOST_DRAIN_SECONDS: "2", LYRICA_HOST_PROBATION_SECONDS: "2", LYRICA_HOST_POLL: "1",
  };
  const run = (...args: string[]) => new Promise<{ code: number; err: string }>((resolve) => {
    execFile(UPDATE, args, { env, timeout: 30_000 }, (err, _out, errOut) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, err: errOut }));
  });
  const state = () => JSON.parse(readFileSync(join(dir, "status", "state.json"), "utf8"));
  const installs = () => (existsSync(join(fake, "installs")) ? readFileSync(join(fake, "installs"), "utf8").trim().split("\n") : []);
  const current = () => readFileSync(join(dir, "current"), "utf8").trim();
  return { root, dir, api, first, release, run, state, installs, commitNow, folderNow, current, releases, checkout, fake, modelsA };
}

describe("lyrica-host-update", () => {
  it("takes a request, pauses the host, installs the release and resumes it", async () => {
    const w = await world();
    const two = w.release("two");
    writeFileSync(join(w.dir, "inbox", "request.json"), JSON.stringify({ tag: "update/two" }));
    const r = await w.run("--request");
    expect(r.code, r.err).toBe(0);
    expect(w.commitNow()).toBe(two);
    // From a tree of its own, with the checkout's settings, never the checkout's code.
    expect(w.installs()).toEqual([`two ${join(w.releases, two, "host")} HOST_NAME=box --yes`]);
    expect(w.current()).toBe(join(w.releases, two, "host"));
    expect(existsSync(join(w.fake, "checkout-ran"))).toBe(false);
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
    expect(w.installs().map((l) => l.split(" ")[0])).toEqual(["broken", "one"]);
    expect(w.current()).toBe(join(w.releases, w.first, "host"));
    expect(existsSync(join(w.fake, "checkout-ran"))).toBe(false);
    expect(w.api.state).toBe("running");
    expect(w.state()).toMatchObject({ state: "failed", error: "probation", last: { tag: "update/broken", ok: false } });
  });
});

describe("lyrica-host-update --models", () => {
  it("installs the running commit again on the new folder, from a tree of its own, and resumes the host", async () => {
    const w = await world();
    const b = join(w.root, "models-b");
    mkdirSync(b);
    writeFileSync(join(w.dir, "inbox", "request.json"), JSON.stringify({ models: `${b}/` }));
    const r = await w.run("--request");
    expect(r.code, r.err).toBe(0);
    expect(w.folderNow()).toBe(b);
    expect(w.commitNow()).toBe(w.first);
    expect(w.installs()).toEqual([`one ${join(w.releases, w.first, "host")} HOST_NAME=box --yes --models ${b}`]);
    expect(w.current()).toBe(join(w.releases, w.first, "host"));
    expect(readFileSync(join(w.current(), ".env"), "utf8")).toContain(`MODELS_DIR=${b}\n`);
    expect(existsSync(join(w.fake, "checkout-ran"))).toBe(false);
    expect(w.api.calls).toContain("POST /host/v1/pause");
    expect(w.api.state).toBe("running");
    expect(w.state()).toMatchObject({ state: "idle", last: { models: b, commit: w.first, ok: true } });
    expect(w.state().models).toBeUndefined();

    // Again from the tree it now runs in: the same tree, its own settings.
    const c = join(w.root, "models-c");
    mkdirSync(c);
    expect((await w.run("--models", c)).code).toBe(0);
    expect(w.folderNow()).toBe(c);
    expect(w.current()).toBe(join(w.releases, w.first, "host"));
  });

  it("refuses a folder that doesn't exist, a system folder or one holding the host's own files, and changes nothing", async () => {
    const w = await world();
    const linked = join(w.root, "linked");
    mkdirSync(linked);
    execFileSync("ln", ["-s", "/etc", join(linked, "lyrica")]);
    for (const [path, error] of [
      [join(w.root, "nowhere"), "not a folder"], ["relative/path", "not a folder"], ["/", "a system folder"], ["/etc", "a system folder"],
      ["/usr/share", "a system folder"], [w.root, "holds the host's own files"], [w.dir, "holds the host's own files"],
      [join(w.checkout, "host"), "holds the host's own files"], [linked, "its lyrica subfolder isn't a folder"],
    ] as const) {
      const r = await w.run("--models", path);
      expect(r.code, path).not.toBe(0);
      expect(w.state(), path).toMatchObject({ state: "failed", error });
    }
    expect(w.installs()).toEqual([]);
    expect(w.folderNow()).toBe(w.modelsA);
    expect(w.api.calls).not.toContain("POST /host/v1/pause");
  });

  it("goes back to the old folder when the host doesn't come up on the new one", async () => {
    const w = await world();
    const b = join(w.root, "models-b");
    mkdirSync(b);
    writeFileSync(join(b, "BROKEN"), "");
    const r = await w.run("--models", b);
    expect(r.code).not.toBe(0);
    expect(w.folderNow()).toBe(w.modelsA);
    expect(w.installs().map((l) => l.split(" ").at(-1))).toEqual([b, w.modelsA]);
    expect(readFileSync(join(w.current(), ".env"), "utf8")).toContain(`MODELS_DIR=${w.modelsA}\n`);
    expect(w.api.state).toBe("running");
    expect(w.state()).toMatchObject({ state: "failed", error: "probation", models: b, last: { models: b, ok: false } });
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

    // A new models folder: only from an updater that takes one, and never while it is busy.
    rmSync(join(dir, "inbox", "request.json"));
    const folder = (path: unknown) => call({ port: tls, path: "/host/v1/models-folder", identity: me, pinned: fp, method: "POST", body: { path } });
    expect(await folder("/mnt/big")).toMatchObject({ status: 409, body: { error: { code: "unavailable" } } });
    writeFileSync(join(dir, "status", "state.json"), JSON.stringify({ available: true, changesFolder: true, state: "idle" }));
    expect((await folder("relative")).status).toBe(400);
    expect((await folder("/mnt/big\nMODELS_DIR=/")).status).toBe(400);
    const moved = await folder("/mnt/big");
    expect(moved.status).toBe(202);
    expect(moved.body.update).toMatchObject({ changesFolder: true, state: "requested" });
    expect(JSON.parse(readFileSync(join(dir, "inbox", "request.json"), "utf8"))).toEqual({ models: "/mnt/big" });
    expect((await folder("/mnt/other")).body).toMatchObject({ error: { code: "updating" } });
  });
});
