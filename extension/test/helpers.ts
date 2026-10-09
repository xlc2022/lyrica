import { Memory, PRONOUN_PRESETS, Users, type Pool } from "@lyrica/core";
import { freshKeyring } from "../../core/test/helpers.ts";

/** An unlocked user "li" (she/her) with a Memory over their pools, in a temp dir. */
export async function withMemory() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const user = await users.createUser("li", "pw", { displayName: "Li", pronouns: PRONOUN_PRESETS.she }, { admin: true });
  await users.authenticate("li", "pw");
  const memory = new Memory(keyring, users);
  const thread = (pool: Pool = "general", opts: { unlogged?: boolean } = {}) => {
    const view = memory.openThreadView(user.id, pool);
    const t = view.own.createThread({ interface: "cli", unlogged: opts.unlogged });
    return {
      view, threadId: t.id,
      context: { user, pool, interface: "cli" as const, threadId: t.id, view, call: { userId: user.id, pool, localOnly: pool === "private" } },
    };
  };
  return { users, user, memory, thread };
}
