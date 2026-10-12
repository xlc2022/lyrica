import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { searxngSearch, type ExecutionTarget } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { createWebExtension, type WebTools } from "../src/index.ts";

// web_search and web_fetch in a real Pi session against pi-ai's fake model.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

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
    expect(text).toMatch(/\[Cut at 120 of \d+ characters\.\]$/);
  });
});

describe("searxngSearch", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("lists an answer, then results as title, URL and snippet, up to count", async () => {
    const results = [1, 2, 3].map((i) => ({ title: `Result ${i}`, url: `https://r${i}.example`, content: `snippet\n${i}` }));
    const text = await searxngSearch("http://s.lan", "q", 2, undefined, reply(200, { answers: ["42"], results }));
    expect(text).toBe("Answer: 42\n\n1. Result 1\n   https://r1.example\n   snippet 1\n2. Result 2\n   https://r2.example\n   snippet 2");
  });

  it("says plainly what failed", async () => {
    await expect(searxngSearch("http://s.lan", "q", 8, undefined, reply(403, {}))).rejects.toThrow("is the json format enabled");
  });

  it("sends user:password in the address as basic auth", async () => {
    let seen: { url: string; auth?: string } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ results: [] }));
    }) as unknown as typeof fetch;
    await searxngSearch("https://li:s3cret@s.example", "a b", 8, undefined, f);
    expect(seen).toEqual({ url: "https://s.example/search?q=a%20b&format=json", auth: `Basic ${Buffer.from("li:s3cret").toString("base64")}` });
  });
});
