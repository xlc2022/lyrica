import { pronounLabel, type Persona, type Profile } from "@lyrica/core";
import type { MemorySections } from "./memory.ts";
import type { RoutedTopic } from "./routing.ts";

/** Character budgets per prompt section. */
export interface Budgets {
  persona: number;
  topics: number;
  wake: number;
  pages: number;
  recall: number;
  time: number;
  user: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  persona: 8000,
  topics: 9000,
  wake: 4000,
  pages: 3000,
  recall: 4000,
  time: 300,
  user: 300,
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
}

/** Builds the system prompt: persona core, topics, WAKE, page index, recall, time, who you're talking with. */
export function assemble(input: PromptInput, budgets: Budgets = DEFAULT_BUDGETS): { prompt: string; sections: Section[] } {
  const sections: Section[] = [];
  const add = (name: keyof Budgets, body: string | undefined, wrap = (s: string) => `<${name}>\n${s}\n</${name}>`) => {
    if (!body?.trim()) return;
    const fitted = fit(body.trim(), budgets[name]);
    sections.push({ name, text: wrap(fitted), budget: budgets[name], truncated: fitted !== body.trim() });
  };

  add("persona", input.persona.core.map((f) => f.text.trim()).join("\n\n"));

  let room = budgets.topics;
  const topicTexts: string[] = [];
  let topicsTruncated = false;
  for (const { topic } of input.topics) {
    if (room < 200 || !topic.text.trim()) continue;
    const body = fit(topic.text.trim(), room);
    topicsTruncated ||= body !== topic.text.trim();
    topicTexts.push(`<topic id="${topic.id}">\n${body}\n</topic>`);
    room -= body.length;
  }
  if (topicTexts.length) sections.push({ name: "topics", text: topicTexts.join("\n\n"), budget: budgets.topics, truncated: topicsTruncated });

  add("wake", input.memory.wake);
  add("pages", input.memory.pageIndex);
  add("recall", input.memory.recall);
  add("time", timeLine(input.now, input.memory.lastTalk));
  add("user", whoLine(input.profile));

  return { prompt: sections.map((s) => s.text).join("\n\n"), sections };
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
