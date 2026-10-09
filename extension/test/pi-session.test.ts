import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PRONOUN_PRESETS, type Persona, type Profile } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLyricaExtension } from "../src/index.ts";

// Runs the extension inside a real Pi session against pi-ai's fake model, and
// records what the model receives on each turn.

const persona: Persona = {
  core: [{ path: "SOUL.md", text: "She is Lyrica." }],
  topics: [{ id: "music", summary: "", triggers: ["song"], priority: 2, text: "Music is structured feeling." }],
};
const profile: Profile = { displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function session() {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-pi-"));
  dirs.push(dir);
  const seen: { system: string; turn: string }[] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  const reply = (ctx: { messages: unknown[] }) => {
    const text = (m: unknown) => JSON.stringify(m);
    seen.push({
      system: ctx.messages.filter((m) => (m as { role: string }).role === "system").map(text).join("\n"),
      turn: ctx.messages.filter((m) => text(m).includes("<time>")).map(text).join("\n"),
    });
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([reply, reply]);

  const testTool: ExtensionFactory = (pi) => pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Search memory.",
    promptSnippet: "search what you remember",
    promptGuidelines: ["Use recall before saying you don't remember"],
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
  });
  let minute = 0;
  const lyrica = createLyricaExtension(
    {
      user: { id: "u1", login: "li", admin: true, profile }, pool: "general", interface: "cli", threadId: "t1",
      view: { pool: "general" }, call: { userId: "u1", pool: "general", localOnly: false },
    },
    { persona: () => persona, profile: () => profile, now: () => new Date(Date.UTC(2026, 9, 9, 12, minute++)) },
  );
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), testTool, lyrica],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin",
  });
  await session.bindExtensions({});
  await session.setModel(faux.getModel());
  return { session, seen };
}

describe("in a Pi session", () => {
  it("keeps the system prompt identical across turns and sends the time as a message", async () => {
    const { session: s, seen } = await session();
    try {
      await s.prompt("sing me a song");
      await s.prompt("another song, please");
    } finally {
      s.dispose();
    }
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(first!.system).toContain("She is Lyrica.");
    expect(first!.system).toContain('<topic id=\\"music\\">');
    expect(first!.system).toContain("You are talking with Li (pronouns: she/her).");
    expect(first!.system).not.toContain("<time>");
    expect(first!.system).not.toContain("expert coding assistant");
    expect(second!.system).toBe(first!.system);
    expect(first!.turn).toContain("12:00");
    expect(second!.turn).toContain("12:01");
  });

  it("keeps the tools' own prompt guidance", async () => {
    const { session: s, seen } = await session();
    try {
      await s.prompt("hello");
    } finally {
      s.dispose();
    }
    expect(seen[0]!.system).toContain("- recall: search what you remember");
    expect(seen[0]!.system).toContain("Use recall before saying you don't remember");
  });
});
