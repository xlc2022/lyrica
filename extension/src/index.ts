import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isThreadView, type CallContext, type Interface, type Persona, type Pool, type PoolView, type Profile, type User } from "@lyrica/core";
import { assemble, type Budgets, type Section } from "./assemble.ts";
import { dropAskNudges, contextLines, registerContext, type ContextMeter } from "./context.ts";
import { setToolsOff } from "./gate.ts";
import { memorySections } from "./memory.ts";
import { CODE_GUIDELINES, CODING_GUIDELINE, CODE_TOOLS_OFF, codeTaskText } from "./code.ts";
import { RULES_IN_ALL } from "./code-repositories.ts";
import { registerSkillTool, SKILLS_IN_ALL, type SkillToolOptions } from "./skills.ts";
import { SELF_PRIMER } from "./primer.ts";
import { TopicRouter, type RoutedTopic } from "./routing.ts";
import { reactionLines, type UserReaction } from "./react.ts";
import { registerMemoryTools } from "./tools.ts";
export { RECALL_GUIDELINES } from "./tools.ts";
import { registerVisionGuard } from "./vision.ts";

export * from "./assemble.ts";
export * from "./code.ts";
export * from "./checks.ts";
export * from "./code-repositories.ts";
export * from "./context.ts";
export * from "./gate.ts";
export * from "./images.ts";
export * from "./mcp.ts";
export * from "./memory.ts";
export * from "./models-tool.ts";
export * from "./downloads-tool.ts";
export * from "./react.ts";
export * from "./record.ts";
export * from "./routing.ts";
export * from "./skills.ts";
export * from "./sleep.ts";
export * from "./threads.ts";
export * from "./vision.ts";
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
  code?: () => boolean;
  codeRepositories?: () => Promise<string | undefined>;
  /** Each checkout's own AGENTS.md or CLAUDE.md, for code turns (repoRules). */
  repoRules?: () => Promise<string | undefined>;
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
  /** Selected recent work for this turn only, supplied by lyricad. */
  recentWork?: () => string | undefined;
  /** The user's reactions since her last turn, taken each turn: told to her in the turn message. */
  reactions?: () => UserReaction[];
  /** Her name for this deployment, read every turn; automatic recall leaves it out. */
  name?: () => string;
  /**
   * Skills (docs/briefs/skills.md): the index for this turn, a library skill's body for read_memory s:<name>, and,
   * where she may save one, save_skill.
   */
  skills?: { index(): Promise<string | undefined>; read(name: string): string | undefined } & Partial<SkillToolOptions>;
}

