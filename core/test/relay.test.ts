import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gitEnv, openRelay, type ForgeCredential, type Relay } from "../src/index.ts";

// A run's relay keeps Git tokens in lyricad (docs/workspace.md, "Credentials"):
// git, gh and tea hold placeholders, and the relay swaps in a token only
// for its own repository's paths and its host's API.

const TOKEN = "github_pat_FAKE_relay_0123456789";
const FORGE_TOKEN = "forgejo-token-made-up-for-tests";
const credential = (o: Partial<ForgeCredential>): ForgeCredential =>
  ({ repo: "ada/lyrica", kind: "github", host: "github.com", token: TOKEN, placeholder: "lyrica_placeholder_github", ...o });

let upstream: Server;
const seen: { host: string; url: string; headers: IncomingHttpHeaders }[] = [];
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lyrica-relay-"));
  upstream = createServer((req, res) => {
    req.resume();
    // Basic auth is asked for first, as a Git host does.
    if (!req.headers.authorization && req.url?.includes(".git/")) return res.writeHead(401, { "www-authenticate": 'Basic realm="Git"' }).end();
    seen.push({ host: String(req.headers["x-test-host"] ?? ""), url: req.url ?? "", headers: req.headers });
    res.writeHead(404).end("not here");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => { upstream.close(); rmSync(dir, { recursive: true, force: true }); });

const open = (o: { reaches?: (h: string) => boolean; internet?: boolean } = {}) => openRelay({
  forge: [credential({}), credential({ repo: "ada/notes", kind: "forgejo", host: "forge.lan:3000", token: FORGE_TOKEN, placeholder: "lyrica_placeholder_forge" })],
  reaches: o.reaches ?? (() => true),
  internet: o.internet ?? true,
  upstreams: { "github.com": base, "api.github.com": base, "forge.lan:3000": base },
});

/** CONNECT through the relay: the status line, and the socket when it is open. */
function tunnel(relay: Relay, to: string, capability = relay.capability): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: relay.port, method: "CONNECT", path: to,
      headers: capability ? { "proxy-authorization": `Basic ${Buffer.from(`lyrica:${capability}`).toString("base64")}` } : {} });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket: res.statusCode === 200 ? socket : (socket.destroy(), undefined) }));
    req.on("error", reject);
    req.end();
  });
}

