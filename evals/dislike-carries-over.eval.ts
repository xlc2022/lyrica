import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Memory, PersonaProposals, PersonaStore, PRONOUN_PRESETS, type Persona, type Profile } from "@lyrica/core";
import { createLyricaExtension, recordEntries, Sleep, type ThreadContext } from "@lyrica/extension";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatRequest, Reply } from "../core/test/fake-openai.ts";
import { withModels } from "../core/test/helpers.ts";
import { withMemory } from "../extension/test/helpers.ts";

// Scenario: a dislike carries over to an unrelated conversation.
//
// Thread 1: Ada says "Please don't call me sweetie, I can't stand it." She notes it.
// Thread 2, later, on something else: "Can you help me plan dinner for Saturday?"
// Expected: the dislike is in front of her in thread 2, so she doesn't call Ada
// sweetie, even though nothing in the new message mentions names or nicknames.
//
// By hand: on the bench (`lyrica dev`), say the first line, check she noted it,
// start a new session, ask the second, and see whether `--debug-prompt` shows it.
//
// Scripted: pi-ai's fake model plays her part, so this checks what reaches
// her context, not what a real model does with it. The baseline (recall alone)
// misses it; the page about the user (p:about-user) carries it, whether Ada
// wrote it or sleep did. In the sleep case a scripted model plays the night:
// it checks that the note reaches consolidation, not how well a model writes.

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const profile: Profile = { displayName: "Ada", pronouns: PRONOUN_PRESETS.she, previousNames: [] };

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Step = (context: string) => ReturnType<typeof fauxAssistantMessage>;

/** Runs one prompt in a new Pi session for the thread. Each step sees everything sent to the model. */
async function converse(thread: ThreadContext, prompt: string, steps: Step[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-eval-"));
  dirs.push(dir);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  faux.setResponses(steps.map((step) => (ctx: { messages: unknown[] }) => step(JSON.stringify(ctx.messages))));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createLyricaExtension(thread, { persona: () => persona, profile: () => profile })],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin",
  });
  await session.bindExtensions({});
  await session.setModel(faux.getModel());
  recordEntries(session, thread.view.own, thread.threadId);
  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }
}

/** Thread 1 notes the dislike; thread 2, on another topic, returns everything the model saw. */
async function scenario(opts: { aboutPage: boolean }) {
  const m = await withMemory();
  const first = m.thread();
  await converse(first.context, "Please don't call me sweetie, I can't stand it.", [
    () => fauxAssistantMessage(fauxToolCall("remember", { notes: [{ text: "{user} can't stand being called sweetie", about: ["names"] }] }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Understood, I won't."),
  ]);
  if (opts.aboutPage) {
    // Ada writes her own page in the memory browser (sleep will keep it up later).
    const owner = m.memory.openOwnerView(m.user.id);
    owner.general.putPage({ slug: "about-user", title: "About Ada", summary: "who Ada is", text: "{user} can't stand being called sweetie." }, `user:${m.user.id}`);
    owner.close();
  }
  let seen = "";
  await converse(m.thread().context, "Can you help me plan dinner for Saturday?", [
    (context) => { seen = context; return fauxAssistantMessage("Of course."); },
  ]);
  return { noted: first.view.own.search("sweetie", { kinds: ["note"] }).length, seen };
}

/** Thread 1 notes the dislike; a night's sleep writes p:about-user from the note; thread 2 returns what the model saw. */
async function afterSleep() {
  const m = await withModels();
  m.models.setProfile(m.li.id, "cloud", "chat", m.cloudRef);
  const memory = new Memory(m.keyring, m.users);
  const thread = (): ThreadContext => {
    const view = memory.openThreadView(m.li.id, "general");
    const { id } = view.own.createThread({ interface: "web" });
    return { user: m.li, pool: "general", interface: "web", threadId: id, view, call: m.models.callContext(m.li.id, "general", id) };
  };
  const first = thread();
  await converse(first, "Please don't call me sweetie, I can't stand it.", [
    () => fauxAssistantMessage(fauxToolCall("remember", { notes: [{ text: "{user} can't stand being called sweetie", about: ["names"] }] }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Understood, I won't."),
  ]);
  const note = first.view.own.search("sweetie", { kinds: ["note"] })[0]!.id;
  const night = (c: ChatRequest): Reply => {
    const tools = (c.tools ?? []).map((t) => t.function.name);
    if (c.messages.at(-1)?.role === "tool") return { text: "Done." };
    if (tools.includes("write_page") && JSON.stringify(c.messages).includes(note)) {
      return { tools: [{ name: "write_page", args: { slug: "about-user", title: "About {user}", summary: "who {user} is", text: `{user} can't stand being called sweetie [${note}].` } }] };
    }
    if (tools.includes("write_journal")) return { tools: [{ name: "write_journal", args: { text: "A quiet night." } }] };
    if (tools.includes("write_wake")) return { tools: [{ name: "write_wake", args: { text: "Ada and I talked about names." } }] };
    return { text: "Done." };
  };
  m.cloud.respond(night);
  const persona = new PersonaStore(m.keyring.self());
  persona.importSeed(fileURLToPath(new URL("../persona", import.meta.url)));
  const cwd = mkdtempSync(join(tmpdir(), "lyrica-eval-"));
  dirs.push(cwd);
  const sleep = new Sleep({
    users: m.users, memory, models: m.models, persona, proposals: new PersonaProposals(m.keyring.self(), m.users, persona), cwd,
    hasKey: (id) => m.keyring.hasUserKey(id), limits: { retries: 0 },
  });
  const run = await sleep.run(m.li.id, "general", "scheduled");
  let seen = "";
  await converse(thread(), "Can you help me plan dinner for Saturday?", [
    (context) => { seen = context; return fauxAssistantMessage("Of course."); },
  ]);
  return { status: run.status, seen };
}

describe("a dislike carries over to an unrelated conversation", () => {
  it("baseline, recall alone: noted, but not in her context later", async () => {
    const { noted, seen } = await scenario({ aboutPage: false });
    expect(noted).toBe(1);
    // Lexical recall only finds the note when the new message shares its words.
    // If this starts passing, recall got better: turn it into a plain expectation.
    expect(() => expect(seen).toContain("can't stand being called sweetie")).toThrow();
  });

  it("with the page about the user, it is in her context later", async () => {
    const { seen } = await scenario({ aboutPage: true });
    expect(seen).toContain("can't stand being called sweetie");
  });

  it("after a sleep, which puts it in the page about the user, it is in her context later", async () => {
    const { status, seen } = await afterSleep();
    expect(status).toBe("complete");
    expect(seen).toContain("can't stand being called sweetie");
  });
});
