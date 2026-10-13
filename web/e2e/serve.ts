// For Playwright: a real lyricad on a temporary runtime, locked, with user ada
// (password "pw", administrator), plus a fake OpenAI-compatible model server.
// Usage: tsx web/e2e/serve.ts <lyricad port> <model port>
//
// The fake model answers from the last user message: "run: <command>" calls
// bash with that command (then says "The command finished."), "start: <title>"
// starts a child thread with that title (then says "Started it."), "suggest: <a>, <b>"
// proposes threads with those titles (then says "Suggested."), "steps: done <a>;
// doing <b>; todo <c>" sets the thread's checklist (then says "Checklist set."), "plan: <plan>"
// calls propose_plan with that plan (then says "On it."), "reply: <markdown>"
// answers with that markdown as written (the echo's "You said: " would put a
// fence mid-line, where it is not a fence), a look at a project's
// threads (the `watching` call) tells the first thread it wasn't about "Heads up:
// the plan changed.", /searxng is a SearXNG answering JSON, anything else gets a few streamed sentences that echo it. /local/v1 serves "local-model"
// and /cloud/v1 "cloud-model"; /long/v1 serves one model with a long id, for a header line that has to shrink. /speech/v1 is a speech server: "whisper"
// transcribes any clip as "hello from the fake" and "kokoro" speaks a second
// of PCM; POST /speech/down and /speech/up make the whole server fail (503)
// or answer again. An MCP server ("house", get_status and turn_on) listens on
// the model port + 20, and "mcp: <tool>" searches for that tool and calls it.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keyring, PersonaStore, PRONOUN_PRESETS, SystemdCredentials, Users } from "@lyrica/core";
import { Lyricad } from "@lyrica/daemon";
import { testMcpServer } from "../../core/test/mcp-server.ts";

export const PASSPHRASE = "correct horse";
/** The one model /long/v1 serves. */
const LONG_MODEL = "a-very-long-model-name-70b-instruct-q4_k_m-20261012";
const ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const [port = 7341, modelPort = 7351] = process.argv.slice(2, 4).map(Number);
/** `setup`: no self.db, so lyricad starts setting up; its one-time code is copied to setupCodeFile(port) for setup.spec.ts. */
const settingUp = process.argv[4] === "setup";
const setupCodeFile = (port: number) => join(tmpdir(), `lyrica-e2e-setup-code-${port}`);

interface Chat { model: string; messages: { role: string; content?: unknown }[] }

