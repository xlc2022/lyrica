import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openEncrypted } from "@lyrica/core";

// The updater's scripts (daemon/deploy/updater) against a temporary prefix,
// as an unprivileged user: a local git remote, a stand-in build and smoke
// test, a fake systemctl, and a fake lyricad answering on update.sock.

const UPDATER = fileURLToPath(new URL("../deploy/updater", import.meta.url));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

type Schema = { self: number; user: number; pool: number };
const S = (self: number, user: number, pool: number): Schema => ({ self, user, pool });

async function world() {
  const root = mkdtempSync(join(tmpdir(), "lyrica-updater-"));
  // Releases are read-only: writable again first, for a non-root run.
  cleanup.push(() => { execFileSync("chmod", ["-R", "u+w", root]); rmSync(root, { recursive: true, force: true }); });
  const d = (p: string) => { mkdirSync(join(root, p), { recursive: true }); return join(root, p); };
  const prefix = d("opt"), state = d("state"), update = d("update"), snapshots = d("snapshots"), fake = d("fake"), origin = join(root, "origin.git");

  // systemctl: lyricad's state in a file, every call logged.
  writeFileSync(join(fake, "systemctl"), `#!/usr/bin/env bash
echo "$*" >>"${fake}/calls"
case "$1" in
  is-active) cat "${fake}/lyricad" 2>/dev/null || echo inactive ;;
  stop) echo inactive >"${fake}/lyricad" ;;
  start) echo active >"${fake}/lyricad" ;;
  show) echo 4242 ;;
esac
`);
  // The build: RELEASE.json's version comes from \`node bin/lyrica version --json\`; here, schema.json in the commit.
  writeFileSync(join(fake, "node"), `#!/usr/bin/env bash\njq -c '{version: "0.1.0", build: "x", schema: .schema, minReader: .minReader}' schema.json\n`);
  writeFileSync(join(fake, "build"), "#!/usr/bin/env bash\ntouch \"$1/built\"\n");
  for (const f of ["systemctl", "node", "build"]) chmodSync(join(fake, f), 0o755);
  writeFileSync(join(fake, "lyricad"), "active\n");

  // Her data: two databases, and the update socket's fake lyricad.
  mkdirSync(join(state, "users", "u1"), { recursive: true });
  writeFileSync(join(state, "self.db"), "self v0");
  writeFileSync(join(state, "users", "u1", "user.db"), "user v0");
  const lyricad = { busy: [] as unknown[], drains: 0, undrains: 0 };
  const server: Server = createServer((req, res) => {
    const json = (b: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
    if (req.url === "/health") {
      const broken = existsSync(join(prefix, "current", "BROKEN"));
      return json({ commit: "x", locked: false, checks: [{ name: "databases", ok: true }, { name: "web", ok: !broken }] });
    }
    if (req.url === "/drain") { lyricad.drains++; return json({ busy: lyricad.busy }); }
    if (req.url === "/undrain") { lyricad.undrains++; return json({ ok: true }); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(join(state, "update.sock"), r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));

  // The repository: main, and update tags on it.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: join(root, "work"), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  mkdirSync(join(root, "work"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "T");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);
  execFileSync("git", ["init", "-q", "--bare", join(prefix, "repo.git")]);
  execFileSync("git", ["--git-dir", join(prefix, "repo.git"), "remote", "add", "origin", origin]);
  const release = (name: string, schema: Schema, minReader: Schema, o: { broken?: boolean; branch?: string; lightweight?: boolean } = {}) => {
    if (o.branch) git("checkout", "-q", "-B", o.branch);
    writeFileSync(join(root, "work", "schema.json"), JSON.stringify({ schema, minReader }));
    if (o.broken) writeFileSync(join(root, "work", "BROKEN"), ""); else rmSync(join(root, "work", "BROKEN"), { force: true });
    git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", name);
    if (o.lightweight) git("tag", `update/${name}`); else git("tag", "-a", `update/${name}`, "-m", `Update ${name}: what it changes`);
    git("push", "-q", "origin", o.branch ?? "main", "--tags");
    if (o.branch) git("checkout", "-q", "main");
    return git("rev-parse", "HEAD" + (o.branch ? `@{0}` : ""));
  };

  const env = {
    ...process.env, PATH: `${fake}:${process.env.PATH}`, LYRICA_TEST: "1", LYRICA_USER: userInfo().username,
    LYRICA_UPDATER_LIB: UPDATER, LYRICA_UPDATER_BIN: UPDATER, LYRICA_PREFIX: prefix, LYRICA_STATE: state, LYRICA_UPDATE_DIR: update,
    LYRICA_SNAPSHOTS: snapshots, LYRICA_SYSTEMCTL: join(fake, "systemctl"), LYRICA_NIX: "", LYRICA_NODE: join(fake, "node"),
    LYRICA_UPDATE_BUILD: join(fake, "build"), LYRICA_UPDATE_SMOKE: "true", LYRICA_DRAIN_POLL: "1", LYRICA_DRAIN_SECONDS: "2",
    LYRICA_PROBATION_SECONDS: "1", LYRICA_PROBATION_POLL: "1",
  };
  const run = (script: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(join(UPDATER, script), args, { env, timeout: 60_000 }, (err, out, errOut) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out, err: errOut }));
  });
  const json = (f: string) => JSON.parse(readFileSync(join(update, f), "utf8"));
  const current = () => readlinkSync(join(prefix, "current")).replace("releases/", "");
  const calls = () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []);
  return { root, prefix, state, update, snapshots, fake, lyricad, release, run, json, current, calls, git };
}

