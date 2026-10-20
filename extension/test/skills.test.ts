import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRONOUN_PRESETS, type ExecutionTarget, type Persona, type Skill } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { createLyricaExtension, repoSkills, skillFrontmatter, SKILLS_HEADING, SKILLS_IN_ALL, skillsIndex, type LyricaOptions } from "../src/index.ts";
import { withMemory } from "./helpers.ts";

const local = { run: async (argv: string[]) => {
  const r = spawnSync(argv[0]!, argv.slice(1));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
} } as unknown as ExecutionTarget;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

/** The extension against a fake Pi: one turn's prompt sections, and the registered tools by name. */
function load(thread: Awaited<ReturnType<typeof withMemory>>, skills: LyricaOptions["skills"]) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, { execute: Function }>();
  let active: string[] = [];
  const pi = {
    on: (event: string, h: Function) => handlers.set(event, h),
    registerTool: (t: { name: string; execute: Function }) => { tools.set(t.name, t); active.push(t.name); },
    getActiveTools: () => [...active],
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
  void createLyricaExtension(thread.thread().context, { persona: () => persona, profile: () => ({ displayName: "Ada", pronouns: PRONOUN_PRESETS.she, previousNames: [] }), skills })(pi);
  const turn = async () => {
    const options = { cwd: "/", selectedTools: [], sections: {} as Record<string, string> };
    await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: options }, { hasUI: false });
    return options.sections;
  };
  return { turn, tools };
}

describe("skills", () => {
  it("list each skill on one line within the limits, library skills first", () => {
    const index = skillsIndex([
      { name: "release", description: "When cutting a release.", at: "s:release" },
      { name: "deploy", description: 'Deploys "prod" <safely>', at: "/workspace/repos/app/.claude/skills/deploy/SKILL.md" },
    ])!;
    expect(index.split("\n")).toEqual([
      SKILLS_HEADING,
      '<skill name="release" read="s:release">When cutting a release.</skill>',
      '<skill name="deploy" read="/workspace/repos/app/.claude/skills/deploy/SKILL.md">Deploys &quot;prod&quot; &lt;safely></skill>',
    ]);
    const many = skillsIndex(Array.from({ length: 80 }, (_, i) => ({ name: `skill-${i}`, description: "x".repeat(150), at: `s:skill-${i}` })))!;
    expect(many.length).toBeLessThanOrEqual(SKILLS_IN_ALL);
    expect(many.endsWith("</skill>")).toBe(true);
    expect(skillsIndex([])).toBeUndefined();
  });

  it("read a repository's skills from their SKILL.md frontmatter", async () => {
    const dir = repo({
      ".claude/skills/render-check/SKILL.md": "---\nname: render-check\ndescription: \"Before saying a scene renders.\"\n---\nTake a screenshot.\n",
      ".agents/skills/ci-fix/SKILL.md": "---\ndescription: When CI is red.\n---\nRead the log first.\n",
      ".claude/skills/no-meta/SKILL.md": "Just text.\n",
    });
    const skills = await repoSkills(local, [dir, dir]);
    expect(skills.map((s) => [s.name, s.description, s.at])).toEqual([
      ["ci-fix", "When CI is red.", `${dir}/.agents/skills/ci-fix/SKILL.md`],
      ["render-check", "Before saying a scene renders.", `${dir}/.claude/skills/render-check/SKILL.md`],
    ]);
    expect(await repoSkills(local, [mkdtempSync(join(tmpdir(), "plain-"))])).toEqual([]);
    expect(skillFrontmatter("---\nname: x\n---\n", "x")).toBeUndefined();
  });

  it("put the index in the prompt, read a library skill with read_memory s:<name>, and save hers with save_skill", async () => {
    const m = await withMemory();
    const saved: { input: unknown; call: string }[] = [];
    const { turn, tools } = load(m, {
      index: async () => skillsIndex([{ name: "release", description: "When cutting a release.", at: "s:release" }]),
      read: (name) => (name === "release" ? "1. Tag it." : undefined),
      propose: (input, call) => { saved.push({ input, call }); return { ...input, pool: "general", state: "waiting", author: "lyrica", at: "" } as Skill; },
    });
    expect((await turn()).skills).toContain('<skill name="release" read="s:release">');
    const read = (id: string) => tools.get("read_memory")!.execute("c", { id });
    expect((await read("s:release")).content[0].text).toBe("1. Tag it.");
    expect((await read("s:nothing")).content[0].text).toBe("No skill nothing.");
    const result = await tools.get("save_skill")!.execute("call-7", { name: "ci-fix", description: "When CI is red.", body: "Read the log." });
    expect(saved).toEqual([{ input: { name: "ci-fix", description: "When CI is red.", body: "Read the log." }, call: "call-7" }]);
    expect(result.content[0].text).toMatch(/card for the person to approve/);
  });

  it("leave the section and save_skill out without skills", async () => {
    const { turn, tools } = load(await withMemory(), undefined);
    expect((await turn()).skills).toBeUndefined();
    expect(tools.has("save_skill")).toBe(false);
  });
});