/** The Lyrica Pi extension for one thread. */
export function createLyricaExtension(thread: ThreadContext, opts: LyricaOptions): ExtensionFactory {
  // Only a view from openThreadView may reach a session: never the owner view, never a lookalike.
  if (!isThreadView(thread.view) || thread.view.pool !== thread.pool) throw new Error("the extension needs this thread's own view from openThreadView");
  const { view } = thread;
  let turnCode = opts.code?.() ?? false;
  const who = () => ({ threadId: thread.threadId, user: { id: thread.user.id, profile: opts.profile() }, hide: opts.hide, code: turnCode });
  return (pi) => {
    const router = new TopicRouter();
    registerMemoryTools(pi, view, who, { readOnly: opts.memoryTools === "read", skill: opts.skills?.read });
    const saving = opts.memoryTools !== "read" && !!opts.skills?.propose;
    if (saving) registerSkillTool(pi, { propose: opts.skills!.propose! });
    registerVisionGuard(pi);
    if (opts.meter) registerContext(pi, opts.meter);
    if (opts.sleep) pi.registerCommand("sleep", { description: "Sleep now: consolidate, dream and wake, for this pool", handler: (_args, ctx) => opts.sleep!(ctx) });
    pi.on("context_with_system", event => {
      const messages = dropAskNudges(event.messages);
      const recentWork = opts.recentWork?.();
      if (recentWork) return { messages: [...messages, { role: "system" as const, content: `Selected recent work for this turn:\n\n${recentWork}`, timestamp: Date.now() }] };
      // Leave Pi's request alone unless an earlier turn's nudge was removed.
      return messages.length !== event.messages.length ? { messages } : undefined;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const code = turnCode = opts.code?.() ?? false;
      const fullPersona = opts.persona();
      const persona = code ? { core: fullPersona.core.filter(f => /(^|\/)SOUL\.md$/.test(f.path)), topics: [] } : fullPersona;
      const topics = code ? [] : router.route([...persona.topics, SELF_PRIMER], event.prompt);
      setToolsOff(pi, ctx, "code", code ? CODE_TOOLS_OFF : []);
      const memory = await memorySections(view, event.prompt, { ...who(), folders: opts.folders?.() ?? [], projectThreads: opts.projectThreads, name: opts.name?.() });
      // An unlogged thread isn't offered remember at all.
      if (opts.memoryTools !== "read") setToolsOff(pi, ctx, "unlogged", memory.notice ? ["remember", ...(saving ? ["save_skill"] : [])] : []);
      const { customPrompt, sections, turn, report } = assemble(
        { persona, topics, memory, profile: opts.profile(), now: opts.now?.() ?? new Date() },
        opts.budgets,
      );

      // Edit Pi's prompt options rather than replacing the prompt: Pi keeps the
      // prefix stable and appends only what changed, so it stays cacheable.
      const options = event.systemPromptOptions;
      options.selectedTools = pi.getActiveTools();
      const tools = toolGuidance(options, [...CONTINUATION_GUIDELINES, ...WORK_GUIDELINES, CODING_GUIDELINE, ...(code ? [CODE_GUIDELINES] : [])]);
      options.customPrompt = customPrompt;
      options.sections = { ...(tools ? { tools } : {}), ...options.sections, ...sections };
      if (code) {
        options.sections.code_task = codeTaskText(view.own.codeTask(thread.threadId));
        report.push({ name: "project", text: options.sections.code_task, budget: 1600, truncated: false, place: "system" });
        const rules = await opts.repoRules?.();
        if (rules) {
          options.sections.repo_rules = rules;
          report.push({ name: "project", text: rules, budget: RULES_IN_ALL, truncated: false, place: "system" });
        } else delete options.sections.repo_rules;
      } else { delete options.sections.code_task; delete options.sections.repo_rules; }
      const skills = await opts.skills?.index();
      if (skills) {
        options.sections.skills = skills;
        report.push({ name: "project", text: skills, budget: SKILLS_IN_ALL, truncated: false, place: "system" });
      } else delete options.sections.skills;

      // The user's reactions since her last turn, then her status line, from the last turn's measurement, and the line telling her to prepare or compact.
      const repositories = code ? await opts.codeRepositories?.() : undefined;
      if (repositories) report.push({ name: "recall", text: repositories, budget: repositories.length, truncated: false, place: "turn" });
      const told = [turn, repositories && `<repositories>\n${repositories}\n</repositories>`, reactionLines(opts.reactions?.() ?? [], thread.threadId, opts.profile().displayName)].filter(Boolean).join("\n\n");
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

/** Operational conduct for her own turns only, not persona policy or a runtime continuation loop. Subagents never get it. */
export const CONTINUATION_GUIDELINES = [
  "Do actionable work with the available tools before your final reply; a final reply ends your turn, it does not keep you working. If delegation fails but you can do the work directly, do it in this turn. After a missed promise, act in the current turn rather than making another final promise.",
  "Claim background work only after a tool successfully starts or queues it, and name the mechanism (such as the child thread or delegate run ID). Report queued as queued, not running; use the returned status, not your intention.",
  "If nothing has successfully started or been queued to continue, state the stopping point or blocker and that you are idle; do not imply you will keep working after the final reply.",
  "Create recurring routines only when the user asks for recurring work; never add an unsolicited routine to make a continuation promise true.",
];

/** How to spend tokens on tool work, hers and her subagents': each reply resends the whole context. */
export const WORK_GUIDELINES = [
  "Make independent tool calls together in one reply (several reads, searches or checks at once), not one per reply: every reply resends your whole context.",
  "A file you've read stays in your context; read it again only after it changes. In a large file read the part you need, and send long command output to a file, then read what matters.",
];

/**
 * A custom prompt replaces Pi's default tool list and rules, so they are
 * rebuilt here from the tools' own snippets and guidelines, after any `rules` given.
 */
export function toolGuidance(o: BuildSystemPromptOptions, rules: readonly string[] = []): string {
  const tools = (o.selectedTools ?? []).filter((t) => !(o.hiddenTools ?? []).includes(t));
  const snippets = tools.filter((t) => o.toolSnippets?.[t]).map((t) => `- ${t}: ${o.toolSnippets![t]}`);
  const lines = [...new Set([...rules, ...tools.flatMap((t) => o.toolGuidelines?.[t] ?? []), ...(o.promptGuidelines ?? [])])]
    .map((r) => r.trim()).filter(Boolean).map((r) => `- ${r}`);
  return [snippets.join("\n"), lines.length ? `Guidelines:\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n");
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
export * from "./openrouter.ts";
export * from "./session.ts";
export * from "./delegate/index.ts";

export * from "./turn-tools.ts";
