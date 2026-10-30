import type { OfferingInfo } from "./api.ts";

/** A model that answers in text: never an image recipe or model, a speech model or an embedding (as lyricad picks chat models, core/src/models). */
export const isChatModel = (m: Pick<OfferingInfo, "recipe" | "image" | "embedding" | "transcribe" | "speak">) => !m.recipe && !m.image && !m.embedding && !m.transcribe && !m.speak;

// Principle 1: copies with the same model ID still name the endpoint the user picks.
/** What to call a model: an image model (a host recipe, or a plan's image tool) by its name, anything else by its model ID. */
export const modelName = (m: { modelId: string; recipe?: string }) => m.recipe ?? m.modelId;

/**
 * A model as a line shows it: a local model's ID is often its file's path, so only the file's name, without its
 * extension ("Qwen3.8-27B-UD-Q4_K_M"); the whole ID goes in a tooltip.
 */
export const shortModel = (id: string) => id.split("/").pop()!.replace(/\.(gguf|safetensors|bin)$/i, "") || id;

/** Whether every word of a search is in a model's name, ID, endpoint or kind. */
export const matchesModel = (q: string, m: { modelId: string; recipe?: string }, ep: { name: string; kind: string }) => {
  const hay = `${modelName(m)} ${m.modelId} ${ep.name} ${ep.kind}`.toLowerCase();
  return q.trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
};

/** `id` is the tooltip for a model shown by a name other than its ID (a recipe). */
export function ModelLabel({ model, endpoint, raw = false, id }: { model: string; endpoint: string; raw?: boolean; id?: string }) {
  const short = id ? model : shortModel(model);
  const title = id ?? (short === model ? undefined : model);
  return <span className="model-label">{raw ? <code className="model-name">{model}</code> : <span className="model-name" title={title}>{short}</span>}<span className="model-endpoint muted" title={endpoint}> · {endpoint}</span></span>;
}
