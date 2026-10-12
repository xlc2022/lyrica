import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { testMcpServer } from "./mcp-server.ts";
import { keepResult, MCP_RESULT_BYTES, generateSshKey, helperSandbox, nftRules, resolveAddresses, sandboxedTransport, SshTarget, migrate, Users, Workspace, WorkspaceSettings, type HelperSandbox, type MachineConfig } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
  await users.authenticate("li", "pw");
  const host = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-host-")));
  dirs.push(host);
  for (const d of ["shared", "shared/music", "diary", "both"]) mkdirSync(join(host, d));
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  const paths = workspace.allowedPaths;
  paths.allow(li, li.id, "general", join(host, "shared"));
  paths.allow(li, li.id, "private", join(host, "diary"));
  return { keyring, users, li, host, workspace, paths, settings: workspace.settings(li.id) };
}

describe("the front door in a sandbox's rules", () => {
  it("covers this machine's addresses and the front door's other hosts, resolved when the sandbox starts", async () => {
    const front = (await resolveAddresses(["localhost", "192.0.2.10", "::1"]))!;
    expect(front).toEqual(["127.0.0.1", "192.0.2.10"]);
    // Fails closed: a name that has never resolved gives no answer, so the run gets no network.
    expect(await resolveAddresses(["lyrica.invalid"], async () => { throw new Error("NXDOMAIN"); })).toBeUndefined();
    // A name that resolved once keeps that address covered when it moves or stops resolving.
    const at = (...a: string[]) => async () => a.map((address) => ({ address, family: 4 }));
    expect(await resolveAddresses(["moving.example"], at("192.0.2.20"))).toEqual(["192.0.2.20"]);
    expect(await resolveAddresses(["moving.example"], at("192.0.2.21"))).toEqual(["192.0.2.20", "192.0.2.21"]);
    expect(await resolveAddresses(["moving.example"], async () => { throw new Error("SERVFAIL"); })).toEqual(["192.0.2.20", "192.0.2.21"]);
    const rules = nftRules(true, [], [7340, 7341], { addresses: ["10.0.0.5"], services: false, front: [443], frontAddresses: front });
    expect(rules).toContain("ip daddr { 10.0.0.5, 127.0.0.1, 192.0.2.10 } meta l4proto { tcp, udp } th dport { 443 } reject");
    expect(rules).toContain("th dport { 7340, 7341 } reject");
    expect(rules).toContain("ip daddr { 10.0.0.5 } reject");
    // Both come before anything is accepted.
    expect(rules.indexOf("dport { 443 }")).toBeLessThan(rules.indexOf("    accept"));
  });
});

