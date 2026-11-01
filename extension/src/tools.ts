import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PoolView } from "@lyrica/core";
import { Type } from "typebox";
import { codeMemoryThread, formatHit, formatRead, keptFrom, nearCopy, sameText, search, type MemoryContext, queryVector } from "./memory.ts";
import { syncEntries } from "./record.ts";

// The Memory component's model-facing tools: remember, recall, read_memory.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** The recall tool's guidelines, in every thread's prompt. */
export const RECALL_GUIDELINES = [
  "Memories relevant to each message come up by themselves in <recall>. Use recall to look further before saying you don't remember.",
  "A memory marked \"added by\" a user is theirs: treat it as authoritative, and ask rather than contradict it.",
  "A memory that something doesn't work may be out of date: try it once before treating it as still broken, and correct the note if it works now.",
  "<recall> and WAKE are background: what the person asks in this conversation outranks what memory brings up. Answer what they said, and bring up other work or an earlier conversation only when their message is about it or they ask what's open. When they ask to drop a topic, agree in a few words that don't name it or anything from it, such as \"Sure, let's leave it there.\", and leave it, without reading memory about it, until they bring it back. A hit's date is when it was said or changed: don't guess a different one.",
];

/** With `readOnly` (subagents), only recall and read_memory. `skill` reads a library skill's body for s:<name>. */
export function registerMemoryTools(pi: ExtensionAPI, view: PoolView, ctx: () => Omit<MemoryContext, "folders">, opts: { readOnly?: boolean; skill?: (name: string) => string | undefined } = {}): void {
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
      "A note that something doesn't work (a tool, a token, an access) says what failed and why, so a later fix can be told apart.",
      "When the user states how they want code or work done, add working to the note’s about, and write it as a fact about them ({user} prefers small pull requests), not as an order: an order reads later as a command that outranks what they ask then.",
      "One fact per note. Save several notes in one remember call rather than one long note.",
      "In notes, write {user} for the person you're talking with, never their name, and {user:obj}, {user:poss}, {user:poss-pro}, {user:refl} for their pronouns. There is no subject pronoun form: write {user} where \"she\" or \"they\" would go.",
      "To correct a note, save the corrected fact with supersedes set to the old note's ID.",
      "Progress on work in flight (a pull request's CI, a review round) lives where the work is. Note what it settled: the outcome, a decision, or a lesson, with supersedes set to notes it makes out of date.",
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
      // A note word for word like a current one is that note: not saved again. One that only reads much the same may
      // change it ("spaces over tabs"), so it's saved, and she's shown the near match to set supersedes if it does.
      const copies: string[] = [];
      const similar: string[] = [];
      const fresh = params.notes.filter((n) => {
        if (n.supersedes?.length) return true;
        const near = view.own.search(n.text, { kinds: ["note"], current: true, limit: 5 })
          .map((h) => ({ id: h.id, text: view.own.get(h.id, { raw: true })?.text ?? "" })).filter((h) => nearCopy(n.text, h.text));
        const same = near.find((h) => sameText(n.text, h.text));
        if (same) copies.push(same.id);
        else if (near[0]) similar.push(near[0].id);
        return !same;
      });
      const ids = fresh.length ? view.own.addNotes(fresh.map((n) => ({ ...n, source })), { author: "lyrica", thread: threadId }) : [];
      const list = (xs: string[]) => [...new Set(xs)].map((id) => `[${id}]`).join(", ");
      return text([
        ids.length ? `Saved ${ids.join(", ")}.` : "",
        copies.length ? `Already noted, so not saved again: ${list(copies)}.` : "",
        similar.length ? `Similar to ${list(similar)}: if a new note changes one, save it again with supersedes set to it.` : "",
      ].filter(Boolean).join(" "));
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
      query: Type.String({ description: "What to look for: words, or a question. Matches by words and by meaning." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, _signal, _update, toolCtx) {
      const c = ctx();
      // Her own thread's entries that a compaction took out of context are found like any other conversation's.
      const keepBefore = toolCtx?.sessionManager ? keptFrom(view, toolCtx.sessionManager.getBranch(), c.threadId) : undefined;
      const vector = await queryVector(c, params.query);
      const hits = search(view, params.query, { limit: params.limit ?? 8, excludeThread: c.threadId, keepBefore, fromThread: c.code ? codeMemoryThread(view, c.threadId) : c.threadId, ...(c.code && !params.everywhere ? { only: { project: true, about: "working" } } : {}), ...(vector ? { vector } : {}) }, c.hide);
      return text(hits.length ? hits.map((h) => formatHit(h, c.user)).join("\n") : "Nothing found.");
    },
  });

  pi.registerTool({
    name: "read_memory",
    label: "Read memory",
    description: "Open a page or note by ID, a skill (s:…), or read the conversation around an entry (e:…) or the start of a thread (t:…); page reads the messages just before or after an entry.",
    promptSnippet: "open a memory, or a past conversation, by its ID",
    promptGuidelines: ["Use read_memory with an ID from a citation or a recall hit to see the whole memory, or what was said around it."],
    parameters: Type.Object({
      id: Type.String({ description: "For example p:homelab, n:20261009-a1b2c3d4 or e:web/3f7a2c#41." }),
      page: Type.Optional(StringEnum(["back", "on"] as const, { description: "With an entry (e:…): the nine messages just before it, or just after it." })),
    }),
    async execute(_id, params) {
      if (opts.skill && params.id.startsWith("s:")) return text(opts.skill(params.id.slice(2)) ?? `No skill ${params.id.slice(2)}.`);
      return text(formatRead(view, params.id, ctx(), params.page));
    },
  });
}
