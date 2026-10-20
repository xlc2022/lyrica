import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PoolView } from "@lyrica/core";
import { Type } from "typebox";
import { codeMemoryThread, formatHit, formatRead, search, type MemoryContext } from "./memory.ts";
import { syncEntries } from "./record.ts";

// The Memory component's model-facing tools: remember, recall, read_memory.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** The recall tool's guidelines, in every thread's prompt. */
export const RECALL_GUIDELINES = [
  "Memories relevant to each message come up by themselves in <recall>. Use recall to look further before saying you don't remember.",
  "A memory marked \"added by\" a user is theirs: treat it as authoritative, and ask rather than contradict it.",
  "<recall> and WAKE are background: what the person asks in this conversation outranks what memory brings up. Answer what they said, and bring up other work or an earlier conversation only when their message is about it or they ask what's open. When they ask to drop a topic, agree in a few words without naming it or anything from it, and leave it, without reading memory about it, until they bring it back. A hit's date is when it was said or changed: don't guess a different one.",
];

/** With `readOnly` (subagents), only recall and read_memory. */
export function registerMemoryTools(pi: ExtensionAPI, view: PoolView, ctx: () => Omit<MemoryContext, "folders">, opts: { readOnly?: boolean } = {}): void {
  if (!opts.readOnly) pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save notes to memory. Each note is one fact, event, preference or decision. " +
      "Write {user} for the person you're talking with, and {user:obj}, {user:poss}, {user:poss-pro} or {user:refl} for their pronouns.",
    promptSnippet: "save notes to memory, several at once",
    promptGuidelines: [
      "Save notes liberally with remember, without asking: when in doubt, note it. Notes are cheap, and sleep consolidates them.",
      "Credentials never go in memory.",
      "When the user states how they want code or work done, add working to the note’s about.",
      "One fact per note. Save several notes in one remember call rather than one long note.",
      "In notes, write {user} for the person you're talking with, never their name, and {user:obj}, {user:poss}, {user:poss-pro}, {user:refl} for their pronouns. There is no subject pronoun form: write {user} where \"she\" or \"they\" would go.",
      "To correct a note, save the corrected fact with supersedes set to the old note's ID.",
      "In notes, mention another conversation as [t:<id>] and a message in one as [e:<id>#<n>], never by its title: titles change, and the ID always shows the current one.",
    ],
    parameters: Type.Object({
      notes: Type.Array(Type.Object({
        text: Type.String({ description: "One fact, with {user} for the person you're talking with." }),
        about: Type.Optional(Type.Array(Type.String(), { description: "A few topic words." })),
        supersedes: Type.Optional(Type.Array(Type.String(), { description: "IDs of notes this one corrects." })),
      }), { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _update, toolCtx) {
      const { threadId } = ctx();
      // The message that led here is in Pi's session but may not be stored yet.
      syncEntries(toolCtx.sessionManager, view.own, threadId);
      const source = view.own.lastEntry(threadId, ["user", "toolResult"])?.id;
      const ids = view.own.addNotes(params.notes.map((n) => ({ ...n, source })), { author: "lyrica", thread: threadId });
      return text(`Saved ${ids.join(", ")}.`);
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Search memory: notes, pages and past conversations.",
    promptSnippet: "search memory beyond what came up automatically",
    promptGuidelines: RECALL_GUIDELINES,
    parameters: Type.Object({
      everywhere: Type.Optional(Type.Boolean({ description: "Search all memory for this call, including outside code mode’s project and working preferences." })),
      query: Type.String({ description: "Words to look for." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params) {
      const c = ctx();
      const hits = search(view, params.query, { limit: params.limit ?? 8, excludeThread: c.threadId, fromThread: c.code ? codeMemoryThread(view, c.threadId) : c.threadId, ...(c.code && !params.everywhere ? { only: { project: true, about: "working" } } : {}) }, c.hide);
      return text(hits.length ? hits.map((h) => formatHit(h, c.user)).join("\n") : "Nothing found.");
    },
  });

  pi.registerTool({
    name: "read_memory",
    label: "Read memory",
    description: "Open a page or note by ID, or read the conversation around an entry (e:…) or the start of a thread (t:…).",
    promptSnippet: "open a memory, or a past conversation, by its ID",
    promptGuidelines: ["Use read_memory with an ID from a citation or a recall hit to see the whole memory, or what was said around it."],
    parameters: Type.Object({ id: Type.String({ description: "For example p:homelab, n:20261009-a1b2c3d4 or e:web/3f7a2c#41." }) }),
    async execute(_id, params) {
      return text(formatRead(view, params.id, ctx()));
    },
  });
}