describe("lyrica-update", () => {
  it("installs a tagged release on main through drain, snapshot, switch and probation, and a release that fails its checks rolls back to the old one", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    const first = await w.run("lyrica-update", "--tag", "update/a");
    expect(first.err).toContain("passed probation");
    expect(w.current()).toBe(a);
    expect(w.json("state.json")).toMatchObject({ state: "idle", note: { tag: "update/a", commit: a, message: expect.stringContaining("Update a") } });
    expect(existsSync(join(w.prefix, "releases", a, "built"))).toBe(true);
    expect(w.json("releases.json")).toMatchObject({ current: a, minReader: S(1, 1, 1), releases: [{ commit: a, tag: "update/a", schema: S(1, 1, 1) }] });
    expect(w.calls()).toEqual(expect.arrayContaining(["stop lyricad", "start lyricad"]));
    expect(w.json("releases.json").snapshots).toHaveLength(1);

    const b = w.release("b", S(1, 1, 1), S(1, 1, 1), { broken: true });
    const second = await w.run("lyrica-update", "--tag", "update/b");
    expect(second.code).not.toBe(0);
    expect(second.err).toContain("probation failed: web");
    expect(w.current()).toBe(a);
    const after = w.json("state.json");
    expect(after).toMatchObject({ state: "failed", lastRollback: { from: b, to: a, automatic: true, check: "web" } });
    expect(after.lastRollback.restoredFrom).toBeUndefined();
    expect(existsSync(join(w.update, "probation.json"))).toBe(false);
    // Logs name commits, tags and checks: no update note text, no data.
    expect(second.err).not.toContain("what it changes");
  });

  it("refuses a tag that isn't annotated or whose commit isn't on main, changing nothing", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/a");
    w.release("side", S(1, 1, 1), S(1, 1, 1), { branch: "side" });
    expect((await w.run("lyrica-update", "--tag", "update/side")).err).toContain("not on main");
    w.release("light", S(1, 1, 1), S(1, 1, 1), { lightweight: true });
    expect((await w.run("lyrica-update", "--tag", "update/light")).err).toContain("not an annotated update tag");
    expect(w.current()).toBe(a);
    expect(w.json("state.json")).toMatchObject({ state: "failed" });
  });

  it("waits for a running turn while draining, then gives up cleanly: undrained, lyricad never stopped, nothing switched", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/a");
    const stops = w.calls().filter((c) => c === "stop lyricad").length;
    w.lyricad.busy = [{ kind: "turn", userId: "u1", pool: "general", threadId: "web/x" }];
    w.release("b", S(1, 1, 1), S(1, 1, 1));
    const r = await w.run("lyrica-update", "--tag", "update/b");
    expect(r.err).toContain("gave up");
    expect(w.lyricad.drains).toBeGreaterThan(2);
    expect(w.lyricad.undrains).toBe(1);
    expect(w.calls().filter((c) => c === "stop lyricad").length).toBe(stops);
    expect(w.current()).toBe(a);
    expect(w.json("state.json")).toMatchObject({ state: "failed", error: "drain timed out" });
  });

  it("takes a request lyricad wrote, and refuses a request that is a link", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    mkdirSync(join(w.state, "updates"));
    writeFileSync(join(w.state, "updates", "request.json"), JSON.stringify({ action: "update", tag: "update/a" }));
    expect((await w.run("lyrica-update", "--request")).code).toBe(0);
    expect(w.current()).toBe(a);
    expect(existsSync(join(w.state, "updates", "request.json"))).toBe(false);
    execFileSync("ln", ["-s", join(w.root, "elsewhere"), join(w.state, "updates", "request.json")]);
    expect((await w.run("lyrica-update", "--request")).err).toContain("refused a malformed request");
  });
});

