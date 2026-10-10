import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Models, Resolution } from "@lyrica/core";
import type { ThreadContext } from "./index.ts";
import { modelRuntimeFor, piModelFor, prepareTurn } from "./models.ts";
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
}

/**
 * A Pi session for one thread, in process: the thread's stored entries, the
 * given extensions, Pi's built-in tools off, and a model runtime from the
 * router, so the session can only reach the models its CallContext allows.
 * Entries are recorded into the thread as turns end.
 */
export interface ThreadSession {
  session: AgentSession;
  runtime: ModelRuntime;
  /** The chat model it opened with. */
  chat: { offeringId: string };
  /** Before each turn: the chat model again, with fallbacks and the thinking level, recorded as a call. */
  prepare(opts?: { thinking?: boolean }): Promise<Resolution>;
  dispose(): void;
}

export async function openThreadSession(o: ThreadSessionOptions): Promise<ThreadSession> {
  const { thread } = o;
  const runtime = await modelRuntimeFor(o.models, thread.call);
  const { ref: chat, model } = piModelFor(runtime, o.models, "chat", thread.call);
  const settingsManager = SettingsManager.inMemory(o.settings);
  const loader = new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, settingsManager,
    noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: o.extensions,
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
  const prepare = (opts: { thinking?: boolean } = {}) => prepareTurn({ session, runtime, models: o.models, call: o.models.callContext(thread.user.id, thread.pool, thread.threadId), pool: thread.pool, threadId: thread.threadId, ...opts });
  return { session, runtime, chat, prepare, dispose: () => { stop(); answered(); session.dispose(); } };
}
