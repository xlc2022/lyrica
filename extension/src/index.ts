import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isThreadView, type CallContext, type Interface, type Persona, type Pool, type PoolView, type Profile, type User } from "@lyrica/core";
import { assemble, type Budgets, type Section } from "./assemble.ts";
import { contextLines, registerContext, type ContextMeter } from "./context.ts";
import { setToolsOff } from "./gate.ts";
import { memorySections } from "./memory.ts";
import { SELF_PRIMER } from "./primer.ts";
import { TopicRouter, type RoutedTopic } from "./routing.ts";
import { reactionLines, type UserReaction } from "./react.ts";
import { registerMemoryTools } from "./tools.ts";

export * from "./assemble.ts";
export * from "./context.ts";
export * from "./gate.ts";
export * from "./images.ts";
export * from "./mcp.ts";
export * from "./memory.ts";
export * from "./models-tool.ts";
export * from "./react.ts";
export * from "./record.ts";
export * from "./routing.ts";
export * from "./sleep.ts";
export * from "./threads.ts";
export * from "./web.ts";
export * from "./workspace.ts";

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
  /** The thread's granted folders, read every turn. Workspace supplies them; defaults to none. */
  folders?: () => string[];
  /** Show routed topics and the assembled prompt each turn. */
  debugPrompt?: boolean;
  budgets?: Budgets;
  now?: () => Date;
  /** "read" (sleep): recall and read_memory, without remember. Default "full". */
  memoryTools?: "full" | "read";
  /** Memories this thread must not see, in recall and read_memory alike. */
  hide?: (id: string) => boolean;
  /** The /sleep command, where the host offers it (the bench). */
  sleep?: (ctx: ExtensionCommandContext) => Promise<void>;
  /** lyricad's meter for this thread: measures each turn, adds her status line; the `threads` tool compacts with it. */
  meter?: ContextMeter;
  /** In a project chat: its threads with their state, one line each, read every turn. */
  projectThreads?: () => string | undefined;
  /** The user's reactions since her last turn, taken each turn: told to her in the turn message. */
  reactions?: () => UserReaction[];
}

/** The Lyrica Pi extension for one thread. */
export function createLyricaExtension(thread: ThreadContext, opts: LyricaOptions): ExtensionFactory {
  // Only a view from openThreadView may reach a session: never the owner view, never a lookalike.
  if (!isThreadView(thread.view) || thread.view.pool !== thread.pool) throw new Error("the extension needs this thread's own view from openThreadView");
  const { view } = thread;
  const who = () => ({ threadId: thread.threadId, user: { id: thread.user.id, profile: opts.profile() }, hide: opts.hide });
  return (pi) => {
    const router = new TopicRouter();
    registerMemoryTools(pi, view, who, { readOnly: opts.memoryTools === "read" });
    if (opts.meter) registerContext(pi, opts.meter);
    if (opts.sleep) pi.registerCommand("sleep", { description: "Sleep now: consolidate, dream and wake, for this pool", handler: (_args, ctx) => opts.sleep!(ctx) });
    pi.on("before_agent_start", async (event, ctx) => {
      const persona = opts.persona();
      const topics = router.route([...persona.topics, SELF_PRIMER], event.prompt);
      const memory = await memorySections(view, event.prompt, { ...who(), folders: opts.folders?.() ?? [], projectThreads: opts.projectThreads });
      // An unlogged thread isn't offered remember at all.
      if (opts.memoryTools !== "read") setToolsOff(pi, ctx, "unlogged", memory.notice ? ["remember"] : []);
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

      // The user's reactions since her last turn, then her status line, from the last turn's measurement, and the line telling her to prepare or compact.
      const told = [turn, reactionLines(opts.reactions?.() ?? [], thread.threadId, opts.profile().displayName)].filter(Boolean).join("\n\n");
      let full = told;
      if (opts.meter) {
        const defs = pi.getAllTools().filter((t) => pi.getActiveTools().includes(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
        opts.meter.setPrompt(report, tools.length + JSON.stringify(defs).length);
        const lines = contextLines(opts.meter);
        if (lines) full = [told, `<context>\n${lines}\n</context>`].filter(Boolean).join("\n\n");
      }

      if (opts.debugPrompt) showDebug(ctx, topics, report, `${event.systemPrompt}\n\n--- this turn ---\n${full}`);
      return full ? { message: { customType: "lyrica-turn", content: full, display: false } } : undefined;
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
export * from "./models.ts";
export * from "./plans.ts";
export * from "./session.ts";
export * from "./delegate/index.ts";
