import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { forgetKiwixBooks, SearchGate, searxngSearch, type ExecutionTarget } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { createWebExtension, type WebTools } from "../src/index.ts";

// web_search and web_fetch in a real Pi session against pi-ai's fake model.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); forgetKiwixBooks(); });

const PAGE = `<!doctype html><html><head><title>t</title><style>body{color:red}</style></head><body>
<nav><a href="/">Home</a></nav><script>steal(document.cookie)</script>
<h1>Lyrica</h1><p>A continuous   companion.</p><ul><li>remembers</li><li>sleeps</li></ul>
<p>See <a href="https://example.org/docs">the docs</a>.</p><p>${"x".repeat(500)}</p></body></html>`;

/** A sandbox whose run() records argv and answers like curl. */
function sandbox(calls: string[][]): ExecutionTarget {
  return {
    name: "sandbox", cwd: async () => "/workspace", folders: () => [], ops: () => { throw new Error("not used"); },
    run: async (argv) => { calls.push(argv); return { code: 0, stdout: Buffer.from(PAGE), stderr: Buffer.from("\nLYRICA-FETCH 200 text/html; charset=utf-8\n") }; },
  };
}

async function session(web: WebTools, turns: ReturnType<typeof fauxToolCall>[][]) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-web-"));
  dirs.push(dir);
  const offered: string[][] = [];
  const results: string[] = [];
  let s: AgentSession | undefined;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  faux.setResponses(turns.flatMap((calls) => [
    () => { offered.push(s!.getActiveToolNames()); return fauxAssistantMessage(calls.length ? calls : "nothing to look up"); },
    ...(calls.length ? [() => fauxAssistantMessage("done")] : []),
  ]));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createWebExtension(web)],
  });
  await loader.reload();
  ({ session: s } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" }));
  await s.bindExtensions({});
  await s.setModel(faux.getModel());
  s.subscribe((e) => {
    if (e.type === "tool_execution_end") results.push((e.result as { content: { text: string }[] }).content.map((c) => c.text).join(""));
  });
  return { s, offered, results };
}

