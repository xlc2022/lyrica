import type { CallContext, Models, PoolView } from "@lyrica/core";
import { timedReply } from "./context.ts";
import { modelRuntimeFor, piModelFor } from "./models.ts";

// One-time backticks pass (2026-11-16; remove in the next PR once it has run, with PoolStore.backtickCandidates and
// addBackticks): her older notes get Markdown backticks around paths, commands and values, as the remember tool now
// asks (docs/memory.md, "Backticks in older notes"). Sleep's consolidate model does it, under the pool's rules, so a
// private note reaches only a local model. The store refuses any change but added backticks.

/** Notes per call. */
export const BACKTICK_BATCH = 20;

const SYSTEM = [
  "You add Markdown inline code to notes. Each line you are given is a note ID, a tab, then the note's text.",
  "Put backticks around file paths, commands, program and file names, settings, sysfs and environment names, and their values.",
  "Change nothing else: keep every letter, digit, space and mark as it is, including [bracketed IDs] and [[tokens]]. You may add a space beside a backtick where a word and a value ran together.",
  "Leave a note with nothing to mark out of your reply. Reply only with lines in the same form: the ID, a tab, the new text.",
].join(" ");

/** The reply's lines as ID → text, only for IDs that were asked about. */
export function parseBackticks(reply: string, asked: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of reply.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    if (asked.has(id)) out.set(id, line.slice(tab + 1).trimEnd());
  }
  return out;
}

/**
 * Asks the model for each batch of candidates and saves what the store accepts. A batch the model fails is left as
 * it was; the pass ends once every batch was asked. Throws when no batch was answered. Returns counts only.
 */
export async function addBackticks(models: Models, view: PoolView, call: CallContext, signal?: AbortSignal): Promise<{ checked: number; changed: number; refused: number }> {
  const notes = view.own.backtickCandidates();
  let changed = 0, refused = 0, answered = 0;
  if (!notes.length) return { checked: 0, changed, refused };
  const runtime = await modelRuntimeFor(models, call);
  for (let at = 0; at < notes.length; at += BACKTICK_BATCH) {
    signal?.throwIfAborted();
    const batch = notes.slice(at, at + BACKTICK_BATCH);
    // A note's text holds no newline the model could split on: lines are joined by a space for the prompt only.
    const flat = new Map(batch.map((n) => [n.id, n.text.replace(/\s*\n\s*/g, " ")]));
    const reply = await models.callWithFallback("sleep.consolidate", call, {}, async (resolution) => {
      const { model } = piModelFor(runtime, models, "sleep.consolidate", call, resolution);
      models.recordCall(call.userId, { pool: call.pool, threadId: "", task: "sleep.consolidate", resolution, note: "backticks" });
      const { reply: r } = await timedReply(runtime.streamSimple(model, {
        systemPrompt: SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: [...flat].map(([id, text]) => `${id}\t${text}`).join("\n") }], timestamp: Date.now() }],
      }, { signal }), model.contextWindow);
      if (r.stopReason === "error") throw new Error(r.errorMessage ?? "the model failed");
      return r;
    }).catch(() => undefined);
    if (!reply) continue;
    answered++;
    const text = reply.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    for (const [id, next] of parseBackticks(text, new Set(flat.keys()))) {
      const note = batch.find((n) => n.id === id)!;
      // A note that had line breaks is only changed when it had none to lose.
      if (note.text !== flat.get(id)) continue;
      try {
        view.own.addBackticks(id, next);
        if (next !== note.text) changed++;
      } catch {
        refused++;
      }
    }
  }
  // No model answered at all (its machine is away): not done, so the next unlock or sleep tries again.
  if (!answered) throw new Error("no model answered");
  return { checked: notes.length, changed, refused };
}
