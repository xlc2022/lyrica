import type { Topic } from "@lyrica/core";

/** Most topics loaded for one turn. */
export const MAX_TOPICS = 3;
/** Turns a topic stays loaded after the last message that triggered it. */
export const PERSIST_TURNS = 3;

export interface RoutedTopic {
  topic: Topic;
  score: number;
  /** True when this turn's message triggered it; false while it persists. */
  fresh: boolean;
  /** Further turns it will persist without a new trigger. */
  turnsLeft: number;
}

/** Trigger overlap plus priority. A topic with no trigger in the text scores 0. */
export function scoreTopic(topic: Topic, text: string): number {
  const overlap = topic.triggers.filter((t) => triggerRegex(t).test(text)).length;
  return overlap > 0 ? overlap + topic.priority : 0;
}

function triggerRegex(trigger: string): RegExp {
  const escaped = trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}(?:s|es)?\\b`, "i");
}

/**
 * Picks up to MAX_TOPICS per turn. A triggered topic persists for PERSIST_TURNS
 * more turns with a decaying score. Only a new trigger resets its count, so
 * persistence always expires (Monika's version reset the count while persisting).
 */
export class TopicRouter {
  private readonly active = new Map<string, { base: number; turnsLeft: number }>();

  route(topics: Topic[], text: string): RoutedTopic[] {
    const candidates: RoutedTopic[] = [];
    for (const topic of topics) {
      const score = scoreTopic(topic, text);
      const prev = this.active.get(topic.id);
      if (score > 0) {
        this.active.set(topic.id, { base: score, turnsLeft: PERSIST_TURNS });
        candidates.push({ topic, score, fresh: true, turnsLeft: PERSIST_TURNS });
      } else if (prev && prev.turnsLeft > 0) {
        prev.turnsLeft--;
        const decayed = (prev.base * (prev.turnsLeft + 1)) / (PERSIST_TURNS + 1);
        candidates.push({ topic, score: decayed, fresh: false, turnsLeft: prev.turnsLeft });
      } else {
        this.active.delete(topic.id);
      }
    }
    for (const id of this.active.keys()) {
      if (!topics.some((t) => t.id === id)) this.active.delete(id);
    }
    return candidates
      .sort((a, b) => b.score - a.score || b.topic.priority - a.topic.priority || a.topic.id.localeCompare(b.topic.id))
      .slice(0, MAX_TOPICS);
  }
}
