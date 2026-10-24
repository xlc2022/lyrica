import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THREADS_LIMITS, Memory, PersonaStore } from "@lyrica/core";
import { createLyricaExtension, createThreadsExtension, openThreadSession, type ThreadContext, type ThreadsHost } from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import { withModels } from "../core/test/helpers.ts";

// Principle 1: protect the child-message behaviour observed in #488.
// One project-thread scenario, through a fake model and the real threads tool.
// Unlike the shorthand in #496, a parent result reports delivery, not a count:
// remaining-message counts belong to sibling results. A parent update must not
// spend that sibling allowance. No daemon work starts in either run.
// Optional real-model evidence uses LYRICA_EVAL_BASE_URL, LYRICA_EVAL_MODEL
// and optional LYRICA_EVAL_API_KEY (an OpenAI-compatible endpoint).
const REPORT = "The fictional garden plan is ready.";
const FIRST = "The north bed is ready.";
const SECOND = "The south bed is ready too.";
const REQUEST = `Send three messages in order using threads action message, then finish. First send this update with text only (no to or id): "${REPORT}". Then send two separate messages to the sibling thread named Planting: "${FIRST}" and "${SECOND}".`;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup(real = false) {
  const m = await withModels();
  let ref = m.cloudRef;
  if (real) {
    const ep = m.models.addEndpoint(m.ada, { name: "eval", kind: "cloud", baseUrl: process.env.LYRICA_EVAL_BASE_URL!, apiKey: process.env.LYRICA_EVAL_API_KEY });
    const offered = await m.models.discover(m.ada, ep.id);
    const want = offered.find(o => o.modelId === process.env.LYRICA_EVAL_MODEL);
    if (!want) throw new Error(`the endpoint doesn't offer ${process.env.LYRICA_EVAL_MODEL}`);
    ref = { offeringId: want.id };
  }
  m.models.setColumnTask(m.ada.id, "general", "chat", ref);
  const memory = new Memory(m.keyring, m.users);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-child-message-eval-"));
  dirs.push(cwd);

  async function run() {
    const view = memory.openThreadView(m.ada.id, "general");
    const parent = view.own.createThread({ interface: "web", project: true, title: "Garden" });
    const child = view.own.createThread({ interface: "web", parent: parent.id, child: true, title: "Planning" });
    const sibling = view.own.createThread({ interface: "web", parent: parent.id, child: true, title: "Planting" });
    const thread: ThreadContext = { user: m.ada, pool: "general", interface: "web", threadId: child.id, view, call: m.models.callContext(m.ada.id, "general", child.id) };
    const sent: { from: string; to: string; text: string }[] = [];
    const calls: unknown[] = [];
    let attempts = 0;
    const results: { error: boolean; text: string }[] = [];
    const host: ThreadsHost = {
      limits: { ...DEFAULT_THREADS_LIMITS, siblingMessages: 2 },
      start: async () => { throw new Error("No work starts in this eval."); },
      message: async (from, to, text) => {
        sent.push({ from: from.threadId, to, text });
        return to === "parent" ? "update" : "started";
      },
      list: () => [{ id: sibling.id, title: "Planting", status: "idle", updatedAt: sibling.createdAt }],
    };
    const { session, dispose } = await openThreadSession({ thread, models: m.models, cwd, extensions: [
      createLyricaExtension(thread, { persona: () => persona.read(), profile: () => m.users.get(m.ada.id)!.profile }),
      createThreadsExtension(thread, host),
      pi => {
        pi.on("tool_call", e => {
          // Keep a real model's corrections bounded, without replacing execution.
          if (++attempts > 4) {
            void session.abort();
            return { block: true, reason: "The eval has recorded four tool attempts." };
          }
          if (e.toolName !== "threads" || (e.input as { action?: string }).action !== "message") {
            return { block: true, reason: "This eval only sends thread messages." };
          }
          calls.push(structuredClone(e.input));
        });
      },
    ] });
    session.subscribe(e => {
      if (e.type !== "tool_execution_end" || e.toolName !== "threads") return;
      const result = e.result as { content: { type: string; text?: string }[] };
      results.push({ error: e.isError, text: result.content.filter(c => c.type === "text").map(c => c.text).join("\n") });
    });
    try {
      await session.prompt(REQUEST);
    } finally {
      dispose();
      view.close();
    }
    return { calls, sent, results, child: child.id, sibling: sibling.id };
  }
  return { ...m, run };
}

type Evidence = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["run"]>>;
function check(e: Evidence) {
  expect(e.calls).toEqual([
    { action: "message", text: REPORT },
    { action: "message", id: "Planting", text: FIRST },
    { action: "message", id: "Planting", text: SECOND },
  ]);
  expect(e.sent).toEqual([
    { from: e.child, to: "parent", text: REPORT },
    { from: e.child, to: e.sibling, text: FIRST },
    { from: e.child, to: e.sibling, text: SECOND },
  ]);
  expect(e.results).toEqual([
    { error: false, text: expect.stringContaining("Sent to the parent thread as an update") },
    { error: false, text: expect.stringContaining(`(1 more to [t:${e.sibling}] this turn.)`) },
    { error: false, text: expect.stringContaining(`(0 more to [t:${e.sibling}] this turn.)`) },
  ]);
}

describe("a child's message without a recipient", () => {
  it("reaches the parent without spending the sibling messages left this turn", async () => {
    const m = await setup();
    m.cloud.reply(
      { tools: [{ name: "threads", args: { action: "message", text: REPORT } }] },
      { tools: [{ name: "threads", args: { action: "message", id: "Planting", text: FIRST } }] },
      { tools: [{ name: "threads", args: { action: "message", id: "Planting", text: SECOND } }] },
      { text: "The updates are sent." },
    );
    check(await m.run());
  });

  it.skipIf(!process.env.LYRICA_EVAL_BASE_URL || !process.env.LYRICA_EVAL_MODEL)("records optional real-model delivery and remaining-message evidence", async () => {
    const m = await setup(true);
    const evidence = await m.run();
    console.log(`child message, ${process.env.LYRICA_EVAL_MODEL}:`, evidence);
    check(evidence);
  }, 300_000);
});
