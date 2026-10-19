import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Keyring, Models, PRONOUN_PRESETS, Users, type CallContext, type Db, type Profile } from "../src/index.ts";
import { fakeOpenAI } from "./fake-openai.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Turns a migrated database back into one from before schema versions,
 * without the tables `schemas` create, so a test can build an older layout
 * in their place and migrate it.
 */
export function beforeVersions(db: Db, ...schemas: string[]): void {
  db.pragma("foreign_keys = OFF");
  for (const s of schemas) for (const [, table] of s.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec("DROP TABLE IF EXISTS meta; PRAGMA user_version = 0");
  db.pragma("foreign_keys = ON");
}

/** Cheap key derivation for tests: Argon2 for user keys, and one SQLCipher round for the self.db passphrase. */
export const ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
export const KDF_ITER = 1;

/** A fresh, unlocked keyring in a temp dir, with cheap key derivation. */
export async function freshKeyring(): Promise<Keyring> {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-"));
  dirs.push(dir);
  const keyring = new Keyring(dir, ARGON2, KDF_ITER);
  await keyring.initSelf("passphrase");
  return keyring;
}

export const profile = (displayName: string): Omit<Profile, "previousNames"> => ({ displayName, pronouns: PRONOUN_PRESETS.she });

/** Ada (administrator) with a cloud and a local endpoint of her own, each serving one model. */
export async function withModels() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const models = new Models(keyring, users);
  const cloud = await fakeOpenAI({ label: "cloud", models: [{ id: "deepseek/deepseek-4.1-flash", context_length: 128000, supported_parameters: ["tools", "temperature"] }] });
  const local = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b", meta: { n_ctx: 32768 } }] });
  const openrouter = models.addEndpoint(ada, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl, apiKey: "sk-test" });
  const gpu = models.addEndpoint(ada, { name: "gpu", kind: "local", baseUrl: local.baseUrl });
  const cloudRef = { offeringId: (await models.discover(ada, openrouter.id))[0]!.id };
  const localRef = { offeringId: (await models.discover(ada, gpu.id))[0]!.id };
  const ctx = (c: Partial<CallContext> = {}): CallContext => ({ userId: ada.id, pool: "general", localOnly: false, ...c });
  return { keyring, users, ada, models, cloud, local, openrouter, gpu, cloudRef, localRef, ctx };
}