describe("lyrica-update --resume", () => {
  // b is running, its probation cut short by a reboot: probation.json left, state "probation".
  const leftover = async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/a");
    const b = w.release("b", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/b");
    writeFileSync(join(w.update, "probation.json"), JSON.stringify({ from: a, to: b, tag: "update/b", snapshot: "", since: "2026-10-12T00:00:00Z", contract: false }));
    writeFileSync(join(w.update, "state.json"), JSON.stringify({ ...w.json("state.json"), state: "probation" }));
    return { w, a, b };
  };

  it("resumes a probation a reboot left behind and passes it; with none it does nothing", async () => {
    const { w, b } = await leftover();
    const r = await w.run("lyrica-update", "--resume");
    expect(r.code).toBe(0);
    expect(r.err).toContain(`resuming probation of ${b.slice(0, 12)}`);
    expect(r.err).toContain("passed probation");
    expect(existsSync(join(w.update, "probation.json"))).toBe(false);
    expect(w.json("state.json")).toMatchObject({ state: "idle" });
    expect(w.current()).toBe(b);
    expect(await w.run("lyrica-update", "--resume")).toMatchObject({ code: 0, err: "" });
  });

  it("rolls back when a check fails in a resumed probation", async () => {
    const { w, a, b } = await leftover();
    const rel = join(w.prefix, "releases", b);
    execFileSync("chmod", ["u+w", rel]);
    writeFileSync(join(rel, "BROKEN"), "");
    const r = await w.run("lyrica-update", "--resume");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("probation failed: web");
    expect(w.current()).toBe(a);
    expect(w.json("state.json")).toMatchObject({ state: "failed", lastRollback: { from: b, to: a, automatic: true } });
  });

  it("ends a leftover probation when another release runs now, without rolling back", async () => {
    const { w, a, b } = await leftover();
    writeFileSync(join(w.update, "probation.json"), JSON.stringify({ from: b, to: a, tag: "update/a", snapshot: "", since: "2026-10-12T00:00:00Z", contract: false }));
    const r = await w.run("lyrica-update", "--resume");
    expect(r.code).toBe(0);
    expect(r.err).toContain(`probation of ${a.slice(0, 12)} ended: ${b.slice(0, 12)} is running now`);
    expect(existsSync(join(w.update, "probation.json"))).toBe(false);
    expect(w.json("state.json")).toMatchObject({ state: "idle" });
    expect(w.json("state.json").lastRollback).toBeUndefined();
    expect(w.current()).toBe(b);
  });

  it("resumes it before taking a request", async () => {
    const { w } = await leftover();
    const c = w.release("c", S(1, 1, 1), S(1, 1, 1));
    mkdirSync(join(w.state, "updates"));
    writeFileSync(join(w.state, "updates", "request.json"), JSON.stringify({ action: "update", tag: "update/c" }));
    const r = await w.run("lyrica-update", "--request");
    expect(r.code).toBe(0);
    expect(r.err.indexOf("resuming probation")).toBeLessThan(r.err.indexOf(`updating to ${c.slice(0, 12)}`));
    expect(w.current()).toBe(c);
  });
});

