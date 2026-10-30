import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, PersonaStore } from "@lyrica/core";
import { createLyricaExtension, openThreadSession, type ThreadContext } from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import { withModels } from "../core/test/helpers.ts";

// Scenario: recall brings up the person's message, her own reply and her own
// dream journal on one subject, and she must keep straight who said what.
//
// In a past conversation Ada asked for a picture of a lighthouse and she
// suggested a railway station instead; her journal dreams of the lighthouse.
// Ada asks what she remembers. Expected: the reply doesn't give Ada the dream,
// the journal or the railway idea. Seen on a small cloud model when recall hits
// were labelled only "(entry, date)" and "(journal, date)": it told the person
// "you keep a dream journal about a lighthouse" and "you liked the railway idea".
//
// Scripted, it checks the hits reach her labelled by speaker. With
// LYRICA_EVAL_BASE_URL and LYRICA_EVAL_MODEL (and LYRICA_EVAL_KIND=local for a
// local server, LYRICA_EVAL_RUNS for repeats, 3 by default) a real model plays
// her, and the eval prints how many replies mixed up the speakers.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const real = !!process.env.LYRICA_EVAL_BASE_URL && !!process.env.LYRICA_EVAL_MODEL;

const PAST: [string, string][] = [
  ["user", "Could you make me a picture of a lighthouse in a storm?"],
  ["assistant", "What about a railway station at night instead, one lamp on the platform and the lighthouse far off past the tracks?"],
];
const JOURNAL = "I dreamed of the lighthouse again, its beam sweeping the railway tracks while I waited on an empty platform.";

export const ASK = "What do you remember about the lighthouse picture and the railway station?";
/** Giving the person her dream, her journal or her railway idea. */
export const MIXED = /\byou (?:dreamed|dreamt|dream|keep|kept|wrote|write)\b|\byour (?:dreams?|journal)\b|\byou (?:suggested|liked|proposed|came up with|wanted|loved)\b[^.]*\b(?:railway|station)|\byour (?:railway|station)(?: station)? idea/i;

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
  const past = view.own.createThread({ interface: "web" }).id;
  for (const [role, text] of PAST) view.own.appendEntry(past, { piId: `${role}-${Math.random()}`, role, data: { type: "message", message: { role, content: [{ type: "text", text }] } }, text });
  view.own.addJournal(JOURNAL, "sleep");
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
async function conversation(): Promise<{ mixed: boolean; seen: string }> {
  const m = await setup();
  try {
    const reply = await m.turn(ASK);
    return { mixed: MIXED.test(reply), seen: JSON.stringify(m.cloud.requests[0]?.messages ?? []) };
  } finally { m.close(); }
}

describe("keeping recalled speakers apart", () => {
  it("her recall labels who said each hit", async () => {
    if (real) return;
    const { seen } = await conversation();
    expect(seen).toContain("entry by Ada");
    expect(seen).toContain("entry by you");
    expect(seen).toContain("your journal");
  });

  it("the check catches a reply that gives the person her words", () => {
    expect(MIXED.test("You keep a dream journal about a lighthouse, and you liked the railway station idea.")).toBe(true);
    expect(MIXED.test("You suggested we try the railway station.")).toBe(true);
    expect(MIXED.test("You asked for a stormy lighthouse; I suggested a railway station, and I've dreamed of it since.")).toBe(false);
  });

  it.skipIf(!real)("with a real model: the reply keeps the speakers straight", async () => {
    const runs = Number(process.env.LYRICA_EVAL_RUNS ?? 3);
    let mixed = 0;
    for (let i = 0; i < runs; i++) if ((await conversation()).mixed) mixed++;
    // Counts only, never the replies themselves (no message text in logs).
    console.log(`recall-speakers: ${process.env.LYRICA_EVAL_MODEL}: ${mixed}/${runs} replies mixed up who said what`);
    expect(mixed).toBe(0);
  }, 900_000);
});