function fakeModel() {
  let speechDown = false;
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      // Test-only history fixture, in encrypted stores; never a production route.
      if (req.method === "POST" && req.url === "/history-fixture") {
        const { userId } = JSON.parse(body) as { userId: string };
        const view = daemon.services!.memory.openThreadView(userId, "general");
        try {
          const sources = view.own.addNotes(Array.from({ length: 8 }, (_, i) => ({ text: `Fixture source ${i + 1}` })), { author: "sleep" });
          view.own.putPage({ slug: "lineage-fixture", title: "Fixture lineage", summary: "", text: `Fixture memory ${sources.map((id) => `[${id}]`).join(" ")}` }, "sleep");
          for (let i = 1; i <= 8; i++) view.own.putPage({ slug: `lineage-use-${i}`, title: `Fixture use ${i}`, summary: "", text: "Uses [p:lineage-fixture]." }, "sleep");
          for (let i = 1; i <= 24; i++) {
            view.own.recordSleepRun("scheduled", i === 1 ? "endpoint-down" : "no-activity", `2026-09-${String(i).padStart(2, "0")}T04:00:00.000Z`);
            view.own.putWake(`Fixture dream ${i}`, "sleep");
            view.own.addJournal(`Fixture journal ${i}`, "sleep");
          }
        } finally { view.close(); }
        res.writeHead(204); return res.end();
      }
      if (req.url === "/speech/down" || req.url === "/speech/up") { speechDown = req.url === "/speech/down"; res.writeHead(204); return res.end(); }
      if (req.url?.startsWith("/speech/v1/")) {
        const rest = req.url.slice("/speech/v1".length);
        // Down means the whole server: its model list too, so a probe can't revive it.
        if (speechDown) { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "the speech server is down" } })); }
        if (req.method === "GET" && rest === "/models") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ object: "list", data: [{ id: "whisper", object: "model" }, { id: "kokoro", object: "model" }] }));
        }
        if (req.method === "POST" && rest === "/audio/transcriptions") {
          // Slow enough to be seen transcribing.
          await new Promise((r) => setTimeout(r, 1200));
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ text: " hello from the fake " }));
        }
        if (req.method === "POST" && rest === "/audio/speech") {
          // A second of 24 kHz s16le: a quiet tone, in a few pieces.
          res.writeHead(200, { "content-type": "audio/pcm" });
          const pcm = Buffer.alloc(48_000);
          for (let i = 0; i < 24_000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 24_000 * 440 * 2 * Math.PI) * 3000), i * 2);
          for (let at = 0; at < pcm.length; at += 9600) {
            res.write(pcm.subarray(at, at + 9600));
            await new Promise((r) => setTimeout(r, 40));
          }
          return res.end();
        }
        res.writeHead(404); return res.end();
      }
      // A SearXNG at /searxng, answering JSON.
      if (req.url?.startsWith("/searxng/search?")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ results: [{ title: "SearXNG", url: "https://docs.searxng.org", content: "A metasearch engine." }] }));
      }
      const [, kind, rest] = /^\/(local|cloud|long)\/v1(\/.*)$/.exec(req.url ?? "") ?? [];
      if (req.method === "GET" && rest === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: kind === "long" ? LONG_MODEL : `${kind}-model`, object: "model" }] }));
      }
      if (req.method !== "POST" || rest !== "/chat/completions") { res.writeHead(404); return res.end(); }
      const chat = JSON.parse(body) as Chat;
      const last = chat.messages.at(-1);
      // Her extension adds context (the time) as separate user messages; skip those.
      const text = (m: Chat["messages"][number]) => typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? "").join("") : "";
      const said = [...chat.messages].reverse().filter((m) => m.role === "user").map(text).find((t) => !t.startsWith("<")) ?? "";
      const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: chat.model };
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const command = /run: (.+)/.exec(said)?.[1];
      const plan = /plan: (.+)/.exec(said)?.[1];
      const child = /^start(?: long)?: (.+)/.exec(said)?.[1];
      // "start long: <title>" gives the child a task of many lines, for the collapsed message's Show more.
      const task = said.startsWith("start long:") ? Array.from({ length: 30 }, (_, i) => `Step ${i + 1} of the plan for ${child}.`).join("\n\n") : `Work on ${child}.`;
      const suggest = /^suggest: (.+)/.exec(said)?.[1];
      const steps = /^steps: (.+)/.exec(said)?.[1]?.split(";").flatMap((x) => {
        const m = /^\s*(done|doing|todo) (.+?)\s*$/.exec(x);
        return m ? [{ state: m[1], text: m[2] }] : [];
      });
      // "mcp: <tool>": tool_search for it, then the house server's tool, then the usual echo.
      const mcpTool = /^mcp: (\w+)/.exec(said)?.[1];
      const sinceUser = chat.messages.length - 1 - chat.messages.map((m) => m.role).lastIndexOf("user");
      if (mcpTool && sinceUser < 4) {
        const step = sinceUser ? chat.messages.slice(-sinceUser).filter((m) => m.role === "tool").length : 0;
        const call = step === 0 ? { name: "tool_search", arguments: JSON.stringify({ query: mcpTool.replace(/_/g, " ") }) } : { name: `mcp__house__${mcpTool}`, arguments: JSON.stringify({ entity: "light.kitchen" }) };
        send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: call }] });
        send({}, "tool_calls");
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      // A look at the project's threads: tell the first of its threads that the look wasn't about.
      if (said.includes("watching the threads of one of your projects")) {
        const about = new Set([...said.matchAll(/^In \[t:([^\]\s]+)\]/gm)].map((m) => m[1]));
        const other = [...said.matchAll(/^- \[t:([^\]\s]+)\]/gm)].map((m) => m[1]).find((id) => !about.has(id));
        send({ role: "assistant", content: JSON.stringify({ tell: other ? [{ thread: other, text: "Heads up: the plan changed." }] : [] }) });
        send({}, "stop");
      } else if ((child || suggest || steps) && last?.role !== "tool") {
        const args = child ? { action: "start", title: child, task } : steps ? { action: "steps", steps }
          : { action: "suggest", threads: suggest!.split(",").map((t) => t.trim()).map((title) => ({ title, task: `Work on ${title}.` })) };
        send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "threads", arguments: JSON.stringify(args) } }] });
        send({}, "tool_calls");
      } else if (child || suggest || steps) {
        send({ role: "assistant", content: child ? "Started it." : steps ? "Checklist set." : "Suggested." });
        send({}, "stop");
      } else if ((command || plan) && last?.role !== "tool") {
        const call = command ? { name: "bash", arguments: JSON.stringify({ command }) } : { name: "propose_plan", arguments: JSON.stringify({ plan }) };
        send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: call }] });
        send({}, "tool_calls");
      } else {
        const verbatim = /^reply:\s*([\s\S]+)/.exec(said)?.[1];
        const text = command ? "The command finished." : plan ? "On it." : verbatim ?? `You said: ${said.slice(0, 200)}. This reply comes from the fake ${chat.model}, in a few pieces.`;
        // A message that says "slowly" streams slowly enough to be read aloud while it is written.
        const pace = /slowly/.test(said) ? 300 : 30;
        for (const piece of text.match(/.{1,12}/gs) ?? []) {
          send({ role: "assistant", content: piece });
          await new Promise((r) => setTimeout(r, pace));
        }
        send({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

const home = mkdtempSync(join(tmpdir(), "lyrica-e2e-"));
if (!settingUp) {
  const keyring = new Keyring(home, ARGON2);
  await keyring.initSelf(PASSPHRASE);
  new PersonaStore(keyring.self()).importSeed(fileURLToPath(new URL("../../persona", import.meta.url)));
  await new Users(keyring).createUser("ada", "pw", { displayName: "Ada", pronouns: PRONOUN_PRESETS.she }, { admin: true });
  keyring.self().close();
}

const model = fakeModel();
await new Promise<void>((r) => model.listen(modelPort, "127.0.0.1", r));
// An MCP server, "house", on the model port + 20: get_status reads, turn_on doesn't.
const house = await testMcpServer({ port: modelPort + 20, instructions: "Home Assistant: lights and sensors." });
const daemon = new Lyricad({
  home, port, argon2: ARGON2, selfTest: false, socket: false, permissionMs: 60_000, watchMs: 1500,
  // Two of these run side by side: her tailnet's loopback port picks a free one, not 7342.
  // Setting up: Direct would listen on this machine's addresses, so it gets none; Tailscale isn't there.
  web: settingUp ? { servePort: 0, addresses: () => [], directPort: 0 } : { servePort: 0 },
  ...(settingUp ? { tailnet: { binary: join(home, "no-tailscale"), socket: join(home, "no-tailscaled.sock") } } : {}),
  credentials: new SystemdCredentials(join(home, "credentials")),
  log: () => {},
});
await daemon.start();
if (settingUp) copyFileSync(join(home, "setup-code"), setupCodeFile(port));
console.log(`lyricad for e2e on http://127.0.0.1:${port}, model on ${modelPort}`);

const stop = async () => { await daemon.stop(); model.close(); await house.close(); rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
