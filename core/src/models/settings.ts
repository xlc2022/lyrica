// "How it answers": sampling settings saved per offering and sent with every
// call to it. Unset values are never sent, so the server's own default applies.

/** Settings an offering answers with. */
export interface AnswerSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** The longest reply, in tokens. */
  maxTokens?: number;
  seed?: number;
  stop?: string[];
}

/** Where a value comes from: the server's own default (nothing saved), the shared offering's, or the user's own. */
export type SettingSource = "default" | "shared" | "yours";

const RANGES: Record<Exclude<keyof AnswerSettings, "stop">, [number, number, boolean]> = {
  temperature: [0, 5, false], topP: [0, 1, false], topK: [0, 1000, true], minP: [0, 1, false],
  repeatPenalty: [0, 5, false], presencePenalty: [-2, 2, false], frequencyPenalty: [-2, 2, false],
  maxTokens: [1, 1_000_000, true], seed: [0, 2 ** 31 - 1, true],
};
export const ANSWER_SETTINGS = [...Object.keys(RANGES), "stop"] as (keyof AnswerSettings)[];

/** A change, checked: numbers in range, whole where they must be, up to four stop strings. null clears a value. */
export function checkSettings(change: Record<string, unknown>): { [K in keyof AnswerSettings]?: AnswerSettings[K] | null } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(change)) {
    if (!ANSWER_SETTINGS.includes(k as keyof AnswerSettings)) throw new Error(`${k} isn't a setting; the settings are ${ANSWER_SETTINGS.join(", ")}`);
    if (v === null || v === undefined) { out[k] = null; continue; }
    if (k === "stop") {
      if (!Array.isArray(v) || v.length > 4 || v.some((s) => typeof s !== "string" || !s || s.length > 100)) throw new Error("stop is up to four strings");
      out[k] = v;
      continue;
    }
    const [min, max, whole] = RANGES[k as Exclude<keyof AnswerSettings, "stop">];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) throw new Error(`${k} is ${whole ? "a whole number" : "a number"} from ${min} to ${max}`);
    out[k] = v;
  }
  return out as { [K in keyof AnswerSettings]?: AnswerSettings[K] | null };
}

/**
 * The request fields for an OpenAI-compatible call. `repetition` names the
 * repeat penalty as the server knows it: llama.cpp's `repeat_penalty`, or
 * `repetition_penalty` for vLLM, OpenRouter and model hosts.
 */
export function payloadFields(s: AnswerSettings, repetition: "repeat_penalty" | "repetition_penalty", params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.temperature !== undefined) out.temperature = s.temperature;
  if (s.topP !== undefined) out.top_p = s.topP;
  if (s.topK !== undefined) out.top_k = s.topK;
  if (s.minP !== undefined) out.min_p = s.minP;
  if (s.repeatPenalty !== undefined) out[repetition] = s.repeatPenalty;
  if (s.presencePenalty !== undefined) out.presence_penalty = s.presencePenalty;
  if (s.frequencyPenalty !== undefined) out.frequency_penalty = s.frequencyPenalty;
  if (s.seed !== undefined) out.seed = s.seed;
  if (s.stop?.length) out.stop = s.stop;
  if (s.maxTokens !== undefined) out["max_completion_tokens" in params ? "max_completion_tokens" : "max_tokens"] = s.maxTokens;
  return out;
}