describe("lyrica-rollback", () => {
  it("keeps the data across an expand, restores the snapshot across a contract and sets aside what it replaced", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/a");
    const b = w.release("b", S(1, 1, 2), S(1, 1, 1)); // expand
    await w.run("lyrica-update", "--tag", "update/b");
    writeFileSync(join(w.state, "self.db"), "written under b");
    w.lyricad.busy = [];
    expect((await w.run("lyrica-rollback", "--yes", a.slice(0, 7))).code).toBe(0);
    expect(w.current()).toBe(a);
    expect(readFileSync(join(w.state, "self.db"), "utf8")).toBe("written under b");
    expect(w.json("state.json").lastRollback).toMatchObject({ from: b, to: a, automatic: false });

    await w.run("lyrica-rollback", "--yes", b);
    const c = w.release("c", S(1, 1, 3), S(1, 1, 3)); // contract: b can't read what c writes
    await w.run("lyrica-update", "--tag", "update/c");
    expect(w.json("releases.json").minReader).toEqual(S(1, 1, 3));
    const pinned = w.json("releases.json").snapshots.filter((s: { pinned: boolean; released?: string }) => s.pinned && !s.released);
    expect(pinned).toHaveLength(1);
    writeFileSync(join(w.state, "self.db"), "written under c");
    writeFileSync(join(w.state, "self.db-wal"), "c's log");

    const r = await w.run("lyrica-rollback", "--yes", b);
    expect(r.code).toBe(0);
    expect(w.current()).toBe(b);
    expect(readFileSync(join(w.state, "self.db"), "utf8")).toBe("written under b");
    expect(existsSync(join(w.state, "self.db-wal"))).toBe(false);
    const { lastRollback } = w.json("state.json");
    expect(lastRollback).toMatchObject({ from: c, to: b, restoredFrom: pinned[0].at });
    const aside = w.json("releases.json").snapshots.find((s: { kind: string }) => s.kind === "set-aside");
    expect(readFileSync(join(aside.dir, "self.db"), "utf8")).toBe("written under c");
    expect(readFileSync(join(aside.dir, "self.db-wal"), "utf8")).toBe("c's log");
    expect(w.json("releases.json").minReader).toEqual(S(1, 1, 1));

    // A later contract that passes probation releases the set-aside folder like a pinned snapshot: kept 30 days more.
    w.release("d", S(1, 1, 4), S(1, 1, 4));
    await w.run("lyrica-update", "--tag", "update/d");
    const later = w.json("releases.json").snapshots.find((s: { dir: string }) => s.dir === aside.dir);
    expect(later.released).toBeTruthy();
    expect(existsSync(aside.dir)).toBe(true);
    void c;
  });

  it("refuses a release that can't read the databases when no snapshot is old enough, naming the oldest it can go back to", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/a");
    const b = w.release("b", S(1, 1, 2), S(1, 1, 2));
    await w.run("lyrica-update", "--tag", "update/b");
    // Lose the snapshot from before b.
    const releases = w.json("releases.json");
    for (const s of releases.snapshots) rmSync(s.dir, { recursive: true, force: true });
    releases.snapshots = [];
    writeFileSync(join(w.update, "releases.json"), JSON.stringify(releases));
    const r = await w.run("lyrica-rollback", "--yes", a);
    expect(r.err).toContain(`can't read the databases and no kept snapshot is old enough; the oldest release it can go back to is ${b.slice(0, 12)}`);
    expect(w.current()).toBe(b);
  });

  it("acts automatically only while a release is on probation", async () => {
    const w = await world();
    const a = w.release("a", S(1, 1, 1), S(1, 1, 1));
    await w.run("lyrica-update", "--tag", "update/a");
    const r = await w.run("lyrica-rollback", "--auto");
    expect(r).toMatchObject({ code: 0, err: expect.stringContaining("nothing to roll back") });
    expect(w.current()).toBe(a);
  });
});

