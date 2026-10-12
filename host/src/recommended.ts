// What a model's publisher recommends for its context: the native length and
// the YaRN recipe, read from the repository's config.json and README.md
// through the fetch service, which saves neither (DESIGN, "Model settings").
import type { TextModel } from "./library.ts";

export type HubName = "huggingface" | "modelscope";

export interface Recommended {
  native: number | null;
  stretched?: number;
  factor?: number;
  originalContext?: number;
  source: { hub: HubName; repo: string; revision: string; at: string };
}

export type Recipe = Omit<Recommended, "source">;

/** A repository as a person or a GGUF names it: owner/name, modelscope:owner/name, or a hub link. */
export function parseRepo(v: string): { hub: HubName; repo: string } | null {
  const s = v.trim();
  const link = s.match(/^https?:\/\/(?:www\.)?(huggingface\.co|hf\.co|modelscope\.cn)\/(?:models\/)?([A-Za-z0-9][\w.-]*\/[\w.-]+?)(?:\/.*)?$/);
  if (link) return { hub: link[1] === "modelscope.cn" ? "modelscope" : "huggingface", repo: link[2]! };
  const plain = s.match(/^(?:(huggingface|modelscope):)?([A-Za-z0-9][\w.-]*\/[\w.-]+)$/);
  if (plain && !plain[2]!.includes("..")) return { hub: (plain[1] as HubName | undefined) ?? "huggingface", repo: plain[2]! };
  return null;
}

/** The repository a model found in the folder names: the GGUF's source, else its first base model. */
export function repoOf(model: TextModel): { hub: HubName; repo: string } | null {
  for (const v of [model.identity.sourceRepo, ...model.identity.baseModels.map((b) => b.repoUrl)]) {
    const r = v ? parseRepo(v) : null;
    if (r) return r;
  }
  return null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** A factor in the server's steps: whole for llama.cpp's rope-scale, hundredths for vLLM. */
function step(factor: number, server: TextModel["server"]): number {
  return server === "llamacpp" ? Math.max(1, Math.round(factor)) : Math.round(factor * 100) / 100;
}

/** The `{ … }` around a position in text, or null. */
function enclosing(text: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The recipe in a repository's config.json and README.md. The native length
 * is `max_position_embeddings` (or the original one when the publisher ships
 * YaRN on); the card's first YaRN block gives the factor and original
 * context, and its first `-c N … --yarn-orig-ctx M` line the stretched
 * length. Null when neither says anything.
 */
export function parseRecipe(config: any, readme: string | null, server: TextModel["server"]): Recipe | null {
  const text = config?.text_config ?? config ?? {};
  const shipped = [text.rope_parameters, text.rope_scaling].find((r) => r && (r.rope_type === "yarn" || r.type === "yarn"));
  let native = num(shipped?.original_max_position_embeddings) ?? num(text.max_position_embeddings) ?? null;
  let factor = num(shipped?.factor);
  let originalContext = num(shipped?.original_max_position_embeddings);
  let stretched = factor && originalContext ? Math.round(factor * originalContext) : undefined;

  if (readme) {
    // The card's YaRN block: often not whole JSON ("..." for the rest), so read the object around it.
    const blocks = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
    for (const b of blocks) {
      const m = b.match(/"(?:rope_)?type"\s*:\s*"yarn"/);
      const obj = m ? enclosing(b, m.index!) : null;
      if (!obj) continue;
      const f = Number(obj.match(/"factor"\s*:\s*([\d.]+)/)?.[1]);
      const o = Number(obj.match(/"original_max_position_embeddings"\s*:\s*(\d+)/)?.[1]);
      if (num(f)) factor = f;
      if (num(o)) originalContext = o;
      break;
    }
    // llama.cpp's command line: -c 1010000 … --yarn-orig-ctx 262144, maybe with --rope-scale 4.
    const line = readme.split("\n").find((l) => /(?:^|\s)(?:-c|--ctx-size)\s+\d+/.test(l) && /--yarn-orig-ctx\s+\d+/.test(l));
    if (line) {
      const n = Number(line.match(/(?:^|\s)(?:-c|--ctx-size)\s+(\d+)/)![1]);
      const o = Number(line.match(/--yarn-orig-ctx\s+(\d+)/)![1]);
      const f = num(Number(line.match(/--rope-scale\s+([\d.]+)/)?.[1]));
      stretched = n;
      originalContext ??= o;
      factor ??= f ?? n / o;
    } else if (factor && originalContext) {
      // vLLM's form: --max-model-len next to the YaRN override.
      const max = readme.match(/--max-model-len[\s=]+(\d+)/);
      stretched = max && Number(max[1]) > originalContext ? Number(max[1]) : Math.round(factor * originalContext);
    }
  }
  if (originalContext && (!native || native > originalContext)) native = originalContext;
  if (!native && !factor) return null;
  const recipe: Recipe = { native };
  if (factor && factor > 1 && originalContext) {
    recipe.factor = step(factor, server);
    recipe.originalContext = originalContext;
    recipe.stretched = stretched ?? Math.round(factor * originalContext);
  }
  return recipe;
}
