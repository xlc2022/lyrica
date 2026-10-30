// LoRAs asked for by name for one image or clip (docs/models.md, "LoRAs for one call"). A host recipe
// lists the LoRA files on its host that fit it (`takesLoras`); a name picks among them.

/** A LoRA asked for by name, at a strength (1 is full). */
export interface LoraAsk { name: string; strength: number }
/** A request names at most this many LoRAs, as a host takes (host/API.md, "LoRAs for one job"). */
export const MAX_LORAS = 4;

const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const stem = (file: string) => (file.split("/").pop() ?? file).replace(/\.(safetensors|gguf)$/i, "");
/** A LoRA's name as she reads it: its file name without the extension, separators as spaces ("pixel art v2"). */
export const loraName = (file: string) => stem(file).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
/** A Wan 2.2 LoRA comes as a pair, one file for each expert. */
const unpaired = (file: string) => flat(stem(file).replace(/(high|low)[_-]?noise/gi, ""));

/**
 * The files a name asks for among `files`, ignoring case, spaces and punctuation: the one whose name is
 * the name, or else the shortest whose name contains it; both of a high and low noise pair. None when nothing matches.
 */
export function matchLora(name: string, files: readonly string[]): string[] {
  const want = flat(name);
  if (!want) return [];
  const hits = files.filter((f) => flat(stem(f)).includes(want));
  if (!hits.length) return [];
  const best = hits.find((f) => flat(stem(f)) === want || unpaired(f) === want)
    ?? [...hits].sort((a, b) => stem(a).length - stem(b).length)[0]!;
  return hits.filter((f) => f === best || unpaired(f) === unpaired(best));
}

/** The files `asks` names among a model's LoRAs, each at its strength; the names it can't find. */
export function loraFiles(asks: readonly LoraAsk[], files: readonly string[]): { loras: { file: string; strength: number }[]; missing: string[] } {
  const loras: { file: string; strength: number }[] = [];
  const missing: string[] = [];
  for (const a of asks) {
    const found = matchLora(a.name, files);
    if (!found.length) missing.push(a.name);
    for (const file of found) if (!loras.some((l) => l.file === file)) loras.push({ file, strength: a.strength });
  }
  return { loras, missing };
}

export function validateLoras(asks: readonly LoraAsk[] | undefined): string | undefined {
  if (!asks) return undefined;
  if (asks.length > MAX_LORAS) return `at most ${MAX_LORAS} LoRAs`;
  if (asks.some((a) => !a.name.trim())) return "a LoRA needs a name";
  if (asks.some((a) => !(Number.isFinite(a.strength) && a.strength >= -4 && a.strength <= 4))) return "a LoRA's strength is -4 to 4";
  return undefined;
}