describe("lyrica-snapshot and lyrica-restore", () => {
  it("refuse while lyricad runs; a snapshot after a crash keeps every committed transaction", async () => {
    const w = await world();
    expect((await w.run("lyrica-snapshot")).err).toContain("stop lyricad first");
    writeFileSync(join(w.fake, "lyricad"), "inactive\n");
    // A database a crash left with its write-ahead log: still open, never checkpointed.
    rmSync(join(w.state, "self.db"));
    const key = { raw: Buffer.alloc(32, 9) };
    const db = openEncrypted(join(w.state, "self.db"), key);
    db.exec("CREATE TABLE t (x TEXT)");
    for (let i = 0; i < 20; i++) db.prepare("INSERT INTO t VALUES (?)").run(`row ${i}`);
    expect(existsSync(join(w.state, "self.db-wal"))).toBe(true);
    const snap = await w.run("lyrica-snapshot");
    expect(snap.code).toBe(0);
    const dir = snap.out.trim();
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.files.map((f: { path: string }) => f.path).sort()).toEqual(["self.db", "self.db-wal", "users/u1/user.db"]);
    db.close();

    // Lost, then restored: every row is there.
    rmSync(join(w.state, "self.db")); rmSync(join(w.state, "self.db-wal"), { force: true });
    expect((await w.run("lyrica-restore", dir)).code).toBe(0);
    const back = openEncrypted(join(w.state, "self.db"), key, { readonly: true });
    expect((back.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(20);
    back.close();

    // A changed snapshot is refused before anything moves.
    writeFileSync(join(dir, "users", "u1", "user.db"), "user v9");
    expect((await w.run("lyrica-restore", dir)).err).toContain("doesn't match its checksum");
    expect(readdirSync(w.snapshots).filter((n) => n.endsWith("set-aside"))).toHaveLength(1);
  });
});

/** lyrica-nixos-start in a world: a fake profile, nix-env and ssh-keygen, and module packages. */
async function nixosWorld() {
  const w = await world();
  writeFileSync(join(w.fake, "lyricad"), "inactive\n");
  const profile = join(w.root, "profile");
  // nix-env -p <profile> --set <path>: the profile is a symlink to the package.
  writeFileSync(join(w.fake, "nix-env"), `#!/usr/bin/env bash\n[ "$3" = --set ] && ln -sfn "$4" "$2"\nexit 0\n`);
  // ssh-keygen ... -f <key>: a stand-in key pair.
  writeFileSync(join(w.fake, "ssh-keygen"), `#!/usr/bin/env bash\nf="\${@: -1}"; echo key >"$f"; echo pub >"$f.pub"\n`);
  for (const f of ["nix-env", "ssh-keygen"]) chmodSync(join(w.fake, f), 0o755);
  const pkg = (name: string, schema: Schema, minReader: Schema) => {
    const dir = join(w.root, "store", name);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "lyrica"), `#!/usr/bin/env bash\necho '${JSON.stringify({ version: "0.1.0", build: "dev", schema, minReader })}'\n`);
    chmodSync(join(dir, "bin", "lyrica"), 0o755);
    return dir;
  };
  const start = (p: string, commit: string) => new Promise<{ code: number; err: string }>((resolve) => {
    execFile(join(UPDATER, "lyrica-nixos-start"), [p, commit], {
      env: { ...process.env, PATH: `${w.fake}:${process.env.PATH}`, LYRICA_USER: userInfo().username, LYRICA_UPDATER_LIB: UPDATER, LYRICA_UPDATER_BIN: UPDATER,
        LYRICA_PREFIX: w.prefix, LYRICA_STATE: w.state, LYRICA_UPDATE_DIR: w.update, LYRICA_SNAPSHOTS: w.snapshots, LYRICA_SYSTEMCTL: join(w.fake, "systemctl"),
        LYRICA_NIX: "1", LYRICA_PROFILE: profile, LYRICA_DEPLOY_KEY: join(w.root, "deploy-key") },
      timeout: 60_000,
    }, (err, _out, errOut) => resolve({ code: err ? 1 : 0, err: errOut }));
  });
  return { w, profile, pkg, start };
}

