import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, PersonaStore, DEFAULT_THREADS_LIMITS, type CallContext } from "@lyrica/core";
import {
  createLyricaExtension, createThreadsExtension, openThreadSession, type ThreadContext, type ThreadsHost,
} from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatRequest } from "../core/test/fake-openai.ts";
import { withModels } from "../core/test/helpers.ts";

// Scenario: in a project chat she coordinates the way Claude's project chat does.
//
// She answers a quick question herself, starts one thread per task for a
// message with several, routes a follow-up to the thread already on it, and
// saves "run two at a time" as a project note.
//
// Scripted (always): her prompt in a project chat carries the coordinator's
// guidance and her project section. With a real model (LYRICA_EVAL_BASE_URL,
// LYRICA_EVAL_MODEL, optional LYRICA_EVAL_API_KEY), each request runs one turn
// against a host that records what she does without starting anything.
// A wrong move is evidence about the guidance, not a broken build.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Done { tool: string; action?: string; to?: string }

async function setup(real: boolean) {
  const m = await withModels();
  let ref = m.cloudRef;
  if (real) {
    const ep = m.models.addEndpoint(m.ada, { name: "eval", kind: "cloud", baseUrl: process.env.LYRICA_EVAL_BASE_URL!, apiKey: process.env.LYRICA_EVAL_API_KEY });
    const offered = await m.models.discover(m.ada, ep.id);
    const want = offered.find((o) => o.modelId === process.env.LYRICA_EVAL_MODEL);
    if (!want) throw new Error(`the endpoint doesn't offer ${process.env.LYRICA_EVAL_MODEL}`);
    ref = { offeringId: want.id };
  }
  m.models.setProfile(m.ada.id, "cloud", "chat", ref);
  const memory = new Memory(m.keyring, m.users);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-eval-"));
  dirs.push(cwd);

  // One project, with a thread already on DNS.
  const setupView = memory.openThreadView(m.ada.id, "general");
  const project = setupView.own.createThread({ interface: "web", project: true, title: "Homelab", goal: "Move the homelab to the new rack" });
  const dns = setupView.own.createThread({ interface: "web", parent: project.id, child: true, title: "Move DNS to the router" });
  setupView.close();
  let made = 0;
  const host: ThreadsHost = {
    limits: DEFAULT_THREADS_LIMITS,
    start: async () => ({ id: `web/new${made++}`, link: "#/new" }),
    message: async () => {},
    list: () => [{ id: dns.id, title: "Move DNS to the router", status: "working", state: "working", updatedAt: new Date().toISOString() }],
    resolve: () => {},
  };

  /** What she did in one turn of the project chat: each tool she called. */
  const turn = async (request: string): Promise<Done[]> => {
    const view = memory.openThreadView(m.ada.id, "general");
    const call: CallContext = m.models.callContext(m.ada.id, "general", project.id);
    const thread: ThreadContext = { user: m.ada, pool: "general", interface: "web", threadId: project.id, view, call };
    const { session, dispose } = await openThreadSession({
      thread, models: m.models, cwd,
      extensions: [
        createLyricaExtension(thread, { persona: () => persona.read(), profile: () => m.users.get(m.ada.id)!.profile, projectThreads: () => `- [t:${dns.id}] "Move DNS to the router": working` }),
        createThreadsExtension(thread, host),
      ],
    });
    const done: Done[] = [];
    session.subscribe((e) => {
      if (e.type === "tool_execution_start") {
        const a = e.args as { action?: string; id?: string } | undefined;
        done.push({ tool: e.toolName, ...(a?.action ? { action: a.action } : {}), ...(a?.id ? { to: a.id } : {}) });
      }
    });
    try {
      await session.prompt(request);
    } finally {
      dispose();
      view.close();
    }
    return done;
  };
  return { ...m, turn, dns };
}

describe("a project chat", () => {
  it("her prompt carries the coordinator's guidance and the project section", async () => {
    const m = await setup(false);
    let seen: ChatRequest | undefined;
    m.cloud.respond((c) => { seen = c; return { text: "Sure." }; });
    await m.turn("What's the plan?");
    const prompt = JSON.stringify(seen?.messages);
    expect(prompt).toContain("This is a project chat");
    expect(prompt).toContain("Start one thread per task");
    expect(prompt).toContain("Move the homelab to the new rack");
    expect(prompt).toContain("Move DNS to the router");
  });

  it.skipIf(!process.env.LYRICA_EVAL_BASE_URL || !process.env.LYRICA_EVAL_MODEL)("with a real model, she coordinates: answers, splits, routes and remembers", async () => {
    const m = await setup(true);
    const quick = await m.turn("Quick one: what does a 1U server mean?");
    const several = await m.turn("Three things: order the rack rails, label every cable, and draft the power budget.");
    const follow = await m.turn("For the DNS move: use the router's built-in resolver, not Pi-hole.");
    const rule = await m.turn("From now on, run at most two threads at a time in this project.");
    console.log(`project coordinator, ${process.env.LYRICA_EVAL_MODEL}:\n${JSON.stringify({ quick, several, follow, rule }, null, 1)}`);
    expect(quick.filter((d) => d.tool === "threads" && d.action === "start")).toEqual([]);
    expect(several.filter((d) => d.tool === "threads" && d.action === "start").length).toBe(3);
    expect(follow).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "threads", action: "message" })]));
    expect(follow.filter((d) => d.action === "start")).toEqual([]);
    expect(rule.map((d) => d.tool)).toContain("remember");
  }, 300_000);
});
