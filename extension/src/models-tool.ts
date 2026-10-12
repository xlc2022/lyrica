import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ServingEntry } from "@lyrica/core";
import { Type } from "typebox";

// The `models` tool (DESIGN.md, Model settings): she looks up a host model's
// recommended context on its card and proposes a serving change, which the
// copy's administrator or owner allows on a card. lyricad registers it only
// in general threads, for users who can manage a host: a lookup is an
// outside call, so private and local-only threads never have it.

/** A host copy she may look up and propose for. */
export interface HostCopy { offering: string; name: string; host: string }

/** What the person is asked on the card: numbers, which the card words. */
export interface ServingProposal {
  toolCallId: string;
  offering: string;
  name: string;
  contextLength: number;
  stretch: { factor: number; originalContext: number } | null;
  /** The KV cache at that context, by the host's estimate; null if unknown. */
  kvBytes: number | null;
  /** The card's factor and who documents it, when the proposed one is above it. */
  documented?: { factor: number; by: string };
}

export interface ModelsHost {
  /** The copies she may name: host models whose host the person can manage. Empty in a thread that has become private or local-only. */
  copies(): HostCopy[];
  serving(offering: string): Promise<ServingEntry>;
  lookup(offering: string, repo?: string): Promise<ServingEntry>;
  /** Shows the card; true when the person allowed it. */
  propose(p: ServingProposal): Promise<boolean>;
  /** Saves the settings whole, then reloads the model if it is loaded and idle; false when it applies at its next load. */
  apply(offering: string, settings: Record<string, unknown>, anyway: boolean): Promise<{ reloaded: boolean }>;
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
      description: "A model host's text models: `lookup` reads a model's recommended context and YaRN stretch from its card on Hugging Face or ModelScope, "
        + "with the host's KV cache estimate; `propose` asks the person, on a card, to serve it with a context length and stretch, and applies it if they allow it.",
      promptSnippet: "look up a host model's recommended context, or propose serving it with a longer one",
      promptGuidelines: [
        "Look a model up before proposing, and propose only what its card recommends unless the person asked for more; a stretch costs a little quality on short prompts.",
      ],
      // Reads the internet and, on Allow, changes the host. propose asks on its own card (OWN_CARD in workspace.ts).
      annotations: { openWorldHint: true, readOnlyHint: false },
      parameters: Type.Object({
        action: Type.Union([Type.Literal("lookup"), Type.Literal("propose")]),
        offering: Type.String({ description: "The model's offering ID on its host." }),
        repo: Type.Optional(Type.String({ description: "lookup: the repository to read, owner/name or modelscope:owner/name, when the host doesn't know it." })),
        contextLength: Type.Optional(Type.Integer({ description: "propose: the context length to serve, in tokens." })),
        stretch: Type.Optional(Type.Number({ description: "propose: the YaRN factor, 1 for none." })),
        originalContext: Type.Optional(Type.Integer({ description: "propose: the context the stretch starts from; the trained length if left out." })),
      }),
      async execute(id, p) {
        const copy = host.copies().find((c) => c.offering === p.offering);
        if (!copy) {
          const names = host.copies().map((c) => `${c.offering} (${c.name} on ${c.host})`).join(", ");
          return text(names ? `${p.offering} isn't a host model you can manage here. These are: ${names}.` : "There is no host model you can manage here.", true);
        }
        try {
          if (p.action === "lookup") return text(JSON.stringify(lookupResult(await host.lookup(p.offering, p.repo))));
          if (p.contextLength === undefined) return text("propose needs contextLength.", true);
          const entry = await host.serving(p.offering);
          const factor = p.stretch ?? 1;
          const stretch = factor > 1 ? { factor, originalContext: p.originalContext ?? entry.trainedContextLength ?? 0 } : null;
          const r = entry.recommended;
          const documented = stretch && r?.factor && stretch.factor > r.factor ? { factor: r.factor, by: r.source.repo.split("/")[0]! } : undefined;
          const allowed = await host.propose({
            toolCallId: id, offering: p.offering, name: copy.name, contextLength: p.contextLength, stretch,
            kvBytes: kvAt(entry, p.contextLength), ...(documented ? { documented } : {}),
          });
          if (!allowed) return text("Not allowed. Ask what to do instead.");
          const { stretch: _, ...rest } = entry.settings;
          const settings = { ...rest, contextLength: p.contextLength, ...(stretch ? { stretch: { type: "yarn", ...stretch } } : {}) };
          const { reloaded } = await host.apply(p.offering, settings, !!documented);
          return text(JSON.stringify({ applied: true, reloaded, contextLength: p.contextLength, stretch: stretch?.factor ?? 1 }));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    });
  };
}
