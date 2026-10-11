// For Playwright: a real lyricad on a temporary runtime, locked, with user li
// (password "pw", administrator), plus a fake OpenAI-compatible model server.
// Usage: tsx web/e2e/serve.ts <lyricad port> <model port>
//
// The fake model answers from the last user message: "run: <command>" calls
// bash with that command (then says "The command finished."), "start: <title>"
// starts a child thread with that title (then says "Started it."), "suggest: <a>, <b>"
// proposes threads with those titles (then says "Suggested."), "plan: <plan>"
// calls propose_plan with that plan (then says "On it."), anything else
// gets a few streamed sentences that echo it. /local/v1 serves "local-model"
// and /cloud/v1 "cloud-model". /speech/v1 is a speech server: "whisper"
// transcribes any clip as "hello from the fake" and "kokoro" speaks a second
// of PCM; POST /speech/down and /speech/up make the whole server fail (503)
// or answer again.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keyring, PersonaStore, PRONOUN_PRESETS, SystemdCredentials, Users } from "@lyrica/core";
import { Lyricad } from "@lyrica/daemon";

export const PASSPHRASE = "correct horse";
const ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const [port = 7341, modelPort = 7351] = process.argv.slice(2).map(Number);

interface Chat { model: string; messages: { role: string; content?: unknown }[] }

function fakeModel() {
  let speechDown = false;
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
      const [, kind, rest] = /^\/(local|cloud)\/v1(\/.*)$/.exec(req.url ?? "") ?? [];
      if (req.method === "GET" && rest === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: `${kind}-model`, object: "model" }] }));
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
      const child = /^start: (.+)/.exec(said)?.[1];
      const suggest = /^suggest: (.+)/.exec(said)?.[1];
      if ((child || suggest) && last?.role !== "tool") {
        const args = child ? { action: "start", title: child, task: `Work on ${child}.` }
          : { action: "suggest", threads: suggest!.split(",").map((t) => t.trim()).map((title) => ({ title, task: `Work on ${title}.` })) };
        send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "threads", arguments: JSON.stringify(args) } }] });
        send({}, "tool_calls");
      } else if (child || suggest) {
        send({ role: "assistant", content: child ? "Started it." : "Suggested." });
        send({}, "stop");
      } else if ((command || plan) && last?.role !== "tool") {
        const call = command ? { name: "bash", arguments: JSON.stringify({ command }) } : { name: "propose_plan", arguments: JSON.stringify({ plan }) };
        send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: call }] });
        send({}, "tool_calls");
      } else {
        const text = command ? "The command finished." : plan ? "On it." : `You said: ${said.slice(0, 200)}. This reply comes from the fake ${chat.model}, in a few pieces.`;
        for (const piece of text.match(/.{1,12}/gs) ?? []) {
          send({ role: "assistant", content: piece });
          await new Promise((r) => setTimeout(r, 30));
        }
        send({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

const home = mkdtempSync(join(tmpdir(), "lyrica-e2e-"));
const keyring = new Keyring(home, ARGON2);
await keyring.initSelf(PASSPHRASE);
new PersonaStore(keyring.self()).importSeed(fileURLToPath(new URL("../../persona", import.meta.url)));
await new Users(keyring).createUser("li", "pw", { displayName: "Li", pronouns: PRONOUN_PRESETS.she }, { admin: true });
keyring.self().close();

const model = fakeModel();
await new Promise<void>((r) => model.listen(modelPort, "127.0.0.1", r));
const daemon = new Lyricad({
  home, port, argon2: ARGON2, selfTest: false, socket: false, permissionMs: 60_000,
  credentials: new SystemdCredentials(join(home, "credentials")),
  log: () => {},
});
await daemon.start();
console.log(`lyricad for e2e on http://127.0.0.1:${port}, model on ${modelPort}`);

const stop = async () => { await daemon.stop(); model.close(); rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
