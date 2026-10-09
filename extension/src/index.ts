import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CallContext, Interface, Persona, Pool, PoolView, User } from "@lyrica/core";
import { assemble, type Budgets, type Section } from "./assemble.ts";
import { memorySections } from "./memory.ts";
import { TopicRouter, type RoutedTopic } from "./routing.ts";

export * from "./assemble.ts";
export * from "./memory.ts";
export * from "./routing.ts";

export interface ThreadContext {
  user: User;
  pool: Pool;
  interface: Interface;
  threadId: string;
  view: PoolView;
  call: CallContext;
}

export interface LyricaOptions {
  /** Current persona; called every turn so approved changes apply at once. */
  persona: () => Persona;
  displayName: string;
  /** Show routed topics and the assembled prompt each turn. */
  debug?: boolean;
  budgets?: Budgets;
  now?: () => Date;
}

/** The Lyrica Pi extension for one thread. */
export function createLyricaExtension(thread: ThreadContext, opts: LyricaOptions): ExtensionFactory {
  return (pi) => {
    const router = new TopicRouter();
    pi.on("before_agent_start", async (event, ctx) => {
      const persona = opts.persona();
      const topics = router.route(persona.topics, event.prompt);
      const memory = await memorySections(thread.view, event.prompt);
      const { prompt, sections } = assemble(
        { persona, topics, memory, displayName: opts.displayName, now: opts.now?.() ?? new Date() },
        opts.budgets,
      );
      if (opts.debug) showDebug(ctx, topics, sections, prompt);
      return { systemPrompt: prompt };
    });
  };
}

function showDebug(ctx: ExtensionContext, topics: RoutedTopic[], sections: Section[], prompt: string): void {
  const routed = topics.map((t) => `${t.topic.id} (${t.fresh ? "new" : `${t.turnsLeft} left`}, ${t.score.toFixed(2)})`);
  const sizes = sections.map((s) => `${s.name} ${s.text.length}/${s.budget}${s.truncated ? " cut" : ""}`);
  const text = `[lyrica] topics: ${routed.join(", ") || "none"}\n[lyrica] sections: ${sizes.join(", ")}\n${prompt}`;
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else process.stderr.write(`${text}\n`);
}