describe("lyrica-nixos-start", () => {
  it("follows a changed module package into the profile after a snapshot, leaves an Update's choice alone, and restores a snapshot for a package that can't read the databases", async () => {
    const { w, profile, pkg, start } = await nixosWorld();
    const a = pkg("a", S(1, 1, 1), S(1, 1, 1));
    expect((await start(a, "aaaaaaa")).code).toBe(0);
    expect(readlinkSync(profile)).toBe(a);
    expect(readFileSync(join(w.update, "build.env"), "utf8")).toBe("LYRICA_BUILD=aaaaaaa\n");
    expect(existsSync(join(w.root, "deploy-key.pub"))).toBe(true);
    const snaps = () => (w.json("releases.json").snapshots ?? []).filter((s: { kind: string }) => s.kind === "snapshot").length;
    const first = snaps();

    // An Update switched the profile; a restart with the same module package keeps it.
    const updated = pkg("updated", S(1, 1, 1), S(1, 1, 1));
    execFileSync(join(w.fake, "nix-env"), ["-p", profile, "--set", updated]);
    expect((await start(a, "aaaaaaa")).code).toBe(0);
    expect(readlinkSync(profile)).toBe(updated);

    // A new flake: snapshot, then the profile follows. Its contract raises what must read the databases.
    const b = pkg("b", S(2, 2, 2), S(2, 2, 2));
    expect((await start(b, "bbbbbbb")).code).toBe(0);
    expect(readlinkSync(profile)).toBe(b);
    expect(snaps()).toBe(first + 1);
    expect(w.json("releases.json")).toMatchObject({ current: "bbbbbbb", previous: "aaaaaaa", minReader: S(2, 2, 2) });

    // Back to the old flake: it can't read them, so the snapshot taken before b comes back.
    writeFileSync(join(w.state, "self.db"), "self v2");
    expect((await start(a, "aaaaaaa")).err).toContain("can't read the databases: restoring");
    expect(readFileSync(join(w.state, "self.db"), "utf8")).toBe("self v0");
    expect(readlinkSync(profile)).toBe(a);
    expect(w.json("releases.json").minReader).toEqual(S(1, 1, 1));
  });

  it("keeps a newer release an Update installed when a rebuild brings an older commit of its history, and follows a newer one", async () => {
    const { w, profile, pkg, start } = await nixosWorld();
    const c1 = w.release("one", S(1, 1, 1), S(1, 1, 1)), c2 = w.release("two", S(1, 1, 1), S(1, 1, 1));
    const one = pkg("one", S(1, 1, 1), S(1, 1, 1)), two = pkg("two", S(1, 1, 1), S(1, 1, 1));
    expect((await start(two, c2.slice(0, 7))).code).toBe(0);
    expect(readlinkSync(profile)).toBe(two);
    // repo.git has neither commit yet: the script fetches before deciding.
    const r = await start(one, c1.slice(0, 7));
    expect(r.code).toBe(0);
    expect(r.err).toContain(`is older than the running release (${c2.slice(0, 7)})`);
    expect(readlinkSync(profile)).toBe(two);
    expect(w.json("releases.json").current).toBe(c2.slice(0, 7));
    // Recorded, so the next start doesn't ask again; a newer package is followed as before.
    expect((await start(one, c1.slice(0, 7))).err).toBe("");
    const c3 = w.release("three", S(1, 1, 1), S(1, 1, 1));
    const three = pkg("three", S(1, 1, 1), S(1, 1, 1));
    expect((await start(three, c3.slice(0, 7))).code).toBe(0);
    expect(readlinkSync(profile)).toBe(three);
  });
});
