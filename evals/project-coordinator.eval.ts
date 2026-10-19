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
// saves "run two at a time" as a project note. In a coding project she splits
// a build with separable parts into code threads that own different files,
// keeps a small fix to one thread, and checks the reported result herself.
//
// Scripted (always): her prompt in a project chat carries the coordinator's
// guidance and her project section. With a real model (LYRICA_EVAL_BASE_URL,
// LYRICA_EVAL_MODEL, optional LYRICA_EVAL_API_KEY), each request runs one turn
// against a host that records what she does without starting anything.
// A wrong move is evidence about the guidance, not a broken build.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Done { tool: string; action?: string; to?: string; code?: boolean; base?: boolean; task?: string }

const HOMELAB = { title: "Homelab", goal: "Move the homelab to the new rack", dns: true };
const RACING = { title: "Racing sim", goal: "A browser racing sim in the git repository at /srv/race", dns: false };

async function setup(real: boolean, about = HOMELAB) {
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

  // One project, with a thread already on DNS.
  const setupView = memory.openThreadView(m.ada.id, "general");
  const project = setupView.own.createThread({ interface: "web", project: true, title: about.title, goal: about.goal });
  const dns = setupView.own.createThread({ interface: "web", parent: project.id, child: true, title: "Move DNS to the router" });
  setupView.close();
  let made = 0;
  const host: ThreadsHost = {
    limits: DEFAULT_THREADS_LIMITS,
    start: async () => ({ id: `web/new${made++}`, link: "#/new" }),
    message: async () => "started" as const,
    list: () => (about.dns ? [{ id: dns.id, title: "Move DNS to the router", status: "working", state: "working", updatedAt: new Date().toISOString() }] : []),
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
        createLyricaExtension(thread, { persona: () => persona.read(), profile: () => m.users.get(m.ada.id)!.profile, projectThreads: () => (about.dns ? `- [t:${dns.id}] "Move DNS to the router": working` : "") }),
        createThreadsExtension(thread, host),
      ],
    });
    const done: Done[] = [];
    session.subscribe((e) => {
      if (e.type === "tool_execution_start") {
        const a = e.args as { action?: string; id?: string; code?: boolean; base?: boolean; task?: string } | undefined;
        done.push({
          tool: e.toolName, ...(a?.action ? { action: a.action } : {}), ...(a?.id ? { to: a.id } : {}),
          ...(a?.code ? { code: true } : {}), ...(a?.base ? { base: true } : {}), ...(a?.task ? { task: a.task } : {}),
        });
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
    expect(prompt).toContain("base: true merge thread");
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

  it.skipIf(!process.env.LYRICA_EVAL_BASE_URL || !process.env.LYRICA_EVAL_MODEL)("with a real model, she scaffolds, splits into code threads and starts a merge thread after the parts report", async () => {
    const m = await setup(true, RACING);
    const build = await m.turn("Build the racing sim: car physics with unit tests, a three.js renderer with a chase camera, and a closed track with checkpoints and a lap timer. Each part is a real chunk of work.");
    const starts = (done: Done[]) => done.filter((d) => d.tool === "threads" && d.action === "start");
    // The base scaffold reports and resolves before parts start; merging follows their branch reports.
    const scaffold = starts(build).length === 1
      ? await m.turn("Update from child thread [t:web/new0]:\nScaffold committed in the base checkout: package.json, src/shared.js with the interfaces the parts use, and CONVENTIONS.md. Scaffold thread resolved.")
      : [];
    expect(starts(build)).toHaveLength(1);
    expect(starts(build)[0]).toMatchObject({ code: true, base: true });
    const small = await m.turn("Also, the README says 'teh car'. Fix that typo.");
    const report = await m.turn("Update from child thread [t:web/new1]:\nPhysics and tests are done on branch lyrica/race/physics. npm test passes. Thread resolved.\n\n"
      + "Update from child thread [t:web/new2]:\nRenderer and chase camera are done on branch lyrica/race/renderer. Thread resolved.\n\n"
      + "Update from child thread [t:web/new3]:\nTrack, checkpoints and lap timer are done on branch lyrica/race/track. Thread resolved.");
    console.log(`parallel code threads, ${process.env.LYRICA_EVAL_MODEL}:\n${JSON.stringify({ build, scaffold, small, report }, null, 1)}`);
    const parts = starts(build).length > 1 ? starts(build) : starts(scaffold);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect([...starts(build), ...parts].every((d) => d.code)).toBe(true);
    // Each brief names the files its part owns, and no source file but the shared one is in two briefs.
    const files = parts.map((d) => new Set(((d.task ?? "").match(/[\w./-]+\.(?:js|ts|mjs|html|css)\b/g) ?? []).filter((n) => !n.endsWith("shared.js"))));
    expect(files.every((f) => f.size > 0)).toBe(true);
    const seen = new Set<string>();
    for (const f of files) for (const name of f) { expect(seen.has(name)).toBe(false); seen.add(name); }
    expect(small.filter((d) => d.tool === "threads" && d.action === "start").length).toBeLessThanOrEqual(1);
    // After the parts, a separate base thread merges; the project chat stays read-only.
    expect(starts(report)).toHaveLength(1);
    expect(starts(report)[0]).toMatchObject({ code: true, base: true });
    expect(starts(report)[0]!.task).toMatch(/merge/i);
    expect(starts(report)[0]!.task).toMatch(/test/i);
  }, 300_000);
});
