import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SKILL_LIMITS, type ExecutionTarget, type Skill } from "@lyrica/core";
import { Type } from "typebox";

// Skills (docs/briefs/skills.md): one line per skill in every thread's prompt, the body read only when a task calls
// for it. Library skills (the person's and hers, in user.db) read with read_memory s:<name>; a repository's with read.

export const SKILLS_IN_ALL = 4000;
export const SKILLS_LISTED = 40;
const REPO_SKILLS_MAX = 20;
export const SKILLS_HEADING = "Your skills: procedures for jobs that come up again. Before doing a job one describes, read it and follow it.";

export interface ListedSkill { name: string; description: string; /** Where to read it: s:<name> or a file path. */ at: string }

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The skills section: library skills first, then repositories', whole lines within the limits. */
export function skillsIndex(skills: ListedSkill[]): string | undefined {
  const lines: string[] = [];
  let left = SKILLS_IN_ALL - SKILLS_HEADING.length;
  for (const s of skills.slice(0, SKILLS_LISTED)) {
    const line = `<skill name="${attr(s.name)}" read="${attr(s.at)}">${attr(s.description)}</skill>`;
    if (line.length + 1 > left) break;
    left -= line.length + 1;
    lines.push(line);
  }
  return lines.length ? [SKILLS_HEADING, ...lines].join("\n") : undefined;
}

/** A SKILL.md's frontmatter name and description, or undefined without a description. */
export function skillFrontmatter(text: string, fallbackName: string): { name: string; description: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  const field = (key: string) => {
    const v = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]!)?.[1]?.trim();
    return v?.replace(/^(["'])(.*)\1$/, "$2").trim();
  };
  const description = field("description");
  if (!description) return undefined;
  return { name: (field("name") || fallbackName).slice(0, SKILL_LIMITS.name), description: description.replace(/\s+/g, " ").slice(0, SKILL_LIMITS.description) };
}

/** Each checkout's .claude/skills and .agents/skills, by their SKILL.md frontmatter. No model or network request. */
export async function repoSkills(target: ExecutionTarget, checkouts: string[]): Promise<ListedSkill[]> {
  if (!target.run || !checkouts.length) return [];
  const run = (args: string[]) => target.run!(args, { timeoutMs: 5000 }).catch(() => undefined);
  const out: ListedSkill[] = [];
  const seen = new Set<string>();
  for (const checkout of checkouts) {
    const top = (await run(["git", "-C", checkout, "rev-parse", "--show-toplevel"]))?.stdout.toString().trim();
    if (!top || seen.has(top)) continue;
    seen.add(top);
    const listed = await run(["git", "-C", top, "ls-files", "--", ":(glob).claude/skills/*/SKILL.md", ":(glob).agents/skills/*/SKILL.md"]);
    if (listed?.code !== 0) continue;
    for (const path of listed.stdout.toString().split("\n").filter(Boolean).slice(0, REPO_SKILLS_MAX)) {
      const file = `${top}/${path}`;
      const r = await run(["head", "-c", "4096", "--", file]);
      const meta = r?.code === 0 ? skillFrontmatter(r.stdout.toString(), path.split("/").at(-2)!) : undefined;
      if (meta) out.push({ ...meta, at: file });
    }
  }
  return out;
}

export interface SkillToolOptions {
  /** Saves her draft from this call: active at once with the person's auto-approve, otherwise waiting. */
  propose(input: { name: string; description: string; body: string }, toolCallId: string): Skill;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function registerSkillTool(pi: ExtensionAPI, o: SkillToolOptions): void {
  pi.registerTool({
    name: "save_skill",
    label: "Save skill",
    description: "Save a skill: a procedure for a job that comes up again. Saving a name you have replaces that skill.",
    promptSnippet: "save a reusable procedure as a skill",
    promptGuidelines: [
      "Save a skill with save_skill after a job you will do again worked, or when the person asks you to remember how to do something. Write the steps that worked, not the story of this job.",
      "A skill holds no credentials and no facts about the person: those go in notes.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Lowercase words joined by -, such as render-check." }),
      description: Type.String({ description: `One line, at most ${SKILL_LIMITS.description} characters: when to use it.` }),
      body: Type.String({ description: `The steps in Markdown, at most ${SKILL_LIMITS.body} characters.` }),
    }),
    async execute(toolCallId, params) {
      const s = o.propose(params, toolCallId);
      return text(s.state === "active"
        ? `Saved ${s.name}: it's in your skills now.`
        : `Saved ${s.name} as a draft: it's on a card for the person to approve, and you can use it once they do.`);
    },
  });
}
