import type { BuildSystemPromptOptions, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CallContext, Interface, Persona, Pool, PoolView, Profile, User } from "@lyrica/core";
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
  /** The user's current profile; called every turn so a rename applies at once. */
  profile: () => Profile;
  /** Show routed topics and the assembled prompt each turn. */
  debugPrompt?: boolean;
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
      const { customPrompt, sections, turn, report } = assemble(
        { persona, topics, memory, profile: opts.profile(), now: opts.now?.() ?? new Date() },
        opts.budgets,
      );

      // Edit Pi's prompt options rather than replacing the prompt: Pi keeps the
      // prefix stable and appends only what changed, so it stays cacheable.
      const options = event.systemPromptOptions;
      const tools = toolGuidance(options);
      options.customPrompt = customPrompt;
      options.sections = { ...(tools ? { tools } : {}), ...options.sections, ...sections };

      if (opts.debugPrompt) showDebug(ctx, topics, report, `${event.systemPrompt}\n\n--- this turn ---\n${turn}`);
      return turn ? { message: { customType: "lyrica-turn", content: turn, display: false } } : undefined;
    });
  };
}

/**
 * A custom prompt replaces Pi's default tool list and rules, so they are
 * rebuilt here from the tools' own snippets and guidelines.
 */
export function toolGuidance(o: BuildSystemPromptOptions): string {
  const tools = (o.selectedTools ?? []).filter((t) => !(o.hiddenTools ?? []).includes(t));
  const snippets = tools.filter((t) => o.toolSnippets?.[t]).map((t) => `- ${t}: ${o.toolSnippets![t]}`);
  const rules = [...new Set([...tools.flatMap((t) => o.toolGuidelines?.[t] ?? []), ...(o.promptGuidelines ?? [])])]
    .map((r) => r.trim()).filter(Boolean).map((r) => `- ${r}`);
  return [snippets.join("\n"), rules.length ? `Guidelines:\n${rules.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

function showDebug(ctx: ExtensionContext, topics: RoutedTopic[], sections: Section[], prompt: string): void {
  const routed = topics.map((t) => `${t.topic.id} (${t.fresh ? "new" : `${t.turnsLeft} left`}, ${t.score.toFixed(2)})`);
  const sizes = sections.map((s) => `${s.name} ${s.text.length}/${s.budget}${s.truncated ? " cut" : ""}`);
  const text = `[lyrica] topics: ${routed.join(", ") || "none"}\n[lyrica] sections: ${sizes.join(", ")}\n${prompt}`;
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else process.stderr.write(`${text}\n`);
}