/** An HTTPS request to `to` through the relay, trusting only the run's authority. */
async function through(relay: Relay, to: string, path: string, authorization?: string): Promise<{ status: number; body: string }> {
  const { socket } = await tunnel(relay, to);
  return new Promise((resolve, reject) => {
    const servername = to.replace(/:\d+$/, "");
    const req = httpsRequest({
      host: servername, path, headers: authorization ? { authorization } : {},
      createConnection: () => tlsConnect({ socket: socket!, servername, ca: relay.ca }),
    }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A POST to `to` through the relay, with a JSON body. */
async function postThrough(relay: Relay, to: string, path: string, authorization: string, body: string): Promise<{ status: number; body: string }> {
  const { socket } = await tunnel(relay, to);
  return new Promise((resolve, reject) => {
    const servername = to.replace(/:\d+$/, "");
    const req = httpsRequest({
      host: servername, path, method: "POST",
      headers: { authorization, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      createConnection: () => tlsConnect({ socket: socket!, servername, ca: relay.ca }),
    }, (res) => {
      let out = "";
      res.on("data", (d) => { out += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("a run's relay for Git", () => {
  it("lets git reach its repository with the placeholder and swaps in the token there", async () => {
    const relay = await open();
    try {
      const ca = join(dir, "run.pem");
      writeFileSync(ca, relay.ca!);
      const env = gitEnv([{ name: "ada/lyrica", account: { kind: "github", host: "github.com", account: "ada", token: "lyrica_placeholder_github" } }],
        { url: `http://lyrica:${relay.capability}@127.0.0.1:${relay.port}`, ca });
      seen.length = 0;
      const out = await new Promise<string>((resolve) => execFile("git", ["ls-remote", "https://github.com/ada/lyrica.git"],
        { env: { PATH: process.env.PATH, HOME: dir, ...env } }, (_e, stdout, stderr) => resolve(stdout + stderr)));
      expect(out).not.toContain(TOKEN);
      expect(seen.map((s) => `${s.url} ${s.headers.authorization}`)).toEqual([
        `/ada/lyrica.git/info/refs?service=git-upload-pack Basic ${Buffer.from(`ada:${TOKEN}`).toString("base64")}`,
      ]);
    } finally {
      relay.close();
    }
  });

  it("swaps a placeholder only on its repository's paths and its host's API, and refuses it anywhere else", async () => {
    const relay = await open();
    try {
      seen.length = 0;
      const basic = (p: string) => `Basic ${Buffer.from(`ada:${p}`).toString("base64")}`;
      expect((await through(relay, "api.github.com:443", "/repos/ada/lyrica/pulls", "token lyrica_placeholder_github")).status).toBe(404);
      expect((await through(relay, "forge.lan:3000", "/api/v1/repos/ada/notes", "token lyrica_placeholder_forge")).status).toBe(404);
      expect(seen.map((s) => s.headers.authorization)).toEqual([`token ${TOKEN}`, `token ${FORGE_TOKEN}`]);

      const refused = [
        await through(relay, "github.com:443", "/ada/other.git/info/refs", basic("lyrica_placeholder_github")),
        await through(relay, "github.com:443", "/ada/lyrica.git/../other.git/info/refs", basic("lyrica_placeholder_github")),
        await through(relay, "github.com:443", "/ada/lyrica.git/%2e%2e/other.git/info/refs", basic("lyrica_placeholder_github")),
        await through(relay, "github.com:443", "/ada/lyrica.git/..%2fother.git/info/refs", basic("lyrica_placeholder_github")),
        await through(relay, "forge.lan:3000", "/api/v1/../../ada/other.git/info/refs", basic("lyrica_placeholder_forge")),
        // One account's placeholder on another's host.
        await through(relay, "forge.lan:3000", "/api/v1/user", "token lyrica_placeholder_github"),
        await through(relay, "api.github.com:443", "/user", "Bearer lyrica_placeholder_forge"),
        await through(relay, "github.com:443", "/ada/lyrica.git/info/refs", `Bearer x${"lyrica_placeholder_github"}`),
      ];
      expect(refused.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
      expect(seen).toHaveLength(2);
      // A request with no placeholder goes as it is: a public repository's clone, say.
      expect((await through(relay, "github.com:443", "/ada/other.git/info/refs", "Bearer sk-something-else")).status).toBe(404);
      expect(seen.at(-1)!.headers.authorization).toBe("Bearer sk-something-else");
    } finally {
      relay.close();
    }
  });

  it("opens only for its run, only to its hosts the run reaches, and to gh's downloads only with the internet", async () => {
    const relay = await open({ reaches: (h) => h !== "forge.lan:3000", internet: false });
    try {
      expect((await tunnel(relay, "github.com:443", "")).status).toBe(407);
      expect((await tunnel(relay, "github.com:443", "not-the-capability")).status).toBe(407);
      expect((await tunnel(relay, "forge.lan:3000")).status).toBe(403);
      expect((await tunnel(relay, "example.com:443")).status).toBe(403);
      expect((await tunnel(relay, "objects.githubusercontent.com:443")).status).toBe(403);
      // And nothing once the run is over.
      relay.close();
      await expect(tunnel(relay, "github.com:443")).rejects.toThrow();
    } finally {
      relay.close();
    }
  });
});

describe("a relayed pull request create", () => {
  // Its own upstream: the relay's record reads only the create's number, so a
  // body full of other fields must never reach the callback (docs/briefs/ci-wakes.md).
  let upstream: Server;
  let base: string;
  let githubBody: string;
  const created: { repo: string; number: number }[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      req.resume();
      const isForge = req.url?.includes("/api/v1/repos/ada/notes/pulls");
      const body = isForge ? '{"number": 7, "title": "a secret title", "user": {"login": "ada"}}'
        : req.url?.includes("/ada/lyrica/pulls") ? githubBody : '{"number": 404}';
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(() => { upstream.close(); });

  beforeEach(() => { created.length = 0; githubBody = '{"number": 42, "title": "a secret title", "body": "never kept"}'; });

  const openRecord = () => openRelay({
    forge: [credential({}), credential({ repo: "ada/notes", kind: "forgejo", host: "forge.lan:3000", token: FORGE_TOKEN, placeholder: "lyrica_placeholder_forge" })],
    reaches: () => true, internet: true,
    upstreams: { "github.com": base, "api.github.com": base, "forge.lan:3000": base },
    onPullCreate: (pr) => { created.push(pr); },
  });

  it("records one watch for a GitHub create and one for a Forgejo create, and nothing else is kept", async () => {
    const relay = await openRecord();
    try {
      expect((await postThrough(relay, "api.github.com:443", "/repos/ada/lyrica/pulls", "token lyrica_placeholder_github", "{}")).status).toBe(200);
      expect((await postThrough(relay, "forge.lan:3000", "/api/v1/repos/ada/notes/pulls", "token lyrica_placeholder_forge", "{}")).status).toBe(200);
      expect(created).toEqual([{ repo: "ada/lyrica", number: 42 }, { repo: "ada/notes", number: 7 }]);
    } finally {
      relay.close();
    }
  });

  it("records none for a GET, a non-create path, a foreign repository, or a non-integer number", async () => {
    const relay = await openRecord();
    try {
      // A GET on the create path is not a create.
      expect((await through(relay, "api.github.com:443", "/repos/ada/lyrica/pulls", "token lyrica_placeholder_github")).status).toBe(200);
      // A POST somewhere else is not this repository's create.
      expect((await postThrough(relay, "api.github.com:443", "/repos/ada/lyrica/issues", "token lyrica_placeholder_github", "{}")).status).toBe(200);
      // Another repository's create is forwarded (the API host is the token's own), but not recorded.
      expect((await postThrough(relay, "api.github.com:443", "/repos/ada/other/pulls", "token lyrica_placeholder_github", "{}")).status).toBe(200);
      // A create whose answer has no integer number is not recorded.
      githubBody = '{"number": "42"}';
      expect((await postThrough(relay, "api.github.com:443", "/repos/ada/lyrica/pulls", "token lyrica_placeholder_github", "{}")).status).toBe(200);
      expect(created).toEqual([]);
    } finally {
      relay.close();
    }
  });
});
