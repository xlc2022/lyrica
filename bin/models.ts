import { checkTask, Models, refId, TASKS, type Entry, type Keyring, type ModelRef, type Offering, type User, type Users } from "@lyrica/core";

export const MODELS_USAGE = `  lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
  lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
  lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
  lyrica admin models profile show --user <login>
  lyrica admin models profile set local|cloud|custom <task> <endpoint>/<model>[,<endpoint>/<model>…]|same:<task>|none --user <login>
  lyrica admin models profile default cloud|custom --user <login>`;

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
  const label = (name: string) => (shared && !name.startsWith("shared.") ? `shared.${name}` : name);
  const id = (name: string) => {
    const ep = models.findEndpoint(actor.id, label(name));
    if (!ep) throw new Error(`no endpoint ${label(name)}`);
    return ep.id;
  };

  try {
    if (what === "endpoints" && action === "add" && rest.length === 3) {
      const [name, kind, baseUrl] = rest as [string, string, string];
      if (kind !== "cloud" && kind !== "local") throw usage;
      const apiKey = await ask("API key (empty for none): ", true);
      const ep = models.addEndpoint(actor, { name, kind, baseUrl, apiKey }, { shared });
      console.log(`Added ${label(ep.name)} (${ep.kind}).`);
      const { warning } = await models.probe(actor.id, ep.id);
      if (warning) console.log(`Warning: ${warning}.`);
      await discover(models, actor, ep.id);
    } else if (what === "endpoints" && action === "list" && rest.length === 0) {
      for (const ep of models.endpoints(actor.id).filter((e) => !shared || e.shared)) {
        console.log(`${ep.shared ? "shared." : ""}${ep.name}: ${ep.kind}, ${ep.baseUrl}${ep.apiKey ? ", with a key" : ""}${ep.unencrypted ? ", unencrypted" : ""}${ep.stale ? ", stale" : ""}`);
        for (const m of models.offerings(actor.id, ep.id)) console.log(`  ${describe(m)}`);
      }
    } else if (what === "endpoints" && action === "remove" && rest.length === 1) {
      models.removeEndpoint(actor, id(rest[0]!));
      console.log(`Removed ${label(rest[0]!)}.`);
    } else if (what === "endpoints" && action === "probe" && rest.length === 1) {
      const { state, warning } = await models.probe(actor.id, id(rest[0]!));
      console.log(`${label(rest[0]!)} is ${state}.`);
      if (warning) console.log(`Warning: ${warning}.`);
      if (state === "up") await discover(models, actor, id(rest[0]!));
    } else if (what === "endpoints" && action === "model" && rest.length === 2) {
      const contextWindow = context === undefined ? undefined : Number(context);
      if (contextWindow !== undefined && !(contextWindow > 0)) throw new Error("--context takes a number of tokens");
      models.addModel(actor, id(rest[0]!), { modelId: rest[1]!, contextWindow, tools: tools || undefined });
      console.log(`Recorded ${label(rest[0]!)}/${rest[1]}.`);
    } else if (what === "profile" && action === "show" && !shared) {
      const name = (r: ModelRef) => models.label(actor.id, refId(r)) ?? "(a model that no longer exists)";
      for (const p of ["local", "cloud", "custom"] as const) {
        const profile = models.profile(actor.id, p);
        console.log(`${p}${p !== "local" && models.defaultProfile(actor.id) === p ? " (general threads use it)" : ""}:`);
        for (const task of TASKS) {
          const e = profile[task];
          console.log(`  ${task}: ${!e ? "(the chat list)" : Array.isArray(e) ? e.map(name).join(", ") : `same as ${e.same}`}`);
        }
      }
    } else if (what === "profile" && action === "set" && !shared && rest.length === 3) {
      const [p, task, value] = rest as [string, string, string];
      if (p !== "cloud" && p !== "local" && p !== "custom") throw usage;
      let entry: Entry | undefined;
      if (value.startsWith("same:")) entry = { same: checkTask(value.slice(5)) };
      else if (value !== "none") {
        entry = value.split(",").map((v) => {
          const found = models.find(actor.id, v.trim());
          if (!found) throw new Error(`no model ${v}; name it as <endpoint>/<model>`);
          return found;
        });
      }
      models.setProfile(actor.id, p, checkTask(task), entry);
      console.log(`${p} ${task}: ${value}.`);
    } else if (what === "profile" && action === "default" && !shared && rest.length === 1) {
      if (rest[0] !== "cloud" && rest[0] !== "custom") throw usage;
      models.setDefaultProfile(actor.id, rest[0]);
      console.log(`General threads use the ${rest[0]} profile.`);
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
    const n = found.filter((m) => m.status === "listed").length;
    console.log(`It lists ${n} model${n === 1 ? "" : "s"}.`);
  } catch (err) {
    console.log(`Couldn't list its models (${(err as Error).message}). Add them with "endpoints model".`);
  }
}

function describe(m: Offering): string {
  const facts = [m.contextWindow ? `${m.contextWindow} tokens` : "", m.tools === undefined ? "" : m.tools ? "tools" : "no tools", m.manual ? "by hand" : "", m.status === "listed" ? "" : m.status];
  return [m.modelId, facts.filter(Boolean).join(", ")].filter(Boolean).join(": ");
}
