import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ServingEntry } from "@lyrica/core";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// The `models` tool (DESIGN.md, Model settings): she looks up a host model's
// recommended context on its card and proposes a serving change, which the
// copy's administrator or owner allows on a card. A context at or under what
// the thread's own model is served with limits this thread alone, with no
// card (docs/briefs/model-settings-by-asking.md). lyricad registers it only
// in general threads, for users who can manage a host or a local endpoint: a
// lookup is an outside call, so private and local-only threads never have it.

/** A host copy she may look up and propose for. */
export interface HostCopy { offering: string; name: string; host: string }

/** What the person is asked on the card: numbers, which the card words. */
export interface ServingProposal {
  toolCallId: string;
  offering: string;
  name: string;
  /** The host or endpoint it is reloaded on, which every user of it shares. */
  host: string;
  contextLength: number;
  stretch: { factor: number; originalContext: number } | null;
  /** The KV cache at that context, by the host's estimate; null if unknown. */
  kvBytes: number | null;
  /** The card's factor and who documents it, when the proposed one is above it. */
  documented?: { factor: number; by: string };
  /** It reloads at once, not when idle (LM Studio), so replies in progress on it stop. */
  now?: boolean;
}

export interface ModelsHost {
  /** The copies she may name: host models whose host the person can manage. Empty in a thread that has become private or local-only. */
  copies(): HostCopy[];
  /** Models on a local endpoint the person can manage that LM Studio may reload with another context. */
  localCopies(): HostCopy[];
  /** The model this thread is talking to now, which `offering` defaults to. */
  current(): string | undefined;
  /** The context window a model is served with, for one not on a host. */
  window(offering: string): number | undefined;
  /** An LM Studio model's loaded context and its maximum; null when its server isn't LM Studio. */
  localContext(offering: string): Promise<{ served?: number; max?: number } | null>;
  /** Loads an LM Studio model again with this context, for everyone using it. */
  loadLocal(offering: string, contextLength: number): Promise<void>;
  /** This thread's own context limit; null for its model's whole window. */
  limit(tokens: number | null): void;
  serving(offering: string): Promise<ServingEntry>;
  lookup(offering: string, repo?: string): Promise<ServingEntry>;
  /** Shows the card; true when the person allowed it. */
  propose(p: ServingProposal): Promise<boolean>;
  /** Saves the settings whole, then reloads the model if it is loaded and idle; false when it applies at its next load. */
  apply(offering: string, settings: Record<string, unknown>, anyway: boolean): Promise<{ reloaded: boolean }>;
  /** Model hosts whose custom ComfyUI workflows she may read and change: those the person manages. Empty in a private or local-only thread. */
  workflowHosts(): { id: string; name: string }[];
  /** One of those hosts' workflow routes (host/API.md, "Custom workflows"), as the person. */
  workflowCall(host: string, method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<unknown>;
}

/** At most this many inputs change in one edit. */
const MAX_CHANGES = 50;
type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
type WorkflowInfo = { name: string; label: string; does: string[]; revision: number; recipes: { id: string; name: string }[]; workflow: Record<string, WorkflowNode>; problems: string[]; missingNodes: string[] | null; nodes: Record<string, Record<string, unknown>> | null };
const isLink = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";

/** A workflow as she reads it: each node's settings, links shown as the node they come from, a choice's options. */
export function workflowView(w: WorkflowInfo, revisions: unknown): Record<string, unknown> {
  return {
    workflow: w.name, name: w.label, does: w.does, revision: w.revision, recipes: w.recipes.map((r) => r.name), problems: w.problems, missingNodes: w.missingNodes, revisions,
    nodes: Object.entries(w.workflow).map(([id, n]) => {
      const options: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(w.nodes?.[n.class_type] ?? {})) if (Array.isArray(spec) && spec.length && typeof n.inputs[k] === "string") options[k] = spec.slice(0, 30);
      return {
        id, class: n.class_type,
        inputs: Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, isLink(v) ? `<- node ${(v as [string, number])[0]}` : v && typeof v === "object" ? "(picked by the host)" : v])),
        ...(Object.keys(options).length ? { options } : {}),
      };
    }),
  };
}

/** The workflow with these inputs changed: only settings a node already has, never its links. */
export function changeInputs(wf: Record<string, WorkflowNode>, changes: { node: string; input: string; value: unknown }[]): Record<string, WorkflowNode> {
  if (!changes.length || changes.length > MAX_CHANGES) throw new Error(`Give 1 to ${MAX_CHANGES} changes.`);
  const next = structuredClone(wf);
  for (const c of changes) {
    const n = next[c.node];
    if (!n) throw new Error(`The workflow has no node ${c.node}.`);
    if (!(c.input in n.inputs)) throw new Error(`Node ${c.node} (${n.class_type}) has no input ${c.input}.`);
    const was = n.inputs[c.input];
    if (isLink(was) || (was && typeof was === "object")) throw new Error(`Node ${c.node}'s ${c.input} is a link between nodes; only settings can change.`);
    if (!["string", "number", "boolean"].includes(typeof c.value)) throw new Error(`${c.node}.${c.input} must be a number, text or true/false.`);
    n.inputs[c.input] = c.value;
  }
  return next;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError: true } : {}) });

