import { Memory, PersonaStore, Workspace, type Keyring, type User, type Users } from "@lyrica/core";
import { createLyricaExtension, createWorkspaceExtension, entryRecorder } from "@lyrica/extension";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * The extensions `lyrica dev` loads into Pi: Lyrica herself, the recorder for
 * her memory, and her routed tools. Each run is a new general-pool thread, so
 * what she remembers carries over between runs. The thread gets every general
 * folder the user may grant, read-write.
 */
export async function benchExtensions(keyring: Keyring, users: Users, user: User, opts: { debugPrompt?: boolean } = {}) {
  const persona = new PersonaStore(keyring.self());
  const view = new Memory(keyring, users).openThreadView(user.id, "general");
  const thread = { userId: user.id, pool: "general" as const, threadId: view.own.createThread({ interface: "cli", title: "lyrica dev" }).id };
  const workspace = new Workspace(keyring, users, { excludePorts: [] });
  const refused = await workspace.selfTest();
  if (refused) process.stderr.write(`[lyrica] network is off for every thread: ${refused}\n`);
  const settings = workspace.settings(user.id);
  settings.setThread(thread.threadId, "general", { grants: settings.allowed().general.map((path) => ({ path, writable: true })) });
  await workspace.mountHome(user.id);
  const tools = workspace.forThread(thread);
  const lyrica = createLyricaExtension(
    {
      user,
      pool: "general",
      interface: "cli",
      threadId: thread.threadId,
      view,
      call: { userId: user.id, pool: "general", localOnly: false },
    },
    { persona: () => persona.read(), profile: () => users.get(user.id)!.profile, folders: tools.folders, debugPrompt: opts.debugPrompt },
  );
  const factories: { name: string; factory: ExtensionFactory }[] = [
    { name: "lyrica", factory: lyrica },
    { name: "lyrica-record", factory: entryRecorder(view.own, thread.threadId) },
    { name: "lyrica-workspace", factory: createWorkspaceExtension(tools) },
  ];
  return { factories, close: async () => { view.close(); await workspace.unmountHome(user.id); } };
}
