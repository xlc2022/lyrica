import type { OfferingInfo } from "./api.ts";

/** A model that answers in text: never an image recipe or model, a speech model or an embedding (as lyricad picks chat models, core/src/models). */
export const isChatModel = (m: Pick<OfferingInfo, "recipe" | "image" | "embedding" | "transcribe" | "speak">) => !m.recipe && !m.image && !m.embedding && !m.transcribe && !m.speak;

// Principle 1: copies with the same model ID still name the endpoint the user picks.
/** What to call a model: an image model (a host recipe, or a plan's image tool) by its name, anything else by its model ID. */
export const modelName = (m: { modelId: string; recipe?: string }) => m.recipe ?? m.modelId;

export function ModelLabel({ model, endpoint, raw = false }: { model: string; endpoint: string; raw?: boolean }) {
  return <span className="model-label">{raw ? <code className="model-name">{model}</code> : <span className="model-name">{model}</span>}<span className="model-endpoint muted" title={endpoint}> · {endpoint}</span></span>;
}