/** The KV cache at another context, scaled from the host's estimate at the served one. */
export function kvAt(entry: ServingEntry, context: number): number | null {
  return entry.kvBytes === null || !entry.contextLength ? null : Math.round((entry.kvBytes / entry.contextLength) * context);
}

/** The numbers she gets back from a lookup: never prose from the card. */
export function lookupResult(entry: ServingEntry): Record<string, unknown> {
  const r = entry.recommended;
  return {
    contextLength: entry.contextLength,
    maxContextLength: entry.maxContextLength,
    trainedContextLength: entry.trainedContextLength,
    stretch: entry.settings.stretch ?? null,
    kvBytes: entry.kvBytes,
    recommended: r ? { native: r.native, stretched: r.stretched ?? null, factor: r.factor ?? null, originalContext: r.originalContext ?? null, repo: r.source.repo, hub: r.source.hub } : null,
    kvBytesAtRecommended: r?.stretched ? kvAt(entry, r.stretched) : null,
    ...(entry.stretchUntested ? { stretchUntested: true } : {}),
  };
}

export function createModelsExtension(host: ModelsHost): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "models",
      label: "Models",
      description: "Text models' context, and custom ComfyUI workflows on model hosts the person manages. Context: `lookup` reads a host model's recommended context and YaRN stretch from its card on Hugging Face or ModelScope, "
        + "with the host's KV cache estimate; `propose` sets a context length. At or under what this thread's own model is served with, it limits this thread "
        + "and its children, with no card; above it, or for another model, it asks the person on a card to serve the model so for everyone, and applies it if they allow it. "
        + "Workflows: `workflows` lists them; `read_workflow` shows one's nodes and settings (a value like $prompt or $steps is a blank each job fills) and its revisions; "
        + "`edit_workflow` changes settings nodes already have, as a new revision the host checks; `restore_workflow` brings back an earlier revision.",
      promptSnippet: "look up a host model's recommended context, or propose serving it with a longer one",
      promptGuidelines: [
        "Look a model up before proposing, and propose only what its card recommends unless the person asked for more; a stretch costs a little quality on short prompts.",
        "Change a workflow only when the person asks for that change, read it first, and say what you changed and the revision to go back to.",
      ],
      // Reads the internet and, on Allow, changes the host. propose asks on its own card (OWN_CARD in workspace.ts).
      annotations: { openWorldHint: true, readOnlyHint: false },
      parameters: Type.Object({
        action: StringEnum(["lookup", "propose", "workflows", "read_workflow", "edit_workflow", "restore_workflow"] as const),
        host: Type.Optional(Type.String({ description: "Workflows: the model host's ID, from `workflows`." })),
        workflow: Type.Optional(Type.String({ description: "Workflows: the workflow's ID (custom-…), from `workflows`." })),
        changes: Type.Optional(Type.Array(Type.Object({
          node: Type.String(), input: Type.String(), value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
        }), { description: "edit_workflow: each node input to set; a value $name makes it a blank." })),
        revision: Type.Optional(Type.Integer({ description: "restore_workflow: the revision to bring back." })),
        offering: Type.Optional(Type.String({ description: "The model's offering ID; this thread's own model if left out." })),
        repo: Type.Optional(Type.String({ description: "lookup: the repository to read, owner/name or modelscope:owner/name, when the host doesn't know it." })),
        contextLength: Type.Optional(Type.Integer({ description: "propose: the context length to serve, in tokens." })),
        stretch: Type.Optional(Type.Number({ description: "propose: the YaRN factor, 1 for none." })),
        originalContext: Type.Optional(Type.Integer({ description: "propose: the context the stretch starts from; the trained length if left out." })),
      }),
      async execute(id, p) {
        if (["workflows", "read_workflow", "edit_workflow", "restore_workflow"].includes(p.action)) {
          try {
            return text(JSON.stringify(await workflowAction(host, p)));
          } catch (err) {
            return text((err as Error).message, true);
          }
        }
        const offering = p.offering ?? host.current();
        if (!offering) return text("This thread has no model yet; name an offering.", true);
        const copy = host.copies().find((c) => c.offering === offering);
        const local = copy ? undefined : host.localCopies().find((c) => c.offering === offering);
        const refuse = () => {
          const names = [...host.copies(), ...host.localCopies()].map((c) => `${c.offering} (${c.name} on ${c.host})`).join(", ");
          return text(names ? `${offering} isn't a model you can manage here. These are: ${names}.` : "There is no model you can manage here.", true);
        };
        try {
          if (p.action === "lookup") return copy ? text(JSON.stringify(lookupResult(await host.lookup(offering, p.repo)))) : refuse();
          if (p.contextLength === undefined) return text("propose needs contextLength.", true);
          const factor = p.stretch ?? 1;
          const entry = copy ? await host.serving(offering) : undefined;
          const lm = local ? await host.localContext(offering) : null;
          const served = entry?.contextLength ?? lm?.served ?? host.window(offering);
          const own = offering === host.current();
          // This thread's own model, not stretched: a size at or under what it's served with is this thread's alone.
          if (own && factor <= 1 && served && p.contextLength <= served) {
            host.limit(p.contextLength < served ? p.contextLength : null);
            return text(JSON.stringify({ applied: true, scope: "thread", contextLength: p.contextLength, served }));
          }
          if (lm) {
            if (factor > 1) return text("A stretch is for models on a model host.", true);
            if (lm.max && p.contextLength > lm.max) return text(`${local!.name} supports ${lm.max} tokens at most.`, true);
            const allowed = await host.propose({ toolCallId: id, offering, name: local!.name, host: local!.host, contextLength: p.contextLength, stretch: null, kvBytes: null, now: true });
            if (!allowed) return text("Not allowed. Ask what to do instead.");
            await host.loadLocal(offering, p.contextLength);
            if (own) host.limit(null);
            return text(JSON.stringify({ applied: true, scope: "everyone", reloaded: true, contextLength: p.contextLength }));
          }
          if (!copy || !entry) return local ? text(`${local.name}'s server isn't LM Studio, so its context can't be changed from here.`, true) : refuse();
          const stretch = factor > 1 ? { factor, originalContext: p.originalContext ?? entry.trainedContextLength ?? 0 } : null;
          const max = stretch ? (stretch.originalContext ? stretch.originalContext * factor : null) : entry.maxContextLength;
          if (max && p.contextLength > max) return text(`${copy.name} serves ${max} tokens at most${stretch ? ` with a stretch of ${factor}` : ""}.`, true);
          const r = entry.recommended;
          const documented = stretch && r?.factor && stretch.factor > r.factor ? { factor: r.factor, by: r.source.repo.split("/")[0]! } : undefined;
          const allowed = await host.propose({
            toolCallId: id, offering, name: copy.name, host: copy.host, contextLength: p.contextLength, stretch,
            kvBytes: kvAt(entry, p.contextLength), ...(documented ? { documented } : {}),
          });
          if (!allowed) return text("Not allowed. Ask what to do instead.");
          const { stretch: _, ...rest } = entry.settings;
          const settings = { ...rest, contextLength: p.contextLength, ...(stretch ? { stretch: { type: "yarn", ...stretch } } : {}) };
          const { reloaded } = await host.apply(offering, settings, !!documented);
          if (own) host.limit(null);
          return text(JSON.stringify({ applied: true, scope: "everyone", reloaded, contextLength: p.contextLength, stretch: stretch?.factor ?? 1 }));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    });
  };
}

