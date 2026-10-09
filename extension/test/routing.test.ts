import type { Topic } from "@lyrica/core";
import { describe, expect, it } from "vitest";
import { MAX_TOPICS, PERSIST_TURNS, scoreTopic, TopicRouter } from "../src/routing.ts";

const topic = (id: string, triggers: string[], priority = 1): Topic => ({ id, summary: "", triggers, priority, text: `${id} text` });
const topics = [
  topic("music", ["music", "song", "chord", "piano"], 2),
  topic("literature", ["poem", "poetry", "novel"], 2),
  topic("language", ["word", "etymology", "grammar"], 2),
  topic("organization", ["archive", "notes", "schedule"], 1),
  topic("narrative", ["story", "plot", "arc"], 2),
];
const ids = (r: { topic: Topic }[]) => r.map((t) => t.topic.id);

describe("topic routing", () => {
  it("scores trigger overlap plus priority, on whole words", () => {
    expect(scoreTopic(topics[0]!, "a song with one chord")).toBe(4);
    expect(scoreTopic(topics[0]!, "two songs")).toBe(3);
    expect(scoreTopic(topics[4]!, "the archive is in the archway")).toBe(0);
    expect(scoreTopic(topics[0]!, "nothing relevant")).toBe(0);
  });

  it("picks at most three topics, best first", () => {
    const routed = new TopicRouter().route(topics, "a song, a poem, a word, a story, notes about a chord");
    expect(routed).toHaveLength(MAX_TOPICS);
    expect(routed[0]!.topic.id).toBe("music");
    expect(ids(routed)).not.toContain("organization");
  });

  it("persists a topic for three turns with a decaying score, then expires", () => {
    const router = new TopicRouter();
    const first = router.route(topics, "play me a song");
    expect(first[0]).toMatchObject({ fresh: true, turnsLeft: PERSIST_TURNS });

    const scores: number[] = [];
    for (let turn = 1; turn <= PERSIST_TURNS; turn++) {
      const r = router.route(topics, "how was your day?");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ fresh: false, turnsLeft: PERSIST_TURNS - turn });
      scores.push(r[0]!.score);
    }
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(router.route(topics, "and tomorrow?")).toEqual([]);
    expect(router.route(topics, "still nothing")).toEqual([]);
  });

  it("only a new trigger resets the count", () => {
    const router = new TopicRouter();
    router.route(topics, "a song");
    router.route(topics, "hm");
    router.route(topics, "hm");
    expect(router.route(topics, "another song")[0]).toMatchObject({ fresh: true, turnsLeft: PERSIST_TURNS });
  });

  it("lets fresh topics push out persisting ones", () => {
    const router = new TopicRouter();
    router.route(topics, "song, poem and a word");
    const r = router.route(topics, "a story about the archive notes and schedule");
    expect(ids(r).slice(0, 2)).toEqual(["organization", "narrative"]);
    expect(r).toHaveLength(MAX_TOPICS);
  });
});