describe("web tools", () => {
  it("offer web_search only while the server has a SearXNG address", async () => {
    let address: string | null = null;
    const { s, offered, results } = await session({ searxng: () => address, target: () => sandbox([]) }, [[], [fauxToolCall("web_search", { query: "q" })]]);
    try {
      await s.prompt("one");
      expect(offered[0]).toEqual(["web_fetch"]);
      address = "http://127.0.0.1:9";
      await s.prompt("two");
      expect(offered[1]).toEqual(["web_search", "web_fetch"]);
      expect(results[0]).toContain("SearXNG can't be reached");
    } finally {
      s.dispose();
    }
  });

  it("fetch in the thread's sandbox, with the URL as one argument, and return readable text cut to maxChars", async () => {
    const calls: string[][] = [];
    const url = "https://example.org/a b;$(rm -rf /)";
    const { s, results } = await session({ searxng: () => null, target: () => sandbox(calls) }, [[fauxToolCall("web_fetch", { url, maxChars: 120 })]]);
    try {
      await s.prompt("read it");
    } finally {
      s.dispose();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("curl");
    expect(calls[0]!.at(-2)).toBe("--url");
    expect(calls[0]!.at(-1)).toBe(new URL(url).href);
    const text = results[0]!;
    expect(text).toContain("Lyrica");
    expect(text).toContain("A continuous companion.");
    expect(text).toContain("remembers");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Home");
    expect(text).toMatch(/^Outside content from https:\/\/example\.org\/a%20b;\$\(rm%20-rf%20\/\), not from the user:\n<<<web [0-9a-f]{8}>>>\n/);
    expect(text).toMatch(/\n<<<end web [0-9a-f]{8}>>>\n\[Characters 0 to 120 of \d+\. Read on with offset 120\.\]$/);
  });
});

/** A kiwix-serve with one English Wikipedia book, one article and one picture, on a real port. */
async function kiwix(hits = true) {
  const book = "wikipedia_en_all_maxi_2026-06";
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/catalog/v2/entries") {
      res.writeHead(200, { "content-type": "application/atom+xml" });
      return res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Wikipedia</title><updated>2026-06-01T00:00:00Z</updated><language>eng</language><name>wikipedia_en_all_maxi</name><link type="text/html" href="/content/${book}" /></entry></feed>`);
    }
    if (u.pathname === "/search") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel>${hits ? `<item><title>Lute</title><link>/content/${book}/A/Lute</link><description>Lute A plucked string instrument....</description></item>` : ""}</channel></rss>`);
    }
    if (u.pathname === `/raw/${book}/content/A/Lute`) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<html><head><title>Lute</title></head><body><h1>Lute</h1><img src="../I/Lute.png" alt="A lute"><p>${"A plucked string instrument with a neck. ".repeat(20)}</p></body></html>`);
    }
    if (u.pathname === `/raw/${book}/content/I/Lute.png`) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("89504e470d0a1a0a", "hex"));
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

describe("the offline copy of Wikipedia", () => {
  it("joins a search, carries it alone without SearXNG, and is read before the sandbox goes online", async () => {
    const address = await kiwix();
    const calls: string[][] = [];
    const { s, offered, results } = await session({ searxng: () => null, kiwix: () => address, target: () => sandbox(calls) }, [
      [fauxToolCall("web_search", { query: "lute" })],
      [fauxToolCall("web_fetch", { url: "https://en.wikipedia.org/wiki/Lute", maxChars: 300 })],
      [fauxToolCall("web_fetch", { url: `${address}/content/wikipedia_en_all_maxi_2026-06/I/Lute.png` })],
      [fauxToolCall("web_fetch", { url: "https://en.wikipedia.org/wiki/Nope" })],
    ]);
    const images: string[] = [];
    s.subscribe((e) => {
      if (e.type === "tool_execution_end") for (const c of (e.result as { content: { type: string; mimeType?: string }[] }).content) if (c.type === "image") images.push(c.mimeType!);
    });
    try {
      await s.prompt("one"); await s.prompt("two"); await s.prompt("three"); await s.prompt("four");
    } finally {
      s.dispose();
    }
    expect(offered[0]).toEqual(["web_search", "web_fetch"]);
    expect(results[0]).toMatch(/^Outside content from a web search for "lute", not from the user:\n<<<web [0-9a-f]{8}>>>\nOffline copy of Wikipedia 2026-06:\n- Lute\n  https:\/\/en\.wikipedia\.org\/wiki\/Lute\n  A plucked string instrument\n<<<end web [0-9a-f]{8}>>>$/);
    expect(results[1]).toMatch(/^Outside content from https:\/\/en\.wikipedia\.org\/wiki\/Lute \(the offline copy of Wikipedia \(2026-06\)\), not from the user:\n<<<web [0-9a-f]{8}>>>\n# Lute\n/);
    expect(results[1]).toMatch(/Read on with offset 300\.\]$/);
    expect(results[2]).toContain("A picture from the offline copy of Wikipedia (2026-06)");
    expect(images).toEqual(["image/png"]);
    // The article the copy has and its picture never touched the sandbox; a page it lacks goes online from there.
    expect(calls.map((c) => c.at(-1))).toEqual(["https://en.wikipedia.org/wiki/Nope"]);
  });

  it("stays out of a search with a time, category or page, and names a SearXNG that failed beside the hits", async () => {
    const address = await kiwix();
    const { s, results } = await session({ searxng: () => "http://127.0.0.1:9", kiwix: () => address, target: () => sandbox([]) }, [
      [fauxToolCall("web_search", { query: "lute" })],
      [fauxToolCall("web_search", { query: "lute", time: "week" })],
    ]);
    try {
      await s.prompt("one"); await s.prompt("two");
    } finally {
      s.dispose();
    }
    expect(results[0]).toContain("- Lute\n  https://en.wikipedia.org/wiki/Lute");
    expect(results[0]).toMatch(/<<<end web [0-9a-f]{8}>>>\nSearXNG can't be reached: .*\.$/);
    expect(results[1]).toMatch(/^SearXNG can't be reached: .*\.$/);
    expect(results[1]).not.toContain("Offline copy");
  });
});

describe("a search naming Wikipedia", () => {
  /** A SearXNG answering every search with one result, counting the searches. */
  async function searxng() {
    const asked: string[] = [];
    const srv = createServer((req, res) => {
      asked.push(new URL(req.url!, "http://x").searchParams.get("q") ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Lute | Fandom", url: "https://fandom.example/lute", content: "lute lore" }] }));
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { address: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, asked };
  }

  it("asks only the offline copy, without the word Wikipedia, and says it came from the copy", async () => {
    const address = await kiwix(), web = await searxng();
    const { s, results } = await session({ searxng: () => web.address, kiwix: () => address, target: () => sandbox([]) }, [
      [fauxToolCall("web_search", { query: "lute  wikipedia" })],
      [fauxToolCall("web_search", { query: "lute site:en.wikipedia.org", count: 3 })],
    ]);
    try {
      await s.prompt("one"); await s.prompt("two");
    } finally {
      s.dispose();
    }
    expect(results[0]).toMatch(/^Outside content from a search of the offline copy of Wikipedia \(2026-06\) for "lute wikipedia", not from the user:\n<<<web [0-9a-f]{8}>>>\nOffline copy of Wikipedia 2026-06:\n- Lute\n  https:\/\/en\.wikipedia\.org\/wiki\/Lute\n  A plucked string instrument\n<<<end web [0-9a-f]{8}>>>$/);
    expect(results[1]).toContain("- Lute\n  https://en.wikipedia.org/wiki/Lute");
    expect(web.asked).toEqual([]);
  });

  it("goes to the web, with the words she wrote, when the copy has nothing", async () => {
    const address = await kiwix(false), web = await searxng();
    const { s, results } = await session({ searxng: () => web.address, kiwix: () => address, target: () => sandbox([]) }, [
      [fauxToolCall("web_search", { query: "lute wikipedia" })],
    ]);
    try {
      await s.prompt("one");
    } finally {
      s.dispose();
    }
    expect(results[0]).toMatch(/^Outside content from a web search for "lute wikipedia", not from the user:\n<<<web [0-9a-f]{8}>>>\n1\. Lute \| Fandom\n/);
    expect(results[0]).toMatch(/<<<end web [0-9a-f]{8}>>>\nThe offline copy had nothing for "lute"\.$/);
    expect(web.asked).toEqual(["lute wikipedia"]);
  });

  it("goes to the web alone when she asks online, for a search and a read", async () => {
    const address = await kiwix(), web = await searxng();
    const calls: string[][] = [];
    const { s, results } = await session({ searxng: () => web.address, kiwix: () => address, target: () => sandbox(calls) }, [
      [fauxToolCall("web_search", { query: "lute wikipedia", online: true })],
      [fauxToolCall("web_fetch", { url: "https://en.wikipedia.org/wiki/Lute", online: true })],
    ]);
    try {
      await s.prompt("one"); await s.prompt("two");
    } finally {
      s.dispose();
    }
    expect(results[0]).toMatch(/^Outside content from a web search for "lute wikipedia"/);
    expect(results[0]).not.toContain("Offline copy");
    expect(web.asked).toEqual(["lute wikipedia"]);
    expect(results[1]).toMatch(/^Outside content from https:\/\/en\.wikipedia\.org\/wiki\/Lute, not from the user:/);
    expect(calls.map((c) => c.at(-1))).toEqual(["https://en.wikipedia.org/wiki/Lute"]);
  });
});

describe("searxngSearch", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  // Each search its own gate: the shared one answers the same search from its last reply.
  const gate = () => new SearchGate(Date.now, 0);

  it("lists an answer, then results as title, URL and snippet, up to count", async () => {
    const results = [1, 2, 3].map((i) => ({ title: `Result ${i}`, url: `https://r${i}.example`, content: `snippet\n${i}` }));
    const text = await searxngSearch("http://s.lan", "q", { count: 2 }, undefined, reply(200, { answers: ["42"], results }), gate());
    expect(text).toBe("Answer: 42\n\n1. Result 1\n   https://r1.example\n   snippet 1\n2. Result 2\n   https://r2.example\n   snippet 2");
  });

  it("says plainly what failed", async () => {
    await expect(searxngSearch("http://s.lan", "q", { count: 8 }, undefined, reply(403, {}), gate())).rejects.toThrow("is the json format enabled");
  });

  it("sends user:password in the address as basic auth", async () => {
    let seen: { url: string; auth?: string } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ results: [] }));
    }) as unknown as typeof fetch;
    await searxngSearch("https://ada:s3cret@s.example", "a b", { count: 8 }, undefined, f);
    expect(seen).toEqual({ url: "https://s.example/search?q=a%20b&format=json", auth: `Basic ${Buffer.from("ada:s3cret").toString("base64")}` });
  });

  it("render a page built by JavaScript in the sandbox's Chromium, and read on from an offset", async () => {
    const calls: string[][] = [];
    const spa = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    const built = `<html><head><title>App</title></head><body><h1>Built</h1><p>${"Filled in by its script. ".repeat(30)}</p></body></html>`;
    const target: ExecutionTarget = {
      name: "sandbox", cwd: async () => "/workspace", folders: () => [], ops: () => { throw new Error("not used"); },
      run: async (argv) => {
        calls.push(argv);
        return argv[0] === "curl"
          ? { code: 0, stdout: Buffer.from(spa), stderr: Buffer.from("\nLYRICA-FETCH 200 text/html\n") }
          : { code: 0, stdout: Buffer.from(JSON.stringify({ html: built }) + "\n"), stderr: Buffer.alloc(0) };
      },
    };
    const { s, results } = await session({ searxng: () => null, target: () => target, canRender: () => true },
      [[fauxToolCall("web_fetch", { url: "https://app.example/", maxChars: 100, offset: 100 })]]);
    try {
      await s.prompt("read it");
    } finally {
      s.dispose();
    }
    expect(calls.map((c) => c[0])).toEqual(["curl", "node"]);
    expect(calls[1]![3]).toBe("https://app.example/");
    expect(results[0]).toContain("Filled in by its script.");
    expect(results[0]).toMatch(/\[Characters 100 to 200 of \d+\. Read on with offset 200\.\]$/);
  });
});