describe("grants", () => {
  it("keep general threads out of private folders", async () => {
    const { li, host, paths, settings } = await setup();
    expect(() => settings.setThread("g1", "general", { grants: [{ path: join(host, "diary"), writable: false }] }))
      .toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: join(host, "shared", "..", "diary"), writable: false }] }))
      .toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: host, writable: false }] })).toThrow(/overlaps a private folder/);
    expect(() => settings.setThread("g1", "general", { grants: [{ path: "/etc", writable: false }] })).toThrow(/not in this user's general folders/);
    // An administrator can't list one folder in both pools either.
    expect(() => paths.allow(li, li.id, "general", join(host, "diary"))).toThrow(/overlaps/);
    expect(() => paths.allow(li, li.id, "private", host)).toThrow(/overlaps/);

    const ok = settings.setThread("g1", "general", { grants: [{ path: join(host, "shared", "music"), writable: true }] });
    expect(ok.grants).toEqual([{ path: join(host, "shared", "music"), writable: true }]);
    expect(settings.thread("g1").grants).toEqual(ok.grants);
  });

  it("let private threads read general folders but not write them", async () => {
    const { host, settings } = await setup();
    expect(() => settings.setThread("p1", "private", { grants: [{ path: join(host, "shared"), writable: true }] })).toThrow(/can only read/);
    settings.setThread("p1", "private", {
      grants: [{ path: join(host, "shared"), writable: false }, { path: join(host, "diary"), writable: true }],
    });
  });

  it("refuse symlinks, Lyrica's runtime and nested grants", async () => {
    const { keyring, li, host, paths, settings } = await setup();
    symlinkSync(join(host, "shared"), join(host, "link"));
    expect(() => paths.allow(li, li.id, "general", join(host, "link"))).toThrow(/symlink/);
    expect(() => paths.allow(li, li.id, "general", keyring.home)).toThrow(/runtime/);
    expect(() => paths.allow(li, li.id, "general", "/")).toThrow(/runtime|overlaps/);
    // The built-in Caddy's runtime directory holds its admin socket, which lyricad's user (and so a sandbox) can open.
    expect(() => paths.allow(li, li.id, "general", "/run")).toThrow(/lyrica-caddy/);
    expect(() => settings.setThread("g1", "general", {
      grants: [{ path: join(host, "shared"), writable: false }, { path: join(host, "shared", "music"), writable: true }],
    })).toThrow(/inside/);
  });

  it("are an administrator's to change, not the user's", async () => {
    const { users, li, host, paths } = await setup();
    const sam = await users.createUser("sam", "pw", profile("Sam"), { admin: false });
    expect(() => paths.allow(sam, sam.id, "general", join(host, "shared"))).toThrow(/only an administrator/);
    expect(() => paths.disallow(sam, li.id, "general", join(host, "shared"))).toThrow(/only an administrator/);
    paths.allow(li, sam.id, "general", join(host, "shared"));
    expect(paths.list(sam.id).general).toEqual([join(host, "shared")]);
    expect(paths.list(li.id).general).toEqual([join(host, "shared")]);
  });

  it("follow each pool's network defaults unless the thread overrides them", async () => {
    const { settings } = await setup();
    expect(settings.network("g1", "general")).toEqual({ internet: true, services: false, hosts: [] });
    expect(settings.network("p1", "private")).toEqual({ internet: false, services: false, hosts: [] });
    settings.setThread("g1", "general", { internet: false, services: true });
    expect(settings.network("g1", "general")).toMatchObject({ internet: false, services: true });
    settings.setThread("p1", "private", { hosts: ["http://nas.lan:8080/api", "192.168.1.0/24"] });
    expect(settings.network("p1", "private").hosts).toEqual(["nas.lan:8080", "192.168.1.0/24"]);
    settings.setDefaultNetwork("private", { internet: true, hosts: ["nas.lan"] });
    expect(settings.network("p2", "private")).toEqual({ internet: true, services: false, hosts: ["nas.lan"] });
    expect(() => settings.setThread("p1", "private", { hosts: ["not a host"] })).toThrow(/can't read host/);
    for (const all of ["0.0.0.0/0", "10.0.0.0/0", "0.0.0.0", "0.0.0.0:443", "255.255.255.255"]) {
      expect(() => settings.setThread("p1", "private", { hosts: [all] }), all).toThrow(/every address|isn't a host/);
    }
    for (const v6 of ["::/0", "::", "fd00::1", "[fd00::1]:80", "http://[fd00::1]:8080/"]) {
      expect(() => settings.setThread("p1", "private", { hosts: [v6] }), v6).toThrow(/IPv6 hosts aren't supported yet/);
    }
  });

  it("let a subagent have its parent's settings or stricter ones, never wider", async () => {
    const { host, settings } = await setup();
    const music = join(host, "shared", "music");
    settings.setThread("parent", "general", {
      grants: [{ path: music, writable: true }], internet: false, services: true, hosts: ["10.0.0.5:80"], mode: "acceptEdits",
    });

    const same = settings.inheritSettings("parent", "child", "general");
    expect(same).toMatchObject({
      grants: [{ path: music, writable: true }], internet: false, services: true, hosts: ["10.0.0.5:80"], mode: "acceptEdits", parent: "parent",
    });
    const narrow = settings.inheritSettings("parent", "child2", "general", { grants: [{ path: music, writable: false }], mode: "ask" });
    expect(narrow).toMatchObject({ grants: [{ path: music, writable: false }], mode: "ask" });

    expect(() => settings.inheritSettings("parent", "c3", "general", { internet: true })).toThrow(/no internet/);
    expect(() => settings.inheritSettings("parent", "c6", "general", { hosts: ["10.0.0.5:80", "10.0.0.6"] })).toThrow(/10.0.0.6 isn't in the parent/);
    expect(settings.inheritSettings("parent", "c7", "general", { hosts: [], services: false })).toMatchObject({ hosts: [], services: false });
    expect(() => settings.inheritSettings("parent", "c4", "general", { mode: "auto" })).toThrow(/permission mode/);
    expect(() => settings.inheritSettings("parent", "c5", "general", { grants: [{ path: join(host, "shared"), writable: false }] }))
      .toThrow(/parent thread's folders/);
    // Widening later, through the thread's own settings, is refused too.
    expect(() => settings.setThread("child2", "general", { grants: [{ path: join(host, "shared"), writable: false }] }))
      .toThrow(/parent thread's folders/);
    expect(() => settings.setThread("child", "general", { internet: null })).toThrow(/no internet/);
    expect(() => settings.setThread("child", "general", { hosts: ["10.0.0.5"] })).toThrow(/isn't in the parent/);
    // Narrowing the parent later narrows what the child may keep.
    settings.setThread("parent", "general", { grants: [{ path: music, writable: false }] });
    expect(() => settings.setThread("child", "general", { grants: [{ path: music, writable: true }] })).toThrow(/read-only in the parent/);
    expect(settings.folderThread("child2")).toBe("parent");
  });

  it("narrow a running child's folders at once when its parent's are narrowed", async () => {
    const { host, settings } = await setup();
    const [shared, music] = [join(host, "shared"), join(host, "shared", "music")];
    mkdirSync(join(host, "shared", "films"));
    const films = join(host, "shared", "films");
    settings.setThread("parent", "general", { grants: [{ path: music, writable: true }, { path: films, writable: true }] });
    settings.inheritSettings("parent", "child", "general");
    settings.inheritSettings("child", "grandchild", "general", { grants: [{ path: music, writable: true }] });
    expect(settings.effective("grandchild").grants).toEqual([{ path: music, writable: true }]);

    // Read-only in the parent: read-only in the child and its own subagent, and it stays so.
    settings.setThread("parent", "general", { grants: [{ path: music, writable: false }, { path: films, writable: true }] });
    expect(settings.effective("child").grants).toEqual([{ path: music, writable: false }, { path: films, writable: true }]);
    expect(settings.effective("grandchild").grants).toEqual([{ path: music, writable: false }]);
    settings.setThread("parent", "general", { grants: [{ path: music, writable: true }, { path: films, writable: true }] });
    expect(settings.effective("grandchild").grants).toEqual([{ path: music, writable: false }]);
    // Taken off the parent: gone from both, and nothing is refused for it.
    settings.setThread("parent", "general", { grants: [{ path: films, writable: true }] });
    expect(settings.effective("child").grants).toEqual([{ path: films, writable: true }]);
    expect(settings.effective("grandchild").grants).toEqual([]);
    expect(() => settings.checkInherited("grandchild", "general")).not.toThrow();
    // Another change to the child carries the narrowing with it, rather than being refused.
    expect(settings.setThread("child", "general", { mode: "ask" }).grants).toEqual([{ path: films, writable: true }]);
    // A parent gaining a folder, or getting back one it lost, gives the child nothing new.
    settings.setThread("parent", "general", { grants: [{ path: shared, writable: true }] });
    expect(settings.effective("child").grants).toEqual([{ path: films, writable: true }]);
    expect(settings.effective("grandchild").grants).toEqual([]);
  });

  it("keep a child's own narrower folders inside a wider parent's", async () => {
    const { host, settings } = await setup();
    const [shared, music] = [join(host, "shared"), join(host, "shared", "music")];
    settings.setThread("parent", "general", { grants: [{ path: shared, writable: true }] });
    settings.inheritSettings("parent", "child", "general", { grants: [{ path: music, writable: false }] });
    expect(settings.effective("child").grants).toEqual([{ path: music, writable: false }]);
    settings.setThread("parent", "general", { grants: [{ path: shared, writable: false }] });
    expect(settings.effective("child").grants).toEqual([{ path: music, writable: false }]);
  });
});

describe("never granted", () => {
  it("refuses releases, snapshots, the updater's state and update requests, whenever they were listed", async () => {
    const { keyring, li, paths } = await setup();
    for (const never of ["/opt/lyrica", "/opt/lyrica/releases/abc", "/var/lib/lyrica-snapshots", "/var/lib/lyrica-update", join(keyring.home, "updates")]) {
      expect(() => paths.allow(li, li.id, "general", never), never).toThrow(/never granted/);
    }
    // A row listed before a folder became never granted is dropped when read, so the check before each run refuses it.
    keyring.self().prepare("INSERT INTO workspace_paths (user_id, pool, path) VALUES (?, 'general', '/opt/lyrica')").run(li.id);
    expect(paths.list(li.id).general).not.toContain("/opt/lyrica");
  });
});

describe("Git accounts and repositories", () => {
  const TOKEN = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";
  /** A forge that knows one token per account, by its Authorization header. */
  const forge = (tokens: Record<string, string>, repos: string[] = []): typeof fetch => (async (url: string | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^(Bearer|token) /, "");
    const login = Object.entries(tokens).find(([, t]) => t === auth)?.[0];
    if (!login) return new Response("{}", { status: 401 });
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/user")) return Response.json({ login });
    if (path.endsWith("/user/repos")) return Response.json(repos.map((full_name) => ({ full_name })));
    return Response.json({ data: repos.map((full_name) => ({ full_name })) });
  }) as typeof fetch;

  async function withAccounts(fetch = forge({ "lyrica-bot": TOKEN, li: "li-token", forge: "forge-token" })) {
    const s = await setup();
    const workspace = new Workspace(s.keyring, s.users, { excludePorts: [], forgeFetch: fetch });
    const settings = workspace.settings(s.li.id);
    // IP hosts: no resolver needed; 127.0.0.1 is her own machine, 192.0.2.7 is outside her network.
    settings.addGitAccount({ name: "bot", kind: "github", host: "github.com", account: "lyrica-bot", token: TOKEN, pool: "general", offNetwork: true });
    settings.addGitAccount({ name: "li", kind: "github", host: "github.com", account: "li", token: "li-token", pool: "general", offNetwork: true });
    settings.addGitAccount({ name: "forge", kind: "forgejo", host: "127.0.0.1:3000", account: "forge", token: "forge-token", pool: "private", offNetwork: false });
    return { ...s, workspace, settings, thread: (threadId: string, pool: "general" | "private" = "general") => ({ userId: s.li.id, pool, threadId }) };
  }

  it("keeps a GitHub account general and a private account on her network unless Li confirms", async () => {
    const { li, workspace, settings } = await withAccounts();
    const add = (name: string, host: string, pool: "general" | "private", more = {}) =>
      workspace.addGitAccount(li.id, { name, kind: "gitea", host, account: "forge", token: "forge-token", pool, ...more });
    await expect(workspace.addGitAccount(li.id, { name: "gh", kind: "github", host: "github.com", account: "li", token: "li-token", pool: "private" }))
      .rejects.toThrow(/GitHub account is general/);
    expect(() => settings.updateGitAccount("li", { pool: "private" })).toThrow(/GitHub account is general/);
    await expect(add("away", "192.0.2.7", "private")).rejects.toThrow(/outside your network/);
    expect((await add("away", "192.0.2.7", "private", { offNetworkConfirmed: true })).offNetwork).toBe(true);
    expect((await add("home", "https://127.0.0.1:3000/", "private")).host).toBe("127.0.0.1:3000");
    // The token is checked first: a wrong one, or another account's, saves nothing.
    await expect(workspace.addGitAccount(li.id, { name: "x", kind: "github", host: "github.com", account: "li", token: "nope", pool: "general" })).rejects.toThrow(/rejected the token/);
    await expect(workspace.addGitAccount(li.id, { name: "x", kind: "github", host: "github.com", account: "li", token: TOKEN, pool: "general" })).rejects.toThrow(/lyrica-bot's, not li's/);
    expect(settings.gitAccount("x")).toBeUndefined();
    expect(settings.gitAccount("home")!.state?.kind).toBe("signedIn");
  });

  it("gives a repository's token only to a sandbox of its pool, in a thread that has it, that can reach its host, and each account only its own", async () => {
    const { workspace, settings, thread } = await withAccounts();
    expect(() => settings.setThread("p", "private", { repositories: [{ name: "xlc2022/lyrica", account: "li" }] })).toThrow(/general Git account; a private thread/);
    expect(() => settings.setThread("g", "general", { repositories: [{ name: "li/notes", account: "forge" }] })).toThrow(/private Git account; a general thread/);
    expect(() => settings.setThread("g", "general", { repositories: [{ name: "../x", account: "li" }] })).toThrow(/owner\/name/);

    settings.setThread("code", "general", { repositories: [{ name: "xlc2022/lyrica", account: "li" }, { name: "lyrica-bot/scratch.git", account: "bot" }] });
    const env = workspace.forgeEnv(thread("code"));
    const helpers = Object.entries(env).filter(([k]) => k.startsWith("GIT_CONFIG_KEY_")).map(([k, v]) => [v, env[k.replace("KEY", "VALUE")]]);
    expect(helpers.map(([k]) => k)).toEqual([
      "credential.https://github.com.useHttpPath", "credential.https://github.com/xlc2022/lyrica.git.helper", "credential.https://github.com/lyrica-bot/scratch.git.helper",
    ]);
    // Each helper reads its own pair of variables, so two accounts on one host never mix.
    expect(helpers[1]![1]).toContain("$LYRICA_GIT_TOKEN_0");
    expect(env).toMatchObject({ LYRICA_GIT_USER_0: "li", LYRICA_GIT_TOKEN_0: "li-token", LYRICA_GIT_USER_1: "lyrica-bot", LYRICA_GIT_TOKEN_1: TOKEN, LYRICA_GIT_COUNT: "2",
      LYRICA_GIT_REPO_0: "github.com/xlc2022/lyrica", LYRICA_GIT_KIND_0: "github", LYRICA_GIT_REPO_1: "github.com/lyrica-bot/scratch" });
    // GH_TOKEN is one value, so it is never set: the gh wrapper picks by the clone (core/test/forge.test.ts).
    expect(env.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("forge-token");
    expect(workspace.repositoriesFor(thread("code")).map((r) => r.path)).toEqual(["/workspace/repos/lyrica", "/workspace/repos/scratch"]);

    // Without the repository, or without a way to its host.
    expect(workspace.forgeEnv(thread("other"))).toEqual({});
    settings.setThread("code", "general", { internet: false });
    expect(workspace.forgeEnv(thread("code"))).toEqual({});
    settings.setThread("code", "general", { hosts: ["github.com"] });
    expect(workspace.forgeEnv(thread("code")).LYRICA_GIT_TOKEN_0).toBe("li-token");

    // A private thread: only with the host allowed, and only its private account's token, for tea.
    settings.setThread("p", "private", { repositories: [{ name: "li/notes", account: "forge" }] });
    expect(workspace.forgeEnv(thread("p", "private"))).toEqual({});
    settings.setThread("p", "private", { hosts: ["127.0.0.1:3000"] });
    expect(workspace.forgeEnv(thread("p", "private"))).toMatchObject({ LYRICA_GIT_COUNT: "1", LYRICA_GIT_TOKEN_0: "forge-token", LYRICA_GIT_REPO_0: "127.0.0.1:3000/li/notes", LYRICA_GIT_KIND_0: "forgejo" });
    expect(JSON.stringify(workspace.forgeEnv(thread("p", "private")))).not.toContain("li-token");
  });

  it("takes a removed account's repositories, or one taken off a project, from its running threads at once", async () => {
    const { settings } = await withAccounts();
    const lyrica = { name: "xlc2022/lyrica", account: "li" };
    const scratch = { name: "lyrica-bot/scratch", account: "bot" };
    settings.setThread("project", "general", { repositories: [lyrica, scratch] });
    settings.inheritSettings("project", "thread", "general");
    expect(settings.effective("thread").repositories).toEqual([lyrica, scratch]);
    expect(() => settings.setThread("thread", "general", { repositories: [lyrica, scratch, { name: "li/other", account: "li" }] })).toThrow(/isn't in the parent thread's repositories/);
    settings.setThread("project", "general", { repositories: [lyrica] });
    expect(settings.effective("thread").repositories).toEqual([lyrica]);
    // Given back to the project, it doesn't come back to the thread.
    settings.setThread("project", "general", { repositories: [lyrica, scratch] });
    expect(settings.effective("thread").repositories).toEqual([lyrica]);
    settings.removeGitAccount("li");
    expect(settings.effective("project").repositories).toEqual([scratch]);
    expect(settings.effective("thread").repositories).toEqual([]);
    // A new pool, or a new name, follows too.
    settings.updateGitAccount("bot", { name: "robot" });
    expect(settings.effective("project").repositories).toEqual([{ ...scratch, account: "robot" }]);
    settings.addGitAccount({ name: "gitea", kind: "gitea", host: "127.0.0.1", account: "li", token: "t", pool: "general", offNetwork: false });
    settings.setThread("project", "general", { repositories: [{ ...scratch, account: "robot" }, { name: "li/notes", account: "gitea" }] });
    settings.updateGitAccount("gitea", { pool: "private" });
    expect(settings.effective("project").repositories).toEqual([{ ...scratch, account: "robot" }]);
  });

  it("lists what an account can see, and records a rejected token", async () => {
    const { li, workspace, settings } = await withAccounts(forge({ li: "li-token", "lyrica-bot": TOKEN }, ["xlc2022/lyrica", "xlc2022/dotfiles"]));
    expect(await workspace.listRepositories(li.id, "li", "dot")).toEqual([{ name: "xlc2022/dotfiles", account: "li" }]);
    settings.addGitAccount({ name: "old", kind: "gitea", host: "127.0.0.1", account: "li", token: "expired", pool: "general", offNetwork: false });
    await expect(workspace.listRepositories(li.id, "old")).rejects.toThrow(/rejected the token/);
    expect(settings.gitAccount("old")!.state?.kind).toBe("rejected");
    await expect(workspace.setGitToken(li.id, "old", "wrong")).rejects.toThrow(/rejected/);
    expect(settings.gitAccount("old")!.token).toBe("expired");
  });
});

describe("MCP servers", () => {
  it("checks a server before saving it, and keeps a private one on her network unless Li confirms", async () => {
    const { li, workspace, settings } = await setup();
    const house = await testMcpServer({ token: "ha-token", instructions: "Home Assistant: lights and sensors.\nMore." });
    try {
      await expect(workspace.addMcpServer(li.id, { name: "house", url: house.url, token: "wrong", pool: "private" })).rejects.toThrow(/rejected the token/);
      expect(settings.mcpServer("house")).toBeUndefined();
      await expect(workspace.addMcpServer(li.id, { name: "away", url: "http://192.0.2.7/mcp", pool: "private" })).rejects.toThrow(/outside your network/);
      await expect(workspace.addMcpServer(li.id, { name: "plain", url: house.url, token: "ha-token", pool: "general" })).rejects.toThrow(/only over https/);
      await expect(workspace.addMcpServer(li.id, { name: "local", url: "stdio:npx server", pool: "private" })).rejects.toThrow(/local servers/);
      const m = await workspace.addMcpServer(li.id, { name: "house", url: house.url, token: "ha-token", pool: "private" });
      expect(m).toMatchObject({ tools: 2, description: "Home Assistant: lights and sensors.", offNetwork: false, state: { kind: "online" } });
      // Names that are one server to Pi.
      settings.addMcpServer({ name: "my-house", url: house.url, token: "", pool: "private", description: null, tools: 0, offNetwork: false });
      expect(() => settings.addMcpServer({ name: "my_house", url: house.url, token: "", pool: "private", description: null, tools: 0, offNetwork: false })).toThrow(/already exists/);
    } finally {
      await house.close();
    }
  });

  it("never gives a private thread a general server, and takes one off a project from its running threads at once", async () => {
    const { li, settings, workspace } = await setup();
    settings.addMcpServer({ name: "docs", url: "https://mcp.example.com/mcp", token: "t", pool: "general", description: null, tools: 3, offNetwork: true });
    settings.addMcpServer({ name: "house", url: "http://127.0.0.1:8123/mcp", token: "", pool: "private", description: null, tools: 2, offNetwork: false });
    expect(() => settings.setThread("p", "private", { mcpServers: ["docs"] })).toThrow(/general MCP server; a private thread/);
    expect(() => settings.setThread("g", "general", { mcpServers: ["house"] })).toThrow(/private MCP server; a general thread/);
    settings.setThread("p", "private", { mcpServers: ["house"] });
    // An older row of the wrong pool still gives nothing.
    expect(workspace.mcpServersFor({ userId: li.id, pool: "general", threadId: "p" })).toEqual([]);
    expect(workspace.mcpServersFor({ userId: li.id, pool: "private", threadId: "p" }).map((m) => m.name)).toEqual(["house"]);

    settings.addMcpServer({ name: "cal", url: "https://cal.example.com/mcp", token: "", pool: "general", description: null, tools: 1, offNetwork: true });
    settings.setThread("project", "general", { mcpServers: ["docs", "cal"] });
    settings.inheritSettings("project", "thread", "general");
    const running = () => workspace.mcpServersFor({ userId: li.id, pool: "general", threadId: "thread" }).map((m) => m.name);
    expect(running()).toEqual(["docs", "cal"]);
    settings.setThread("project", "general", { mcpServers: ["cal"] });
    expect(running()).toEqual(["cal"]);
    settings.setThread("project", "general", { mcpServers: ["docs", "cal"] });
    expect(running()).toEqual(["cal"]);
    settings.allowToolInThread("thread", "cal", "add_event");
    settings.updateMcpServer("cal", { name: "calendar" });
    expect(running()).toEqual(["calendar"]);
    expect(settings.toolAllowedInThread("thread", "calendar", "add_event")).toBe(true);
    settings.removeMcpServer("calendar");
    expect(running()).toEqual([]);
    expect(settings.toolAllowedInThread("thread", "calendar", "add_event")).toBe(false);
  });

  it("cuts a long result before Pi sees it and names a binary resource instead of keeping it", () => {
    const long = keepResult({ content: [{ type: "text", text: "a".repeat(30_000) }] }) as { content: { text: string }[] };
    expect(Buffer.byteLength(long.content[0]!.text)).toBeLessThanOrEqual(MCP_RESULT_BYTES);
    expect(long.content[0]!.text).toMatch(/bytes cut/);
    const blob = keepResult({ content: [{ type: "resource", resource: { uri: "file:///x.pdf", mimeType: "application/pdf", blob: "AAAA" } }] }) as { content: { type: string; text: string }[] };
    expect(blob.content).toEqual([{ type: "text", text: "[A binary resource, file:///x.pdf, not shown]" }]);
  });
});

describe("modes and switches", () => {
  it("renames stored modes in place and adds the switches, on", async () => {
    const { users, li } = await setup();
    const db = users.openUserDb(li.id);
    db.exec(`DROP TABLE IF EXISTS thread_workspaces;
      CREATE TABLE thread_workspaces (thread_id TEXT PRIMARY KEY, grants TEXT NOT NULL, internet INTEGER, services INTEGER, hosts TEXT, mode TEXT NOT NULL, target TEXT NOT NULL, parent TEXT);
      INSERT INTO thread_workspaces VALUES ('a', '[]', NULL, NULL, NULL, 'ask-changes', 'sandbox', NULL),
        ('b', '[]', NULL, NULL, NULL, 'ask-commands', 'sandbox', NULL), ('c', '[]', NULL, NULL, NULL, 'auto', 'sandbox', NULL);
      PRAGMA user_version = 0;`);
    migrate(db, "user");
    const settings = new WorkspaceSettings(db, () => ({ general: [], private: [] }));
    expect(["a", "b", "c"].map((id) => settings.thread(id).mode)).toEqual(["ask", "acceptEdits", "auto"]);
    expect(settings.thread("a")).toMatchObject({ webSearch: true, images: true });
    settings.close();
  });

  it("starts new threads in the user's default mode", async () => {
    const { settings } = await setup();
    expect(settings.defaultMode()).toBe("auto");
    settings.setDefaultMode("plan");
    expect(settings.startThread("t1", "general").mode).toBe("plan");
    settings.setDefaultMode("ask");
    // A thread keeps the mode it started in.
    expect(settings.thread("t1").mode).toBe("plan");
    expect(settings.startThread("t2", "general").mode).toBe("ask");
    expect(() => settings.setDefaultMode("ask-changes" as never)).toThrow(/unknown permission mode/);
    // A thread from before modes were saved keeps Auto, whatever the default.
    expect(settings.thread("old").mode).toBe("auto");
  });

  it("give a subagent or child thread its parent's mode and switches or stricter ones, also when the parent changes later", async () => {
    const { settings } = await setup();
    settings.setThread("parent", "general", { mode: "ask", images: false });
    expect(settings.inheritSettings("parent", "child", "general")).toMatchObject({ mode: "ask", webSearch: true, images: false });
    // A child of an Ask thread can't run in Auto, or turn back on what its parent has off.
    expect(() => settings.inheritSettings("parent", "c2", "general", { mode: "auto" })).toThrow(/permission mode is ask/);
    expect(() => settings.setThread("child", "general", { mode: "acceptEdits" })).toThrow(/permission mode is ask/);
    expect(() => settings.setThread("child", "general", { images: true })).toThrow(/images off/);
    expect(settings.setThread("child", "general", { mode: "plan", webSearch: false })).toMatchObject({ mode: "plan", webSearch: false });
    settings.setThread("child", "general", { mode: "ask", webSearch: true });
    // What applies follows the parent as it is now, and every ancestor.
    settings.inheritSettings("child", "grandchild", "general");
    settings.setThread("parent", "general", { mode: "plan", webSearch: false });
    expect(settings.effective("grandchild")).toMatchObject({ mode: "plan", webSearch: false, images: false });
    expect(settings.thread("grandchild")).toMatchObject({ mode: "ask", webSearch: true });
  });
});

const unreachable: MachineConfig = {
  name: "nas", kind: "ssh", host: "127.0.0.1", port: 1, username: "lyrica", privateKey: generateSshKey("test").privateKey, root: null,
  hostKey: `SHA256:${"A".repeat(43)}`, pool: "general", limit: "ask", offNetwork: false, lastUsed: null, state: null,
};
/** The real client: a sandboxed helper per connection. */
const helper = (sandbox: HelperSandbox = { exclude: [] }) => ({ transport: sandboxedTransport(() => sandbox) });

describe("ssh machines", () => {

  it("fail without falling back to local execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-ssh-"));
    dirs.push(dir);
    const marker = join(dir, "ran-locally");
    const ops = new SshTarget(unreachable, helper()).ops();
    await expect(ops.bash.exec(`touch ${marker}`, dir, { onData: () => {} })).rejects.toThrow(/ssh nas/);
    await expect(ops.write.writeFile(marker, "x")).rejects.toThrow(/ssh nas/);
    await expect(ops.read.readFile("/etc/hostname")).rejects.toThrow(/ssh nas/);
    expect(existsSync(marker)).toBe(false);
  });

  it("fail when the SSH helper can't start, with no client in lyricad to fall back to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-ssh-"));
    dirs.push(dir);
    const marker = join(dir, "ran-locally");
    for (const sandbox of [{ exclude: [], bwrap: "/nonexistent/bwrap", pasta: "/nonexistent/pasta" }, { exclude: [], refused: "the sandbox flushed the rules" }]) {
      const ops = new SshTarget(unreachable, helper(sandbox)).ops();
      await expect(ops.bash.exec(`touch ${marker}`, dir, { onData: () => {} })).rejects.toThrow(/ssh nas: .*(SSH helper|no sandbox)/);
      await expect(ops.read.readFile("/etc/hostname")).rejects.toThrow(/ssh nas/);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("keep file tools inside the root", async () => {
    const ops = new SshTarget({ ...unreachable, root: "/srv/lyrica" }, helper()).ops();
    await expect(ops.read.readFile("/srv/lyrica/../etc/passwd")).rejects.toThrow(/outside \/srv\/lyrica/);
    await expect(ops.write.writeFile("/etc/passwd", "x")).rejects.toThrow(/outside/);
  });

  it("are granted per thread and stored with the user's settings", async () => {
    const { keyring, users, li, settings } = await setup();
    settings.addMachine({ ...unreachable, root: "/srv/lyrica" }, unreachable.hostKey!);
    settings.setThread("t1", "general", { machines: ["nas"] });
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const thread = { userId: li.id, pool: "general" as const, threadId: "t1" };
    expect(workspace.targetFor(thread, "nas").name).toBe("ssh:nas");
    expect(workspace.folders(thread)).toEqual(["nas:/srv/lyrica"]);
    expect(() => settings.setThread("t1", "general", { machines: ["nope"] })).toThrow(/no machine nope/);
  });
});

/** Waits until something accepts connections on `port`, or `server` exits. */
async function listening(port: number, server: ReturnType<typeof spawn>, log: () => string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`sshd exited: ${log()}`);
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1", () => { s.end(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`sshd isn't listening: ${log()}`);
}

// A real round trip against a throwaway sshd, run as the current user, through
// the sandboxed helper. Skipped where sshd, bwrap or pasta isn't installed or
// the tests run as root; CI has them all.
const sshd = "/usr/sbin/sshd";
const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };
const helperRunnable = existsSync(sshd) && process.getuid?.() !== 0 && has("bwrap") && has("pasta") && has("nft");
if (process.env.LYRICA_SANDBOX_TESTS === "require" && !helperRunnable) throw new Error("ssh tests required but sshd, bwrap, pasta or nft is missing");
describe.skipIf(!helperRunnable)("an ssh target", () => {
  it("reads, writes, edits and runs commands remotely, with the confirmed host key", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-sshd-")));
    dirs.push(dir);
    const key = generateSshKey("lyrica");
    const hostKey = generateSshKey("host");
    writeFileSync(join(dir, "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "host_key"), hostKey.privateKey, { mode: 0o600 });
    writeFileSync(join(dir, "sshd_config"), "Subsystem sftp internal-sftp\n"); // the system's may include files only root can read
    mkdirSync(join(dir, "root"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = spawn(sshd, ["-D", "-e", "-f", join(dir, "sshd_config"), "-p", String(port), "-h", join(dir, "host_key"), "-o", `AuthorizedKeysFile=${join(dir, "authorized_keys")}`,
      "-o", "StrictModes=no", "-o", "UsePAM=no", "-o", `PidFile=${join(dir, "pid")}`, "-o", "ListenAddress=127.0.0.1"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    server.stderr.on("data", (d: Buffer) => { log += d.toString(); });
    try {
      await listening(port, server, () => log);
      // Probing reads the key the server shows, the way Add machine does.
      const { keyring, users, li } = await setup();
      const probe = new Workspace(keyring, users, { excludePorts: [] });
      const first = await probe.probeMachine(li.id, "li", { name: "local", address: `${userInfo().username}@127.0.0.1:${port}` });
      expect(first.fingerprint).toMatch(/^SHA256:/);
      expect(first.login).toBe(false); // the draft's key isn't installed
      expect(first.keyLine).toMatch(/^restrict(,from="[^"]*")? ssh-ed25519 /);
      const target = new SshTarget({
        ...unreachable, name: "local", port, username: userInfo().username, privateKey: key.privateKey, root: join(dir, "root"), hostKey: first.fingerprint!,
      }, helper());
      const ops = target.ops();
      const file = join(dir, "root", "todo.txt");
      await ops.write.writeFile(file, "buy milk\n");
      await ops.edit.access(file);
      expect((await ops.read.readFile(file)).toString()).toBe("buy milk\n");
      // Writes replace the file in one rename, keep its mode and leave no temp file behind.
      chmodSync(file, 0o640);
      await Promise.all([ops.write.writeFile(file, "x".repeat(1 << 20)), ...Array.from({ length: 8 }, () =>
        ops.read.readFile(file).then((b) => expect(["buy milk\n", "x".repeat(1 << 20)]).toContain(b.toString())))]);
      expect(statSync(file).mode & 0o777).toBe(0o640);
      expect(readdirSync(join(dir, "root"))).toEqual(["todo.txt"]);
      symlinkSync(file, join(dir, "root", "link.txt"));
      await expect(ops.write.writeFile(join(dir, "root", "link.txt"), "no")).rejects.toThrow(/is a symlink/);
      rmSync(join(dir, "root", "link.txt"));
      await ops.write.writeFile(file, "buy milk\n");
      let out = "";
      const { exitCode } = await ops.bash.exec("pwd && cat todo.txt", "/elsewhere", { onData: (d) => { out += d.toString(); } });
      expect(exitCode).toBe(0);
      expect(out).toBe(`${join(dir, "root")}\nbuy milk\n`);
      symlinkSync("/etc", join(dir, "root", "etc"));
      await expect(ops.read.readFile(join(dir, "root", "etc", "hostname"))).rejects.toThrow(/leads outside/);
      await expect(ops.write.writeFile(join(dir, "root", ".ssh", "authorized_keys"), "x")).rejects.toThrow(/SSH's or sudo's/);
      target.close();
      const impostor = new SshTarget({ ...target["cfg"], hostKey: `SHA256:${"B".repeat(43)}` }, helper());
      await expect(impostor.ops().read.readFile(file)).rejects.toThrow(/ssh local: its host key changed/);
      await expect(impostor.ops().bash.exec(`touch ${join(dir, "ran-locally")}`, dir, { onData: () => {} })).rejects.toThrow(/host key changed/);
      expect(existsSync(join(dir, "ran-locally"))).toBe(false);
    } finally {
      server.kill();
    }
  });
});

describe.skipIf(!helperRunnable)("the ssh helper's sandbox", () => {
  const servers: Server[] = [];
  const listen = async (host: string, reply: string) => {
    const srv = createServer((c) => c.end(`${reply}\n`));
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, host, resolve));
    return (srv.address() as { port: number }).port;
  };
  afterAll(() => { for (const s of servers) s.close(); });
  const tcp = (host: string, port: number) => `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port} && cat <&3' 2>&1`;
  const run = async (box: ReturnType<typeof helperSandbox>, script: string) =>
    (await box.run(["bash", "-c", script], { timeoutMs: 30_000 })).stdout.toString();

  it("hides lyricad's runtime directory, databases, code and process", async () => {
    const runtime = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-runtime-")));
    dirs.push(runtime);
    writeFileSync(join(runtime, "self.db"), "keys");
    const keyring = fileURLToPath(new URL("../src/keyring.ts", import.meta.url));
    const box = helperSandbox("127.0.0.1", 22, { exclude: [] });
    const helper = fileURLToPath(new URL("../src/workspace/ssh-helper.ts", import.meta.url));
    const out = await run(box, `test -e ${runtime}/self.db && echo SEES-RUNTIME; test -e ${keyring} && echo SEES-CODE; test -e ${helper} && echo HAS-HELPER; echo DONE`);
    expect(out).toContain("DONE");
    expect(out).toContain("HAS-HELPER");
    expect(out).not.toMatch(/SEES-/);
    // Every process it can see: only its own.
    const ps = await run(box, "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f; echo; done");
    expect(ps).toContain("bwrap");
    expect(ps).not.toContain("vitest");
  });

  it("refuses a server without strict key exchange, and sends the key only after the host key is accepted", async () => {
    const hostKey = generateSshKey("host").privateKey;
    const key = generateSshKey("lyrica");
    const serve = async (strict: boolean) => {
      const tried: string[] = [];
      const srv = new ssh2.Server({ hostKeys: [hostKey] }, (c) => {
        c.on("error", () => {});
        c.on("authentication", (ctx) => { tried.push(ctx.method); ctx.method === "publickey" ? ctx.accept() : ctx.reject(["publickey"]); });
        c.on("ready", () => c.end());
      });
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
      const real = (srv.address() as { port: number }).port;
      // ssh2's server always offers strict key exchange. Without it, a proxy in the
      // middle strips the offer from the server's first packet, as a Terrapin attacker would.
      const proxy = createServer((inbound) => {
        const out = connect(real, "127.0.0.1");
        let seen = 0;
        out.on("data", (d: Buffer) => {
          if (!strict && seen < 8192) {
            const at = d.indexOf("kex-strict-s-v00@openssh.com");
            if (at >= 0) d.write("kex-strict-x", at);
          }
          seen += d.length;
          inbound.write(d);
        });
        inbound.pipe(out);
        for (const sock of [inbound, out]) sock.on("error", () => { inbound.destroy(); out.destroy(); });
        out.on("close", () => inbound.destroy());
        inbound.on("close", () => out.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const port = (proxy.address() as { port: number }).port;
      return { port, tried, close: () => { proxy.close(); srv.close(); } };
    };
    const to = (port: number) => ({ host: "127.0.0.1", port, username: "lyrica", privateKey: key.privateKey });
    const transport = sandboxedTransport(() => ({ exclude: [] }));

    // Not strict: refused before the host key is judged or any login is tried.
    const plain = await serve(false);
    let asked = false;
    await expect(transport.connect(to(plain.port), () => { asked = true; return true; })).rejects.toThrow(/strict key exchange/);
    expect(asked).toBe(false);
    expect(plain.tried).toEqual([]);
    plain.close();

    // A host key that isn't the confirmed one: no login is tried, so the key never left lyricad.
    const strict = await serve(true);
    await expect(transport.connect(to(strict.port), () => false)).rejects.toThrow(/host key changed/);
    expect(strict.tried).toEqual([]);
    // Accepted: the key goes, and logs in.
    await transport.connect(to(strict.port), () => true).catch(() => {}); // the server hangs up once she's in
    expect(strict.tried).toContain("publickey");
    strict.close();
  });

  it("reaches only the machine's address and port", async () => {
    const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
    const machine = await listen("0.0.0.0", "MACHINE");
    const other = await listen("0.0.0.0", "OTHER");
    const local = await run(helperSandbox("127.0.0.1", machine, { exclude: [] }), `${tcp("127.0.0.1", machine)}; ${tcp("127.0.0.1", other)}`);
    expect(local).toContain("MACHINE");
    expect(local).not.toContain("OTHER");
    if (lan) {
      // This host's LAN address as the machine: its other ports, and loopback, stay shut.
      const remote = await run(helperSandbox(lan, machine, { exclude: [] }), `${tcp(lan, machine)}; ${tcp(lan, other)}; ${tcp("127.0.0.1", machine)}`);
      expect(remote.match(/MACHINE/g)).toHaveLength(1);
      expect(remote).not.toContain("OTHER");
    }
    // lyricad's own ports stay shut even when they are the machine's.
    expect(await run(helperSandbox("127.0.0.1", machine, { exclude: [machine] }), tcp("127.0.0.1", machine))).not.toContain("MACHINE");
  });
});
