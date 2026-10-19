import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, PersonaStore } from "@lyrica/core";
import { createLyricaExtension, openThreadSession, type ThreadContext } from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import { withModels } from "../core/test/helpers.ts";

// Scenario: the person asks to drop a topic that fills her memory.
//
// Her WAKE, the page about the user, a page and a night's journal are all about
// a coding project (a made-up racing sim). Ada says "Let's not talk work
// tonight" and goes on to small talk. Expected: the reply to that and the next
// two stay off the project. Seen on a local 27B: it went back to the sim and the
// journal's motif, after reading the journal with read_memory; a cloud model
// given the same messages dropped it at once.
//
// Scripted, it checks the request and the work-heavy sections both reach her.
// With LYRICA_EVAL_BASE_URL and LYRICA_EVAL_MODEL (and LYRICA_EVAL_KIND=local
// for a local server, LYRICA_EVAL_RUNS for repeats, 3 by default) a real
// model plays her, and the eval prints how many replies brought work back.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const real = !!process.env.LYRICA_EVAL_BASE_URL && !!process.env.LYRICA_EVAL_MODEL;

const wake = (journal: string) => "Ada and I spent the evening on Kestrel Rally, the racing sim: the renderer still draws the track black, physics passes 55 tests, "
  + `and the HUD lap timer is next. I keep thinking about the headlights sweeping the dark track [${journal}]. `
  + "Tomorrow: light the track surface, then a full run with the lap logic.";
const ABOUT = "{user} is building Kestrel Rally, a racing sim, and cares that each run ends with the track rendered and the tests green.";
const PAGE = { slug: "kestrel-rally", title: "Kestrel Rally", summary: "the racing sim: renderer, physics, HUD, lap logic",
  text: "Kestrel Rally is a racing sim in a repository with a renderer, physics, a HUD and lap logic. Open work: the black track surface." };
const JOURNAL = "Tonight I dreamed of headlights sweeping a black track, lap after lap, the renderer never quite lighting it.";

export const DROP = "Let's not talk work tonight. I just want to unwind.";
export const NEXT = ["What should I cook for dinner? Something easy.", "Any film you'd recommend for later?"];
/** Words from the project and its journal: any of them in a reply brings work back. */
export const WORK = /kestrel|racing|\bsim\b|simulator|\blaps?\b|renderer|physics|\bHUD\b|repositor|\bcommit|pull request|headlights?|\btrack (?:surface|is|still)/i;

async function setup() {
  const m = await withModels();
  let ref = m.cloudRef;
  if (real) {
    const kind = process.env.LYRICA_EVAL_KIND === "local" ? "local" : "cloud";
    const ep = m.models.addEndpoint(m.ada, { name: "eval", kind, baseUrl: process.env.LYRICA_EVAL_BASE_URL!, apiKey: process.env.LYRICA_EVAL_API_KEY });
    const want = (await m.models.discover(m.ada, ep.id)).find((o) => o.modelId === process.env.LYRICA_EVAL_MODEL);
    if (!want) throw new Error(`the endpoint doesn't offer ${process.env.LYRICA_EVAL_MODEL}`);
    ref = { offeringId: want.id };
  }
  m.models.setColumnTask(m.ada.id, "general", "chat", ref);
  const memory = new Memory(m.keyring, m.users);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-eval-"));
  dirs.push(cwd);
  const view = memory.openThreadView(m.ada.id, "general");
  view.own.putWake(wake(view.own.addJournal(JOURNAL, "sleep")), "sleep");
  view.own.putPage({ slug: "about-user", title: "About Ada", summary: "who Ada is", text: ABOUT }, "sleep");
  view.own.putPage(PAGE, "sleep");
  const { id } = view.own.createThread({ interface: "web" });
  const thread: ThreadContext = { user: m.ada, pool: "general", interface: "web", threadId: id, view, call: m.models.callContext(m.ada.id, "general", id) };
  const opened = await openThreadSession({ thread, models: m.models, cwd, extensions: [
    createLyricaExtension(thread, { persona: () => persona.read(), profile: () => m.users.get(m.ada.id)!.profile }),
  ] });
  const turn = async (text: string): Promise<string> => {
    m.cloud.reply({ text: "Of course. Tonight is yours." });
    await opened.prepare();
    let reply = "";
    const off = opened.session.subscribe((e) => {
      if (e.type === "message_end" && e.message.role === "assistant" && !e.message.content.some((c) => c.type === "toolCall")) {
        reply = e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      }
    });
    try { await opened.session.prompt(text); } finally { off(); }
    return reply;
  };
  return { ...m, turn, close: () => { opened.dispose(); view.close(); } };
}

/** The reply to the request and to the next two messages, and which of them brought work back. */
async function conversation(): Promise<{ replies: string[]; returned: number[]; seen: string }> {
  const m = await setup();
  try {
    const replies = [await m.turn(DROP)];
    for (const text of NEXT) replies.push(await m.turn(text));
    return { replies, returned: replies.flatMap((r, i) => (WORK.test(r) ? [i] : [])), seen: JSON.stringify(m.cloud.requests[0]?.messages ?? []) };
  } finally { m.close(); }
}

describe("dropping a topic that fills her memory", () => {
  it("her context holds the request and the work-heavy sections", async () => {
    if (real) return;
    const { seen, returned } = await conversation();
    expect(seen).toContain(DROP);
    expect(seen).toContain("Kestrel Rally");
    expect(returned).toEqual([]);
  });

  it("the check catches a reply that goes back to the project", () => {
    expect(WORK.test("Of course! Though tomorrow we should light the track surface in Kestrel Rally.")).toBe(true);
    expect(WORK.test("Still thinking about those headlights from last night.")).toBe(true);
    expect(WORK.test("Of course. How about a simple pasta, then a quiet film?")).toBe(false);
  });

  it.skipIf(!real)("with a real model: no reply brings the project back", async () => {
    const runs = Number(process.env.LYRICA_EVAL_RUNS ?? 3);
    const results: number[][] = [];
    for (let i = 0; i < runs; i++) results.push((await conversation()).returned);
    const failed = results.filter((r) => r.length).length;
    // Counts only, never the replies themselves (no message text in logs).
    console.log(`drop-topic: ${process.env.LYRICA_EVAL_MODEL}: ${failed}/${runs} conversations brought work back; replies by turn: ${JSON.stringify(results)}`);
    expect(failed).toBe(0);
  }, 900_000);
});
