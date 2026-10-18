// Principle 1: copies with the same model ID still name the endpoint the user picks.
/** What to call a model: a host recipe by its name, anything else by its model ID. */
export const modelName = (m: { modelId: string; recipe?: string }) => m.recipe ?? m.modelId;

export function ModelLabel({ model, endpoint, raw = false }: { model: string; endpoint: string; raw?: boolean }) {
  return <span className="model-label">{raw ? <code className="model-name">{model}</code> : <span className="model-name">{model}</span>}<span className="model-endpoint muted" title={endpoint}> · {endpoint}</span></span>;
}
