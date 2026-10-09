import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Keyring, Models, PRONOUN_PRESETS, Users, type CallContext, type Profile } from "../src/index.ts";
import { fakeOpenAI } from "./fake-openai.ts";

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

export const profile = (displayName: string): Omit<Profile, "previousNames"> => ({ displayName, pronouns: PRONOUN_PRESETS.she });

/** Li (administrator) with a cloud and a local endpoint of her own, each serving one model. */
export async function withModels() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Li"), { admin: true });
  await users.authenticate("li", "pw");
  const models = new Models(keyring, users);
  const cloud = await fakeOpenAI({ label: "cloud", models: [{ id: "deepseek/deepseek-4.1-flash", context_length: 128000, supported_parameters: ["tools", "temperature"] }] });
  const local = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b", meta: { n_ctx: 32768 } }] });
  models.addEndpoint(li, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl, apiKey: "sk-test" });
  models.addEndpoint(li, { name: "gpu", kind: "local", baseUrl: local.baseUrl });
  await models.discover(li, "openrouter");
  await models.discover(li, "gpu");
  const cloudRef = { endpointId: "openrouter", modelId: "deepseek/deepseek-4.1-flash" };
  const localRef = { endpointId: "gpu", modelId: "qwen3.8-27b" };
  const ctx = (c: Partial<CallContext> = {}): CallContext => ({ userId: li.id, pool: "general", localOnly: false, ...c });
  return { keyring, users, li, models, cloud, local, cloudRef, localRef, ctx };
}

