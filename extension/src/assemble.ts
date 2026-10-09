import { pronounLabel, type Persona, type Profile } from "@lyrica/core";
import type { MemorySections } from "./memory.ts";
import type { RoutedTopic } from "./routing.ts";

/** Character budgets per prompt section. */
export interface Budgets {
  persona: number;
  topics: number;
  notice: number;
  opening: number;
  wake: number;
  about: number;
  pages: number;
  folders: number;
  user: number;
  recall: number;
  time: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  persona: 8000,
  topics: 9000,
  notice: 400,
  opening: 1500,
  wake: 4000,
  about: 1500,
  pages: 3000,
  folders: 4000,
  user: 600,
  recall: 4000,
  time: 300,
};

export interface PromptInput {
  persona: Persona;
  topics: RoutedTopic[];
  memory: MemorySections;
  /** The person she's talking with. */
  profile: Profile;
  now: Date;
}

export interface Section {
  name: keyof Budgets;
  text: string;
  budget: number;
  truncated: boolean;
  /** "system" stays in the cacheable system prompt; "turn" goes in this turn's message. */
  place: "system" | "turn";
}

export interface Assembled {
  /** The persona core: Pi's `customPrompt`. */
  customPrompt: string;
  /** Stable sections for Pi's `sections`, in order: topics, notice, opening, wake, about, pages, folders, user. Pi adds the tags. */
  sections: Record<string, string>;
  /** Content that changes every turn (recall, time), sent as a message so the prompt prefix stays cacheable. */
  turn: string;
  report: Section[];
}

/**
 * Splits her context into a stable system prompt (persona core, topics, an
 * unlogged notice, WAKE, the page about the user, page index, folder pages,
 * who she's talking with) and a per-turn message (recall, time).
 */
export function assemble(input: PromptInput, budgets: Budgets = DEFAULT_BUDGETS): Assembled {
  const report: Section[] = [];
  const add = (name: keyof Budgets, body: string | undefined, place: Section["place"]) => {
    const raw = body?.trim();
    if (!raw) return undefined;
    const text = fit(raw, budgets[name]);
    report.push({ name, text, budget: budgets[name], truncated: text !== raw, place });
    return text;
  };

  const customPrompt = add("persona", input.persona.core.map((f) => f.text.trim()).join("\n\n"), "system") ?? "";

  const sections: Record<string, string> = {};
  const topics = topicBlocks(input.topics, budgets.topics);
  if (topics.text) {
    sections.topics = topics.text;
    report.push({ name: "topics", text: topics.text, budget: budgets.topics, truncated: topics.truncated, place: "system" });
  }
  const stable: [keyof Budgets, string | undefined][] = [
    ["notice", input.memory.notice],
    ["opening", input.memory.opening],
    ["wake", input.memory.wake],
    ["about", input.memory.about],
    ["pages", input.memory.pageIndex],
    ["folders", input.memory.folders],
    ["user", whoLine(input.profile)],
  ];
  for (const [name, body] of stable) {
    const text = add(name, body, "system");
    if (text) sections[name] = text;
  }

  const turn = (["recall", "time"] as const)
    .map((name) => {
      const text = add(name, name === "recall" ? input.memory.recall : timeLine(input.now, input.memory.lastTalk), "turn");
      return text && `<${name}>\n${text}\n</${name}>`;
    })
    .filter(Boolean)
    .join("\n\n");

  return { customPrompt, sections, turn, report };
}

function topicBlocks(topics: RoutedTopic[], budget: number): { text: string; truncated: boolean } {
  let room = budget;
  let truncated = false;
  const blocks: string[] = [];
  for (const { topic } of topics) {
    const raw = topic.text.trim();
    if (room < 200 || !raw) continue;
    const body = fit(raw, room);
    truncated ||= body !== raw;
    blocks.push(`<topic id="${topic.id}">\n${body}\n</topic>`);
    room -= body.length;
  }
  return { text: blocks.join("\n\n"), truncated };
}

/** Cuts text to at most `budget` characters, at a paragraph or line break when one is near. */
export function fit(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, Math.max(0, budget - 2));
  const cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
  return `${cut > budget / 2 ? head.slice(0, cut) : head}\n…`;
}

function whoLine(p: Profile): string {
  const lines = [`You are talking with ${p.displayName} (pronouns: ${pronounLabel(p.pronouns)}).`];
  if (p.previousNames.length) {
    const prev = p.previousNames.map((n) => `${n.name} (until ${n.until})`).join(", ");
    lines.push(`Earlier conversations may call ${p.displayName} by a previous name: ${prev}.`);
  }
  return lines.join("\n");
}

function timeLine(now: Date, lastTalk?: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short" });
  const line = `It is ${fmt.format(now)}.`;
  return lastTalk ? `${line} You last talked ${ago(now.getTime() - lastTalk.getTime())}.` : line;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return min <= 1 ? "a minute ago" : `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 48) return h === 1 ? "an hour ago" : `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}
