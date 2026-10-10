// The text model library: one entry per model, holding its copies on every
// endpoint. What counts as the same model is DESIGN's rule: a copy is the
// same weights in another quantisation or format. Identity is base name,
// size and finetune, from a host's GGUF metadata, the hub's model card, or
// the model ID. Only `quantized` joins a copy to its base; a finetune, merge
// or adapter is a model of its own, linked to its base.

import type { ModelIdentity } from "./http.ts";
import { baseName } from "./identity.ts";

/** The facts about a copy that decide its entry. */
export interface CopyFacts { id: string; modelId: string; identity?: ModelIdentity; separate?: boolean }

/** Which entry a copy belongs to, its display name, its base if it is a derived model, and why it is flagged, if it is. */
export interface CopyIdentity { key: string; name: string; base?: { key: string; name: string }; flagged?: string }

const fileWords = (modelId: string) => baseName(modelId).split("-").filter(Boolean);
const nameOf = (basename: string, size?: string | null) => baseName([basename, size].filter(Boolean).join("-"));
/** Words that don't tell models apart: versions and the like. */
const NOISE = /^(v?\d+(\.\d+)*|it|chat|instruct|base|hf|model|gguf|ggml)$/;

export function copyIdentity(c: CopyFacts): CopyIdentity {
  const file = baseName(c.modelId);
  if (c.separate) return { key: `copy:${c.id}`, name: file };
  const card = c.identity?.card;
  const relation = card?.baseModelRelation ?? undefined;
  const cardBase = card?.baseModel?.[0];
  // The model card says what it is.
  if (cardBase && relation === "quantized") return { key: `name:${baseName(cardBase)}`, name: baseName(cardBase) };
  if (cardBase && relation) return { key: `name:${file}`, name: file, base: { key: `name:${baseName(cardBase)}`, name: baseName(cardBase) } };
  const id = c.identity;
  if (id?.basename) {
    const base = nameOf(id.basename, id.sizeLabel);
    if (id.finetune) {
      const name = baseName([id.basename, id.sizeLabel, id.finetune].filter(Boolean).join("-"));
      return { key: `name:${name}`, name, base: { key: `name:${base}`, name: base } };
    }
    // No finetune recorded, but the file name says more than the model's name: it may be a finetune. It stays apart, flagged.
    const extra = fileWords(c.modelId).filter((w) => !base.split("-").includes(w) && !NOISE.test(w));
    if (extra.length) return { key: `name:${file}`, name: file, base: { key: `name:${base}`, name: base }, flagged: `Its file name has words its model's name doesn't (${extra.join(", ")}). Check whether it's ${base} or a model of its own.` };
    return { key: `name:${base}`, name: base };
  }
  return { key: `name:${file}`, name: file };
}
