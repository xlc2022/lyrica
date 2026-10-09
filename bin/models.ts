import { checkTask, Models, parseRef, refString, TASKS, type Keyring, type User, type Users } from "@lyrica/core";

export const MODELS_USAGE = `  lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
  lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
  lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
  lyrica admin models profile show --user <login>
  lyrica admin models profile set cloud|local <task> <endpoint>/<model>|none --user <login>`;

type Ask = (question: string, hidden?: boolean) => Promise<string>;

/**
 * Endpoints and model profiles. A user's own endpoints and profiles live in
 * their user.db, so their password opens it; --shared signs in as an
 * administrator and changes the shared endpoints in self.db.
 */
export async function modelsAdmin(keyring: Keyring, users: Users, args: string[], ask: Ask): Promise<void> {
  const take = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const [value] = args.splice(i, 2).slice(1);
    if (!value) throw new Error(`${name} needs a value`);
    return value;
  };
  const has = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const shared = has("--shared");
  const tools = has("--tools");
  const context = take("--context");
  const login = take("--user");
  const [what, action, ...rest] = args;
  const usage = new Error(`usage:\n${MODELS_USAGE}`);
  if (!shared && !login) throw usage;

  let actor: User;
  if (shared) {
    const admin = await ask("Administrator login: ");
    actor = await users.authenticate(admin, await ask(`Password for ${admin}: `, true));
    if (!actor.admin) throw new Error(`${admin} is not an administrator`);
  } else {
    actor = await users.authenticate(login!, await ask(`Password for ${login} (to open their settings): `, true));
  }
  const models = new Models(keyring, users);
  const id = (name: string) => (shared && !name.startsWith("shared.") ? `shared.${name}` : name);

  try {
    if (what === "endpoints" && action === "add" && rest.length === 3) {
      const [name, kind, baseUrl] = rest as [string, string, string];
      if (kind !== "cloud" && kind !== "local") throw usage;
      const apiKey = await ask("API key (empty for none): ", true);
      const ep = models.addEndpoint(actor, { name, kind, baseUrl, apiKey }, { shared });
      console.log(`Added ${ep.id} (${ep.kind}).`);
      const { warning } = await models.probe(actor.id, ep.id);
      if (warning) console.log(`Warning: ${warning}.`);
      await discover(models, actor, ep.id);
    } else if (what === "endpoints" && action === "list" && rest.length === 0) {
      for (const ep of models.endpoints(actor.id).filter((e) => !shared || e.shared)) {
        console.log(`${ep.id}: ${ep.kind}, ${ep.baseUrl}${ep.apiKey ? ", with a key" : ""}`);
        for (const m of models.models(actor.id, ep.id)) console.log(`  ${describe(m)}`);
      }
    } else if (what === "endpoints" && action === "remove" && rest.length === 1) {
      models.removeEndpoint(actor, id(rest[0]!));
      console.log(`Removed ${id(rest[0]!)}.`);
    } else if (what === "endpoints" && action === "probe" && rest.length === 1) {
      const { state, warning } = await models.probe(actor.id, id(rest[0]!));
      console.log(`${id(rest[0]!)} is ${state}.`);
      if (warning) console.log(`Warning: ${warning}.`);
      if (state === "up") await discover(models, actor, id(rest[0]!));
    } else if (what === "endpoints" && action === "model" && rest.length === 2) {
      const contextWindow = context === undefined ? undefined : Number(context);
      if (contextWindow !== undefined && !(contextWindow > 0)) throw new Error("--context takes a number of tokens");
      models.addModel(actor, id(rest[0]!), { modelId: rest[1]!, contextWindow, tools: tools || undefined });
      console.log(`Recorded ${id(rest[0]!)}/${rest[1]}.`);
    } else if (what === "profile" && action === "show" && !shared) {
      for (const p of ["cloud", "local"] as const) {
        const profile = models.profile(actor.id, p);
        console.log(`${p}:`);
        for (const task of TASKS) console.log(`  ${task}: ${profile[task] ? refString(profile[task]) : "(the chat model)"}`);
      }
    } else if (what === "profile" && action === "set" && !shared && rest.length === 3) {
      const [p, task, ref] = rest as [string, string, string];
      if (p !== "cloud" && p !== "local") throw usage;
      models.setProfile(actor.id, p, checkTask(task), ref === "none" ? undefined : parseRef(ref));
      console.log(`${p} ${task}: ${ref}.`);
    } else {
      throw usage;
    }
  } finally {
    keyring.lockUser(actor.id);
  }
}

async function discover(models: Models, actor: User, endpointId: string): Promise<void> {
  try {
    const found = await models.discover(actor, endpointId);
    console.log(`${endpointId} lists ${found.length} model${found.length === 1 ? "" : "s"}.`);
  } catch (err) {
    console.log(`Couldn't list its models (${(err as Error).message}). Add them with "endpoints model".`);
  }
}

function describe(m: { modelId: string; contextWindow?: number; tools?: boolean; manual: boolean }): string {
  const facts = [m.contextWindow ? `${m.contextWindow} tokens` : "", m.tools === undefined ? "" : m.tools ? "tools" : "no tools", m.manual ? "by hand" : ""];
  return [m.modelId, facts.filter(Boolean).join(", ")].filter(Boolean).join(": ");
}
