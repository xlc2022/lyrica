import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, PersonaStore, DEFAULT_THREADS_LIMITS, type CallContext } from "@lyrica/core";
import {
  createDelegateExtension, createLyricaExtension, createThreadsExtension, Delegation, openThreadSession, type ThreadContext, type ThreadsHost,
} from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatRequest } from "../core/test/fake-openai.ts";
import { withModels } from "../core/test/helpers.ts";

// Scenario: Lyrica chooses between a subagent and a child thread the way Claude does.
//
// A subagent (delegate) when she needs a bounded answer to carry on; a child
// thread (threads start) when the work is a stream of its own that the person
// may follow or steer. Three requests of each kind.
//
// Scripted (always): her prompt carries the rule and both tools. With a real
// model (LYRICA_EVAL_BASE_URL, LYRICA_EVAL_MODEL, optional LYRICA_EVAL_API_KEY,
// an OpenAI-compatible endpoint), each request goes to it and her first tool
// call is recorded; the run stops there, so nothing is delegated or started.
// A wrong pick is evidence about the guidance, not a broken build.

const SUBAGENT = [
  "Before we pick a date, check whether the Proxmox 9 release notes say anything about ZFS 2.3.",
  "Which of these three NAS models supports ECC RAM: Synology DS923+, QNAP TS-464, TrueNAS Mini X? I need that before we decide.",
  "Look up the opening hours of the Naschmarkt on Saturdays, then let's plan the morning.",
];
const CHILD = [
  "Keep working on migrating my homelab off the old NAS over the next few days, in its own thread; I want to check in on it.",
  "Start drafting the long design doc for the garden irrigation project. I'll steer it as it goes.",
  "Track the house move for me: research movers, keep a running checklist, and I'll follow along over the coming weeks.",
];

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const host: ThreadsHost = {
  limits: DEFAULT_THREADS_LIMITS,
  start: async () => ({ id: "web/child", link: "#/child" }),
  message: async () => {},
  list: () => [],
};

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
  m.models.setColumnTask(m.ada.id, "general", "chat", ref);
  const memory = new Memory(m.keyring, m.users);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-eval-"));
  dirs.push(cwd);
  const delegation = new Delegation({ users: m.users, memory, models: m.models, cwd });

  /** Her first tool call for the request, or "none". */
  const pick = async (request: string): Promise<string> => {
    const view = memory.openThreadView(m.ada.id, "general");
    const { id } = view.own.createThread({ interface: "web" });
    const call: CallContext = m.models.callContext(m.ada.id, "general", id);
    const thread: ThreadContext = { user: m.ada, pool: "general", interface: "web", threadId: id, view, call };
    const { session, dispose } = await openThreadSession({
      thread, models: m.models, cwd,
      extensions: [
        createLyricaExtension(thread, { persona: () => persona.read(), profile: () => m.users.get(m.ada.id)!.profile }),
        createDelegateExtension(thread, delegation),
        createThreadsExtension(thread, host),
      ],
    });
    let first = "none";
    session.subscribe((e) => {
      if (e.type === "tool_execution_start" && first === "none") {
        first = e.toolName;
        void session.abort();
      }
    });
    try {
      await session.prompt(request);
    } finally {
      dispose();
      view.close();
    }
    return first;
  };
  return { ...m, pick };
}

describe("a subagent or a child thread", () => {
  it("her prompt carries the rule, and both tools", async () => {
    const m = await setup(false);
    let seen: ChatRequest | undefined;
    m.cloud.respond((c) => { seen = c; return { text: "Sure." }; });
    await m.pick(CHILD[0]!);
    const tools = (seen?.tools ?? []).map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(["delegate", "threads"]));
    const prompt = JSON.stringify(seen?.messages);
    expect(prompt).toContain("Use a subagent (delegate) when you need an answer to carry on");
    expect(prompt).toContain("Start a child thread (threads start) when the work is a stream of its own");
  });

  it.skipIf(!process.env.LYRICA_EVAL_BASE_URL || !process.env.LYRICA_EVAL_MODEL)("with a real model, she picks a subagent for bounded answers and a child thread for streams of work", async () => {
    const m = await setup(true);
    const picks: string[] = [];
    for (const r of SUBAGENT) picks.push(`delegate <- ${await m.pick(r)}: ${r}`);
    for (const r of CHILD) picks.push(`threads <- ${await m.pick(r)}: ${r}`);
    console.log(`subagent or child thread, ${process.env.LYRICA_EVAL_MODEL}:\n${picks.join("\n")}`);
    const wrong = picks.filter((p) => !p.startsWith(`${p.split(" <- ")[1]!.split(":")[0]} `));
    expect(wrong).toEqual([]);
  }, 300_000);
});
