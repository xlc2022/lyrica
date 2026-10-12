import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Keyring } from "./keyring.ts";
import { checkName, DEFAULT_NAME, PersonaStore, setSelfName } from "./persona.ts";
import type { Profile } from "./profile.ts";
import { Users, type User } from "./users.ts";

export interface BootstrapInput {
  /** The self.db passphrase. */
  passphrase: string;
  /** Her name, default Lyrica. */
  name?: string;
  /** The persona seed directory (`persona/` in the repository). */
  seed: string;
  admin: { login: string; password: string; profile: Omit<Profile, "previousNames"> };
}

/**
 * First run, in one step: self.db, the persona seed, her name and the first
 * administrator. `lyrica admin init` and `POST /api/setup` both call it.
 * If anything fails, self.db and the users' folder are removed, so the next
 * attempt starts clean. Leaves self.db open (unlocked) and the administrator's key in memory.
 */
export async function bootstrap(keyring: Keyring, input: BootstrapInput): Promise<User> {
  if (keyring.selfExists()) throw new Error("Lyrica is already set up");
  const name = checkName(input.name ?? DEFAULT_NAME);
  if (!input.passphrase) throw new Error("the passphrase must not be empty");
  const usersDir = join(keyring.home, "users");
  const hadUsers = existsSync(usersDir);
  try {
    await keyring.initSelf(input.passphrase);
    const self = keyring.self();
    new PersonaStore(self).importSeed(input.seed);
    setSelfName(self, name);
    const users = new Users(keyring);
    const { login, password, profile } = input.admin;
    const admin = await users.createUser(login, password, profile, { admin: true });
    await keyring.unlockUser(admin.id, password);
    return admin;
  } catch (err) {
    keyring.closeSelf();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(keyring.selfPath + suffix, { force: true });
    if (!hadUsers) rmSync(usersDir, { recursive: true, force: true });
    throw err;
  }
}
