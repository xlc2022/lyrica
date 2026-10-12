import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { LYRICA_REACTS, type Reaction } from "@lyrica/core";
import { Type } from "typebox";
import type { ThreadContext } from "./index.ts";
import { syncEntries } from "./record.ts";

// Reactions (DESIGN.md, Threads): her `react` tool, and the lines that tell
// her of the user's reactions in her next turn.

export interface ReactHost {
  /** Message n's reactions changed, as stored (who by: user IDs or "lyrica"). */
  reacted(n: number, reactions: Reaction[]): void;
}

/** A user's reaction since her last turn, as lyricad keeps it for the turn message. */
export interface UserReaction { n: number; emoji: string; on: boolean; hers: boolean }

const ENTRY = /^e:(.+)#(\d+)$/;

/** The `react` tool: an emoji on a message, the one she is answering unless another is named. */
export function createReactExtension(thread: ThreadContext, host: ReactHost): ExtensionFactory {
  const store = thread.view.own;
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "react",
      label: "React",
      description: "Put an emoji on a message, like a reaction in a chat. Without `message`, the message you are answering.",
      promptSnippet: "react to a message with an emoji",
      promptGuidelines: [
        "React when a reaction says it better than words, or alongside them: a 🎉 for good news, a 👀 when you've seen something and will get to it. Not on every message.",
        "A line in <reactions> tells you when the person reacted to a message of yours or their own; take it as you would a nod or a laugh, and rarely mention it.",
      ],
      parameters: Type.Object({
        emoji: Type.String({ description: "One emoji." }),
        message: Type.Optional(Type.String({ description: "The message's ID, e:<thread>#<n>, for a message other than the one you are answering." })),
        remove: Type.Optional(Type.Boolean({ description: "Take your reaction off instead." })),
      }),
      async execute(_id, params, _signal, _update, toolCtx) {
        let n: number;
        if (params.message) {
          const m = ENTRY.exec(params.message.trim());
          if (!m || m[1] !== thread.threadId) return fail(`${params.message} isn't a message of this conversation.`);
          n = Number(m[2]);
        } else {
          // The message that led here is in Pi's session but may not be stored yet.
          syncEntries(toolCtx.sessionManager, store, thread.threadId);
          const last = store.lastEntry(thread.threadId, ["user"]);
          const m = last && ENTRY.exec(last.id);
          if (!m) return fail("There is no message to react to yet.");
          n = Number(m[2]);
        }
        let reactions: Reaction[];
        try {
          reactions = store.react(thread.threadId, n, params.emoji.trim(), LYRICA_REACTS, !params.remove);
        } catch (err) {
          return fail((err as Error).message);
        }
        host.reacted(n, reactions);
        return { content: [{ type: "text" as const, text: params.remove ? `Took ${params.emoji} off.` : `Reacted ${params.emoji}.` }], details: undefined };
      },
    });
  };
}

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

/** The user's reactions since her last turn, as a `<reactions>` block for the turn message; empty when none. */
export function reactionLines(reactions: UserReaction[], threadId: string, user: string): string {
  if (!reactions.length) return "";
  const lines = reactions.map((r) => `${user} ${r.on ? "reacted" : "took back"} ${r.emoji} ${r.on ? "to" : "from"} ${r.hers ? "your message" : "their own message"} [e:${threadId}#${r.n}].`);
  return `<reactions>\n${lines.join("\n")}\n</reactions>`;
}
