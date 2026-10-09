import type { PoolView } from "@lyrica/core";

/** What memory contributes to the prompt. Every field is optional. */
export interface MemorySections {
  wake?: string;
  pageIndex?: string;
  recall?: string;
  lastTalk?: Date;
}

/** Stub: the Memory thread reads these from the view. Returns nothing for now. */
export async function memorySections(_view: PoolView, _prompt: string): Promise<MemorySections> {
  return {};
}
