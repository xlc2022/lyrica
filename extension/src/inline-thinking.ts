import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

const OPEN = "<think>", CLOSE = "</think>";
function partialTagLength(text: string, tags: string[]): number {
  let keep = 0;
  for (const tag of tags) {
    for (let n = 1; n < tag.length; n++) {
      if (text.endsWith(tag.slice(0, n))) keep = Math.max(keep, n);
    }
  }
  return keep;
}

/**
 * Principle 1: keep inline reasoning out of the reply, in both Pi events and storage.
 * `midThought`: the chat template opens `<think>` itself for this call, so the reply
 * may start inside a thought with only `</think>`; leading text is held until a tag.
 * Otherwise plain text streams immediately.
 */
export function streamWithInlineThinking(model: Model<"openai-completions">, context: TranscriptContext, options: SimpleStreamOptions | undefined, midThought: boolean): AssistantMessageEventStream {
  const source = streamSimple(model, context, options);
  const out = createAssistantMessageEventStream();
  void (async () => {
    const content: AssistantMessage["content"] = [];
    const indices = new Map<number, number>();
    let partial!: AssistantMessage;
    let dedicated = false, thinking = false, trim = false, transformed = false;
    let pending = "";
    let undecided = midThought;
    let held: AssistantMessageEvent[] = [];
    let active: number | undefined;
    let changed = false;
    const view = (message: AssistantMessage): AssistantMessage => ({ ...message, content });
    const end = () => {
      if (active === undefined) return;
      const block = content[active]!;
      if (block.type === "text") out.push({ type: "text_end", contentIndex: active, content: block.text, partial });
      if (block.type === "thinking") out.push({ type: "thinking_end", contentIndex: active, content: block.thinking, partial });
      active = undefined;
    };
    const emit = (delta: string) => {
      if (trim && !thinking) {
        delta = delta.replace(/^\s+/, "");
        if (delta) trim = false;
      }
      if (!delta) return;
      if (active === undefined) {
        active = content.length;
        content.push(thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
        out.push({ type: thinking ? "thinking_start" : "text_start", contentIndex: active, partial });
      }
      const block = content[active]!;
      if (block.type === "thinking") block.thinking += delta;
      if (block.type === "text") block.text += delta;
      out.push({ type: thinking ? "thinking_delta" : "text_delta", contentIndex: active, delta, partial });
    };
    const parse = (final = false) => {
      while (pending) {
        const tags = thinking ? [CLOSE] : [OPEN, CLOSE];
        const matches = tags.map((tag) => ({ tag, at: pending.indexOf(tag) })).filter(({ at }) => at >= 0).sort((a, b) => a.at - b.at);
        const match = matches[0];
        if (undecided) {
          if (!match && !final) return;
          undecided = false;
          if (match?.tag === CLOSE) thinking = true;
        }
        if (match) {
          changed = true;
          emit(pending.slice(0, match.at));
          end();
          thinking = match.tag === OPEN;
          trim = !thinking;
          pending = pending.slice(match.at + match.tag.length);
          continue;
        }
        const keep = final ? 0 : partialTagLength(pending, tags);
        emit(pending.slice(0, pending.length - keep));
        pending = pending.slice(pending.length - keep);
        return;
      }
    };
    const forward = (event: AssistantMessageEvent) => {
      if (!("contentIndex" in event)) return;
      let index = indices.get(event.contentIndex);
      if (index === undefined) {
        index = content.length;
        indices.set(event.contentIndex, index);
        const block = event.partial.content[event.contentIndex]!;
        content.push(block.type === "text" ? { ...block, text: "" } : { ...block });
      }
      const block = content[index]!;
      if (event.type === "text_delta" && block.type === "text") block.text += event.delta;
      else if (!event.type.startsWith("text_")) content[index] = { ...event.partial.content[event.contentIndex]! };
      out.push({ ...event, contentIndex: index, partial });
    };
    for await (const event of source) {
      const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
      if (partial) Object.assign(partial, message, { content });
      else partial = view(message);
      if (event.type === "start") {
        out.push({ ...event, partial });
        continue;
      }
      if (event.type === "thinking_start" && !dedicated) {
        // The server splits reasoning itself: release anything held and stop parsing.
        dedicated = true;
        undecided = false;
        for (const e of held) forward(e);
        held = [];
        pending = "";
      }
      if (event.type === "text_start" && !dedicated) {
        held = [event];
        transformed = false;
        continue;
      }
      if (event.type === "text_delta" && !dedicated) {
        held.push(event);
        pending += event.delta;
        if (undecided && !pending.includes(OPEN) && !pending.includes(CLOSE)) continue;
        // Preserve Pi's exact plain events until a tag or a possible split tag appears.
        if (!transformed && !thinking && !trim && !pending.includes(OPEN) && !pending.includes(CLOSE) && !partialTagLength(pending, [OPEN, CLOSE])) {
          for (const e of held) forward(e);
          active = indices.get(event.contentIndex);
          held = [];
          pending = "";
        } else {
          transformed = true;
          held = [];
          parse();
        }
        continue;
      }
      if (event.type === "text_end" && !dedicated) {
        if (undecided || !transformed) {
          for (const e of held) forward(e);
          forward(event);
          pending = "";
          held = [];
          undecided = false;
          active = undefined;
        } else {
          parse(true);
          end();
        }
        continue;
      }
      if (event.type === "done" || event.type === "error") {
        parse(true);
        end();
        out.push(!changed ? event : event.type === "done" ? { ...event, message: partial } : { ...event, error: partial });
      } else forward(event);
    }
    out.end();
  })();
  return out;
}
