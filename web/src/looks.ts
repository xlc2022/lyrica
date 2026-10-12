// A look at a project's threads, as the chat shows it. Pure, so it can be tested without a browser.
import type { Message, Pool, ThreadRef } from "./api.ts";

/** What a look at the project's threads led to: the threads told, and the line sent to them. */
export interface Told { threads: ThreadRef[]; text: string }

/**
 * Pairs each look (`from.kind === "watching"`) with what it told. A look made by one model call says so itself
 * (`from.told`); her next turn after it is her own. An older look was a turn: the marker names the threads she told in
 * the turn after it, and that turn's `threads message` cards fold into it rather than showing twice.
 */
export function foldLooks(messages: Message[], pool: Pool): { told: Map<string, Told[]>; folded: Set<string> } {
  const told = new Map<string, Told[]>();
  const folded = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role !== "user" || m.from?.kind !== "watching") return;
    if (m.from.told) return void told.set(m.id, m.from.told.map((t) => ({ threads: [{ pool, id: t.threadId }], text: t.text })));
    const next = messages.slice(i + 1).find((x) => x.role === "assistant" || (x.role === "user" && x.from?.kind !== "parent"));
    if (next?.role !== "assistant") return void told.set(m.id, []);
    const sent = next.parts.flatMap((p) => p.type === "tool" && p.name === "threads" && !p.isError && (p.args as { action?: string } | null)?.action === "message" && !(p.args as { to?: string }).to
      ? [{ threads: p.threads ?? [], text: (p.args as { text?: string }).text ?? "" }] : []);
    told.set(m.id, sent);
    if (sent.length) folded.add(next.id);
  });
  return { told, folded };
}

/** The `Told [t:<id>]: "<line>"` lines of a look's text, for a live look that has no `told` of its own. */
export function toldIn(text: string, pool: Pool): Told[] {
  return [...text.matchAll(/^Told \[t:([^\]\s]+)\]: (".*")$/gm)].flatMap((m) => {
    try { return [{ threads: [{ pool, id: m[1]! }], text: JSON.parse(m[2]!) as string }]; } catch { return []; }
  });
}

/** The line a look raised with the person (`Raised: "<line>"`), if it raised one. */
export function raisedIn(text: string): string | undefined {
  const line = /^Raised: (".*")$/m.exec(text)?.[1];
  try { return line ? (JSON.parse(line) as string) : undefined; } catch { return undefined; }
}
