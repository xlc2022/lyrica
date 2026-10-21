// Sampling: the settings saved per offering and sent with every
// call to it. Unset values are never sent, so the server's own default applies.

/** The context window a model is taken to have when nothing says what it is: what current models offer at least. */
export const DEFAULT_CONTEXT = 131_072;

/** The longest reply a model is asked for: the smaller of 131,072 tokens and a quarter of its context window (DEFAULT_CONTEXT when that isn't known). A saved maximum above it is clamped. */
export const replyCap = (contextWindow?: number) => Math.min(131_072, Math.floor((contextWindow || DEFAULT_CONTEXT) / 4));

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
  /** A speech model's voice for each language, by language tag: { en: "af_heart", zh: "zf_xiaobei" }. */
  voices?: Record<string, string>;
  /** A speech model's speed, 0.25 to 4. */
  speed?: number;
}

/** Where a value comes from: the shared offering's, or the user's own. Anything absent is the server's default. */
export type SettingSource = "shared" | "yours";

const RANGES: Record<Exclude<keyof AnswerSettings, "stop" | "voices">, [number, number, boolean]> = {
  temperature: [0, 5, false], topP: [0, 1, false], topK: [0, 1000, true], minP: [0, 1, false],
  repeatPenalty: [0, 5, false], presencePenalty: [-2, 2, false], frequencyPenalty: [-2, 2, false],
  maxTokens: [1, 1_000_000, true], seed: [0, 2 ** 31 - 1, true], speed: [0.25, 4, false],
};
export const ANSWER_SETTINGS = [...Object.keys(RANGES), "stop", "voices"] as (keyof AnswerSettings)[];

/** A change, checked: numbers in range, whole where they must be, up to four stop strings. null clears a value. */
export function checkSettings(change: Record<string, unknown>): { [K in keyof AnswerSettings]?: AnswerSettings[K] | null } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(change)) {
    if (!ANSWER_SETTINGS.includes(k as keyof AnswerSettings)) throw new Error(`${k} isn't a setting; the settings are ${ANSWER_SETTINGS.join(", ")}`);
    if (v === null || v === undefined) { out[k] = null; continue; }
    if (k === "stop") {
      if (!Array.isArray(v) || v.length > 4 || v.some((s) => typeof s !== "string" || !s || s.length > 100)) throw new Error("stop is up to four strings");
      out[k] = v.length ? v : null; // no strings is no setting
      continue;
    }
    if (k === "voices") {
      const entries = v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : undefined;
      if (!entries || entries.length > 8 || entries.some(([lang, id]) => !/^[a-zA-Z]{2,3}$/.test(lang) || typeof id !== "string" || !id || id.length > 100)) {
        throw new Error("voices maps up to eight language tags, such as en or zh, to a voice");
      }
      out[k] = entries.length ? Object.fromEntries(entries.map(([lang, id]) => [lang.toLowerCase(), id])) : null;
      continue;
    }
    const [min, max, whole] = RANGES[k as Exclude<keyof AnswerSettings, "stop" | "voices">];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) throw new Error(`${k} is ${whole ? "a whole number" : "a number"} from ${min} to ${max}`);
    out[k] = v;
  }
  return out as { [K in keyof AnswerSettings]?: AnswerSettings[K] | null };
}

/** What OpenAI's own API takes; it answers 400 to anything else. */
const OPENAI: readonly (keyof AnswerSettings)[] = ["temperature", "topP", "presencePenalty", "frequencyPenalty", "maxTokens", "seed", "stop", "voices", "speed"];

/**
 * The settings an endpoint's API accepts: everything for llama.cpp, vLLM,
 * model hosts and OpenRouter; OpenAI's set for any other cloud endpoint.
 */
export function acceptedSettings(ep: { kind: "cloud" | "local"; baseUrl: string }): readonly (keyof AnswerSettings)[] {
  if (ep.kind === "local" || /(^|\.)openrouter\.ai$/i.test(new URL(ep.baseUrl).hostname)) return ANSWER_SETTINGS;
  return OPENAI;
}

/**
 * The request fields for an OpenAI-compatible call. `repetition` names the
 * repeat penalty as the server knows it: llama.cpp's `repeat_penalty`, or
 * `repetition_penalty` for vLLM, OpenRouter and model hosts.
 */
export function payloadFields(all: AnswerSettings, repetition: "repeat_penalty" | "repetition_penalty", params: Record<string, unknown>, accepted: readonly (keyof AnswerSettings)[] = ANSWER_SETTINGS): Record<string, unknown> {
  const s = Object.fromEntries(Object.entries(all).filter(([k]) => accepted.includes(k as keyof AnswerSettings))) as AnswerSettings;
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
  if (s.maxTokens !== undefined) {
    // Never longer than the room Pi left for the reply in the context window.
    const field = "max_completion_tokens" in params ? "max_completion_tokens" : "max_tokens";
    const room = params[field];
    out[field] = typeof room === "number" ? Math.min(room, s.maxTokens) : s.maxTokens;
  }
  return out;
}
