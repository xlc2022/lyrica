import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Keyring } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A fresh, unlocked keyring in a temp dir, with cheap Argon2 settings. */
export async function freshKeyring(): Promise<Keyring> {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-"));
  dirs.push(dir);
  const keyring = new Keyring(dir, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
  await keyring.initSelf("passphrase");
  return keyring;
}
