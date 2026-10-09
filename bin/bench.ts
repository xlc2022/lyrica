import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Memory, Models, PersonaStore, TASKS, Workspace, type Keyring, type Pool, type User, type Users } from "@lyrica/core";
import { createDelegateExtension, createLyricaExtension, createWorkspaceExtension, Delegation, openThreadSession, syncEntries, type ThreadContext } from "@lyrica/extension";

export interface BenchOptions {
  pool?: Pool;
  /** For a general thread; a private one is always local-only. */
  localOnly?: boolean;
  debugPrompt?: boolean;
}

/**
 * What `lyrica dev` runs: a new thread for the user, with Lyrica, her routed
 * tools, delegate, and a model runtime from the router. The thread gets every folder the
 * user may grant in its pool, read-write. Headless, the same session drives tests
 * and evals.
 */
export async function openBench(keyring: Keyring, users: Users, user: User, opts: BenchOptions = {}) {
  const pool = opts.pool ?? "general";
  const persona = new PersonaStore(keyring.self());
  const models = new Models(keyring, users);
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  const refused = await workspace.selfTest();
  const memory = new Memory(keyring, users);
  const view = memory.openThreadView(user.id, pool);
  const thread = view.own.createThread({ interface: "cli", title: "lyrica dev" });
  if (opts.localOnly) models.setLocalOnly(user.id, pool, thread.id, true);
  const call = models.callContext(user.id, pool, thread.id);

  const settings = workspace.settings(user.id);
  settings.setThread(thread.id, pool, { grants: settings.allowed()[pool].map((path) => ({ path, writable: true })) });
  await workspace.mountHome(user.id);
  const tools = workspace.forThread({ userId: user.id, pool, threadId: thread.id });
  const ctx: ThreadContext = { user, pool, interface: "cli", threadId: thread.id, view, call };

  // The model and endpoint for each task, as the router resolves them for this thread.
  const report = [...(refused ? [`[lyrica] network is off for every thread: ${refused}`] : []), ...TASKS.map((task) => {
    try {
      const ref = models.resolveModel(task, call);
      const ep = models.endpoint(user.id, ref.endpointId)!;
      return `[lyrica] ${task}: ${ref.modelId} on ${ep.name} (${ep.kind})`;
    } catch (err) {
      return `[lyrica] ${task}: ${(err as Error).message}`;
    }
  })];

  const cwd = join(keyring.home, "bench");
  const delegation = new Delegation({ users, memory, models, workspace, cwd });
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await delegation.stopAll();
    view.close();
    await workspace.unmountHome(user.id);
  };
  // Pi's TUI exits the process on quit, so cleanup also runs on session_shutdown.
  const onShutdown: ExtensionFactory = (pi) => {
    pi.on("session_shutdown", async (_e, c) => {
      syncEntries(c.sessionManager, view.own, thread.id);
      await release();
    });
  };
  const opened = await openThreadSession({
    thread: ctx, models, cwd,
    extensions: [
      createLyricaExtension(ctx, { persona: () => persona.read(), profile: () => users.get(user.id)!.profile, folders: tools.folders, debugPrompt: opts.debugPrompt }),
      createWorkspaceExtension(tools),
      createDelegateExtension(ctx, delegation),
      onShutdown,
    ],
  });
  return { ...opened, threadId: thread.id, call, report, delegation, close: async () => { opened.dispose(); await release(); } };
}
