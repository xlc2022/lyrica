import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Memory, PersonaProposals, PersonaStore, PRONOUN_PRESETS, projectSlug, type Persona, type Profile } from "@lyrica/core";
import { createLyricaExtension, recordEntries, Sleep, type ThreadContext } from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatRequest, Reply } from "../core/test/fake-openai.ts";
import { withModels } from "../core/test/helpers.ts";

// Scenario: a decision made in one thread of a project is on the project's
// page the next morning.
//
// Thread 1 of the "Garden app" project: Ada says "Let's use SQLite, not
// Postgres." She notes it. That night, sleep keeps the project's page.
// Expected: the page states the decision, citing the note, and a later
// thread of the project has it in context.
//
// By hand: in a project, say the first line in a thread, check she noted it,
// run /sleep, and open the project's page in the memory browser.
//
// Scripted: pi-ai's fake model plays the conversation and a scripted model
// plays the night, writing the page only if the note and the page's slug
// reached consolidation. It checks what reaches her, not how well a model
// writes.

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const profile: Profile = { displayName: "Ada", pronouns: PRONOUN_PRESETS.she, previousNames: [] };

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lyrica-eval-")); dirs.push(d); return d; };

async function converse(thread: ThreadContext, prompt: string, steps: ((context: string) => ReturnType<typeof fauxAssistantMessage>)[]): Promise<void> {
  const dir = tmp();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  faux.setResponses(steps.map((step) => (ctx: { messages: unknown[] }) => step(JSON.stringify(ctx.messages))));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createLyricaExtension(thread, { persona: () => persona, profile: () => profile })],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" });
  await session.bindExtensions({});
  await session.setModel(faux.getModel());
  recordEntries(session, thread.view.own, thread.threadId);
  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }
}

describe("a project's decision carries over to its page", () => {
  it("after a night's sleep, the project's page states a decision noted in one of its threads", async () => {
    const m = await withModels();
    m.models.setProfile(m.li.id, "cloud", "chat", m.cloudRef);
    const memory = new Memory(m.keyring, m.users);
    const view = memory.openThreadView(m.li.id, "general");
    const chat = view.own.createThread({ interface: "web", project: true, title: "Garden app", goal: "Ship the garden app" });
    const { id } = view.own.createThread({ interface: "web", parent: chat.id, child: true });
    const first: ThreadContext = { user: m.li, pool: "general", interface: "web", threadId: id, view, call: m.models.callContext(m.li.id, "general", id) };
    await converse(first, "Let's use SQLite, not Postgres.", [
      () => fauxAssistantMessage(fauxToolCall("remember", { notes: [{ text: "{user} decided the garden app uses SQLite, not Postgres" }] }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("SQLite it is."),
    ]);
    const note = view.own.projectNotes(chat.id)[0]!.id;
    const slug = projectSlug(chat.id);

    const night = (c: ChatRequest): Reply => {
      const tools = (c.tools ?? []).map((t) => t.function.name);
      const seen = JSON.stringify(c.messages);
      if (c.messages.at(-1)?.role === "tool") return { text: "Done." };
      if (tools.includes("write_page") && seen.includes(note) && seen.includes(slug)) {
        return { tools: [{ name: "write_page", args: { slug, title: "Garden app", summary: "the garden app project", text: `Decided: SQLite, not Postgres [${note}].` } }] };
      }
      if (tools.includes("write_journal")) return { tools: [{ name: "write_journal", args: { text: "A quiet night." } }] };
      if (tools.includes("write_wake")) return { tools: [{ name: "write_wake", args: { text: "The garden app is moving." } }] };
      return { text: "Done." };
    };
    m.cloud.respond(night);
    const store = new PersonaStore(m.keyring.self());
    store.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
    const sleep = new Sleep({
      users: m.users, memory, models: m.models, persona: store, proposals: new PersonaProposals(m.keyring.self(), m.users, store), cwd: tmp(),
      hasKey: (u) => m.keyring.hasUserKey(u), limits: { retries: 0 },
    });
    expect((await sleep.run(m.li.id, "general", "scheduled")).status).toBe("complete");

    const next = view.own.createThread({ interface: "web", parent: chat.id, child: true });
    expect(view.own.pageForProject(next.id)?.text).toContain("SQLite, not Postgres");
    // After the night the note is past the watermark: it reaches the next thread through the page.
    expect(view.own.projectNotes(chat.id, view.own.watermark())).toHaveLength(0);
    let seen = "";
    await converse({ ...first, threadId: next.id, call: m.models.callContext(m.li.id, "general", next.id) }, "Which database are we on?", [
      (context) => { seen = context; return fauxAssistantMessage("SQLite."); },
    ]);
    expect(seen).toContain("Decided: SQLite, not Postgres");
    view.close();
  });
});
