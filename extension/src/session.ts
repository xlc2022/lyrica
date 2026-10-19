import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Models, Resolution, Task } from "@lyrica/core";
import { keepRecentFor, reserveFor } from "./context.ts";
import type { ThreadContext } from "./index.ts";
import { modelRuntimeFor, piModelFor, prepareTurn } from "./models.ts";
import { createTurnToolsExtension } from "./turn-tools.ts";
import { recordEntries } from "./record.ts";

type Settings = Parameters<typeof SettingsManager.inMemory>[0];

export interface ThreadSessionOptions {
  thread: ThreadContext;
  models: Models;
  /** Working directory for Pi. Nothing is discovered from it. */
  cwd: string;
  /** Lyrica herself (createLyricaExtension) or a subagent's worker, plus tools such as the workspace's. */
  extensions: ExtensionFactory[];
  settings?: Settings;
  task?: () => Task;
}

/**
 * A Pi session for one thread, in process: the thread's stored entries, the
 * given extensions, Pi's built-in tools off, and a model runtime from the
 * router, so the session can only reach the models its CallContext allows.
 * User entries are recorded before the model runs; other entries as turns end.
 */
export interface ThreadSession {
  session: AgentSession;
  runtime: ModelRuntime;
  /** The chat model it opened with. */
  chat: { offeringId: string };
  /** Before each turn: the chat model again, with fallbacks and the thinking level, recorded as a call. */
  prepare(opts?: { thinking?: boolean; retry?: boolean }): Promise<Resolution>;
  dispose(): void;
}

export async function openThreadSession(o: ThreadSessionOptions): Promise<ThreadSession> {
  const { thread } = o;
  const runtime = await modelRuntimeFor(o.models, thread.call);
  // Any model will do to open with, even one whose machine is down: each turn picks again (prepare).
  const task = o.task?.() ?? "chat";
  const { ref: chat, model } = piModelFor(runtime, o.models, task, thread.call, o.models.resolve(task, thread.call, {}, { evenIfDown: true }));
  // Pi's compaction reserve and kept tail follow each model's window, and her two lines follow that edge (linesFor).
  const modelOverrides = Object.fromEntries(o.models.allowed(thread.call).flatMap(({ endpoint, offerings }) => offerings.flatMap((off) => {
    const w = runtime.getModel(endpoint.id, off.modelId)?.contextWindow;
    // A caller's own compaction settings win: per-model overrides would outrank them in Pi.
    const set = o.settings?.compaction;
    return w ? [[`${endpoint.id}/${off.modelId}`, {
      ...(set?.reserveTokens === undefined ? { reserveTokens: reserveFor(w) } : {}), ...(set?.keepRecentTokens === undefined ? { keepRecentTokens: keepRecentFor(w) } : {}),
    }] as const] : [];
  })));
  const settingsManager = SettingsManager.inMemory({ ...o.settings, compaction: { ...o.settings?.compaction, modelOverrides: { ...modelOverrides, ...o.settings?.compaction?.modelOverrides } } });
  const loader = new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, settingsManager,
    noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createTurnToolsExtension(), ...o.extensions],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: o.cwd, agentDir: o.cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model,
    sessionManager: SessionManager.inMemory(o.cwd, undefined, thread.view.own.loadEntries(thread.threadId) as never),
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const stop = recordEntries(session, thread.view.own, thread.threadId);
  // A reply that came back means its endpoint answered, so it isn't stale.
  const answered = session.subscribe((e) => {
    if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason !== "error" && session.model) o.models.reportUp(thread.user.id, session.model.provider);
  });
  const prepare = (opts: { thinking?: boolean; retry?: boolean } = {}) => prepareTurn({ session, runtime, models: o.models, call: o.models.callContext(thread.user.id, thread.pool, thread.threadId), pool: thread.pool, threadId: thread.threadId, task: o.task?.() ?? "chat", ...opts });
  return { session, runtime, chat, prepare, dispose: () => { stop(); answered(); session.dispose(); } };
}