/** The `models` tool's workflow actions: every change goes through the host's own checks and keeps the version it replaces. */
async function workflowAction(host: ModelsHost, p: { action: string; host?: string; workflow?: string; changes?: { node: string; input: string; value: unknown }[]; revision?: number }): Promise<unknown> {
  const hosts = host.workflowHosts();
  if (!hosts.length) throw new Error("There is no model host whose workflows you can manage here.");
  if (p.action === "workflows") {
    const all = await Promise.all(hosts.map(async (h) => {
      const list = ((await host.workflowCall(h.id, "GET", "/host/v1/workflows")) as { workflows?: { name: string; label: string; does: string[]; revision: number; recipes: { name: string }[] }[] }).workflows ?? [];
      return list.map((w) => ({ host: h.id, hostName: h.name, workflow: w.name, name: w.label, does: w.does, revision: w.revision, models: w.recipes.map((r) => r.name) }));
    }));
    return { workflows: all.flat() };
  }
  const h = hosts.find((x) => x.id === p.host);
  if (!h) throw new Error(`Name a host: ${hosts.map((x) => `${x.id} (${x.name})`).join(", ")}.`);
  if (!p.workflow || !/^custom-[0-9a-f]{8}$/.test(p.workflow)) throw new Error("Name a workflow by its ID from `workflows`.");
  const path = `/host/v1/workflows/${p.workflow}`;
  const revisions = async () => (((await host.workflowCall(h.id, "GET", `${path}/revisions`)) as { revisions?: unknown[] }).revisions ?? []).slice(0, 10);
  if (p.action === "read_workflow") return workflowView((await host.workflowCall(h.id, "GET", path)) as WorkflowInfo, await revisions());
  if (p.action === "restore_workflow") {
    if (!p.revision) throw new Error("restore_workflow needs revision.");
    const w = (await host.workflowCall(h.id, "POST", `${path}/revisions/${p.revision}/restore`, { by: "lyrica" })) as WorkflowInfo;
    return { restored: p.revision, revision: w.revision };
  }
  const current = (await host.workflowCall(h.id, "GET", path)) as WorkflowInfo;
  const next = changeInputs(current.workflow, p.changes ?? []);
  const w = (await host.workflowCall(h.id, "PUT", path, { workflow: next, by: "lyrica" })) as WorkflowInfo;
  return { saved: true, revision: w.revision, previous: current.revision, changed: (p.changes ?? []).length, missingNodes: w.missingNodes };
}
