import { PersonaStore, Workspace, type Keyring, type User, type Users } from "@lyrica/core";
import { createLyricaExtension, createWorkspaceExtension } from "@lyrica/extension";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * The extensions `lyrica dev` loads into Pi: Lyrica herself and her routed
 * tools, for one development thread. The thread keeps its folder in the home
 * workspace between runs, and gets every general folder the user may grant,
 * read-write.
 */
export async function benchExtensions(keyring: Keyring, users: Users, user: User, opts: { debugPrompt?: boolean } = {}) {
  const persona = new PersonaStore(keyring.self());
  const thread = { userId: user.id, pool: "general" as const, threadId: "cli-dev" };
  const workspace = new Workspace(keyring, users);
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
      view: { pool: "general" }, // the Memory thread replaces this with openThreadView
      call: { userId: user.id, pool: "general", localOnly: false },
    },
    { persona: () => persona.read(), profile: () => users.get(user.id)!.profile, folders: tools.folders, debugPrompt: opts.debugPrompt },
  );
  const factories: { name: string; factory: ExtensionFactory }[] = [
    { name: "lyrica", factory: lyrica },
    { name: "lyrica-workspace", factory: createWorkspaceExtension(tools) },
  ];
  return { factories, close: () => workspace.unmountHome(user.id) };
}
