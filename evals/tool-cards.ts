import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, PersonaStore, DEFAULT_THREADS_LIMITS, cleanAsk, cleanSteps, normalizeThreadArguments } from "@lyrica/core";
import { createLyricaExtension, createThreadsExtension, openThreadSession, type ThreadContext } from "@lyrica/extension";
import { withModels } from "../core/test/helpers.ts";
import { afterAll } from "vitest";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export async function toolCards(real = false) {
  const m = await withModels();
  let ref = m.cloudRef;
  if (real) {
    const ep = m.models.addEndpoint(m.ada, { name: "eval", kind: process.env.LYRICA_EVAL_KIND === "local" ? "local" : "cloud", baseUrl: process.env.LYRICA_EVAL_BASE_URL!, apiKey: process.env.LYRICA_EVAL_API_KEY });
    const offerings = await m.models.discover(m.ada, ep.id);
    const want = offerings.find(o => o.modelId === process.env.LYRICA_EVAL_MODEL);
    if (!want) throw new Error("The requested eval model is not offered.");
    ref = { offeringId: want.id };
  }
  m.models.setColumnTask(m.ada.id, "general", "chat", ref);
  const memory = new Memory(m.keyring, m.users);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-tool-eval-")); dirs.push(cwd);
  async function run(request: string, action: "ask" | "steps") {
    const view = memory.openThreadView(m.ada.id, "general");
    const { id } = view.own.createThread({ interface: "web" });
    const thread: ThreadContext = { user: m.ada, pool: "general", interface: "web", threadId: id, view, call: m.models.callContext(m.ada.id, "general", id) };
    const attempts: { valid: boolean; position: number; response: number; arguments: unknown }[] = [];
    let response = 0;
    let calls = 0;
    const { session, dispose } = await openThreadSession({ thread, models: m.models, cwd, extensions: [
      createLyricaExtension(thread, { persona: () => persona.read(), profile: () => m.users.get(m.ada.id)!.profile }),
      createThreadsExtension(thread, { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("No work starts in an eval."); }, message: async () => "started", list: () => [], stepsChanged: () => {} }),
      pi => {
        pi.on("message_end", e => {
          if (e.message.role !== "assistant") return;
          response++;
          for (const c of e.message.content) {
            if (c.type !== "toolCall") continue;
            calls++;
            if (c.name !== "threads" || c.arguments.action !== action) continue;
            let valid = true;
            try { const a = normalizeThreadArguments(c.arguments); if (action === "ask") cleanAsk(a); else cleanSteps(a.steps); }
            catch { valid = false; }
            attempts.push({ valid, position: calls, response, arguments: c.arguments });
            if (valid || attempts.length === 2) void session.abort();
          }
        });
        pi.on("tool_call", () => ({ block: true, reason: "This eval only validates calls; no work is applied." }));
      },
    ] });
    try { await session.prompt(request); } finally { dispose(); view.close(); }
    return { first: attempts[0], corrected: attempts[1], attempts };
  }
  return { ...m, run };
}
