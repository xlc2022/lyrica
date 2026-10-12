// The text library's pure parts (src/TextModels.tsx), kept apart so a test can check them without a page.
import type { LibraryEntry } from "./api.ts";

/** One copy of a model, as GET …/library/text gives it. */
export type LibraryCopy = LibraryEntry["copies"][number];

/**
 * The warn lines under a group's copies, one per way they differ that changes which copy answers. The library
 * gives no quantisation, so "Quantisations differ" has nothing to compare and is never said.
 */
export function groupWarnings(copies: Pick<LibraryCopy, "kind" | "capabilities">[]): string[] {
  const differ = (f: (c: Pick<LibraryCopy, "kind" | "capabilities">) => unknown) => new Set(copies.map((c) => JSON.stringify(f(c) ?? null))).size > 1;
  const lines: string[] = [];
  if (differ((c) => c.kind)) lines.push("Mixes local and cloud: Local and Cloud profiles use only the matching copies, Custom uses all of them.");
  if (differ((c) => c.capabilities.contextWindow)) lines.push("Context windows differ: long conversations skip the smaller copies.");
  if (differ((c) => !!c.capabilities.vision)) lines.push("Only some copies can see images: calls with images skip the others.");
  return lines;
}
