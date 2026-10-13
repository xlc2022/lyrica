import { checkTask, Models, refId, TASKS, type Entry, type Keyring, type ModelRef, type Offering, type User, type Users } from "@lyrica/core";

export const MODELS_USAGE = `  lyrica admin models endpoints add <name> cloud|local <base-url> [--shared | --user <login>]
  lyrica admin models endpoints list|remove|probe [<name>] [--shared | --user <login>]
  lyrica admin models endpoints model <name> <model-id> [--context <tokens>] [--tools] [--shared | --user <login>]
  lyrica admin models preset list --user <login>
  lyrica admin models preset show <name> --user <login>
  lyrica admin models preset use private|general <name> --user <login>
  lyrica admin models preset set private|general <task> <endpoint>/<model>[,<endpoint>/<model>…]|same:<task>|none --user <login>
  lyrica admin models preset save private|general <name> --user <login>
  lyrica admin models preset add private|general <name> --user <login>
  lyrica admin models preset rename <name> <new-name> --user <login>
  lyrica admin models preset remove <name> --user <login>`;

type Ask = (question: string, hidden?: boolean) => Promise<string>;

/**
 * Endpoints and model presets. A user's own endpoints and presets live in
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
    } else if (what === "preset" && !shared) {
      const column = (c: string) => { if (c !== "private" && c !== "general") throw usage; return c; };
      const presetId = (name: string) => {
        const p = models.presets(actor.id).find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
        if (!p) throw new Error(`no preset ${name}`);
        return p.id;
      };
      const name = (r: ModelRef) => models.label(actor.id, refId(r)) ?? "(a model that no longer exists)";
      const taskLine = (task: (typeof TASKS)[number], e: Entry | undefined) => `${task}: ${!e ? "(the chat list)" : Array.isArray(e) ? e.map(name).join(", ") : `same as ${e.same}`}`;
      if (action === "list" && rest.length === 0) {
        const columns = { private: models.column(actor.id, "private").preset?.name ?? "Custom", general: models.column(actor.id, "general").preset?.name ?? "Custom" };
        for (const p of models.presets(actor.id)) {
          console.log(`${p.name} (${p.scope}${p.builtin ? `, built-in ${p.builtin}` : ""})${columns.private === p.name ? " · Private threads use it" : ""}${columns.general === p.name ? " · General threads use it" : ""}:`);
          for (const task of TASKS) console.log(`  ${taskLine(task, p.entries[task])}`);
        }
      } else if (action === "show" && rest.length === 1) {
        const p = models.preset(actor.id, presetId(rest[0]!));
        if (!p) throw new Error(`no preset ${rest[0]}`);
        console.log(`${p.name} (${p.scope}${p.builtin ? `, built-in ${p.builtin}` : ""}):`);
        for (const task of TASKS) console.log(`  ${taskLine(task, p.entries[task])}`);
      } else if (action === "use" && rest.length === 2) {
        const c = column(rest[0]!);
        const id = presetId(rest[1]!);
        models.useColumnPreset(actor.id, c, id);
        console.log(`${c === "private" ? "Private" : "General"} threads use the ${rest[1]} preset.`);
      } else if (action === "set" && rest.length === 3) {
        const c = column(rest[0]!);
        const [task, value] = rest.slice(1) as [string, string];
        let entry: Entry | undefined;
        if (value.startsWith("same:")) entry = { same: checkTask(value.slice(5)) };
        else if (value !== "none") {
          entry = value.split(",").map((v) => {
            const found = models.find(actor.id, v.trim());
            if (!found) throw new Error(`no model ${v}; name it as <endpoint>/<model>`);
            return found;
          });
        }
        models.setColumnTask(actor.id, c, checkTask(task), entry);
        console.log(`${c === "private" ? "Private" : "General"} ${task}: ${value}.`);
      } else if (action === "save" && rest.length === 2) {
        const c = column(rest[0]!);
        models.savePreset(actor.id, presetId(rest[1]!), c);
        console.log(`${rest[1]} now holds the ${c} column.`);
      } else if (action === "add" && rest.length === 2) {
        const c = column(rest[0]!);
        const p = models.addPreset(actor.id, { name: rest[1]!, scope: c === "private" ? "private" : "general" }, c);
        console.log(`Added ${p.name} (${p.scope}) from the ${c} column.`);
      } else if (action === "rename" && rest.length === 2) {
        const p = models.editPreset(actor.id, presetId(rest[0]!), { name: rest[1]! });
        console.log(`Renamed to ${p.name}.`);
      } else if (action === "remove" && rest.length === 1) {
        models.removePreset(actor.id, presetId(rest[0]!));
        console.log(`Removed ${rest[0]}.`);
      } else {
        throw usage;
      }
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
