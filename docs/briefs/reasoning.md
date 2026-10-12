# Brief: Reasoning

**Thread:** Reasoning fix build (Codex codes on lunasa, Claude assesses). **Branch:** `feature/reasoning`. **Model:** Opus.

**Read first:** AGENTS.md, docs/models.md (thinking levels), docs/contracts.md
(the thinking switch), docs/web.md (the Thought marker), PRINCIPLES.md 1 and 3.

## Goal

A model's reasoning never shows up in the visible reply, whatever the model,
host or API. It goes in the collapsed Thought marker, both while it streams
and in the stored message (principle 1: experience before infrastructure).

## What exists

- Pi turns provider output into `text_delta` and `thinking_delta`. The
  daemon forwards them as `text` and `thinking` events
  (`daemon/src/hosted.ts:828-833`). Stored messages keep Pi's `thinking`
  blocks as `thinking` parts (`daemon/src/messages.ts:178`). The web app
  shows them as a collapsed Thought marker (`web/src/Messages.tsx:347-377`).
- Pi handles provider reasoning fields and thinking blocks. Lyrica's
  extension wrapper handles inline and split `<think>` tags, and a missing
  opening tag when thinking was requested for the call.
- The host offers a thinking switch only when the chat template mentions
  `enable_thinking` or `<think>` (`host/src/library.ts:62-66`). A switch
  always sends Qwen's `enable_thinking` (`extension/src/models.ts:19`).
- The vLLM tool and reasoning parsers belong to the lunasa install's host
  PR, not this brief.

## In scope

1. **Check Pi first** (principle 3: lean on Pi). Read Pi 1.1.0's
   OpenAI-compatible provider. Record what it already handles:
   `reasoning_content` and `reasoning` deltas, inline `<think>` tags,
   tags split across chunks, and a reply that starts mid-thought with only
   `</think>` (DeepSeek R1 and Qwen templates that open the tag
   themselves). Whatever Pi handles needs no Lyrica code.
2. **A fallback for what Pi misses.** It goes at the lowest layer that
   covers both the live stream and the stored message, so the two never
   disagree. Prefer a fix upstream in Pi. Otherwise, add the smallest
   wrapper in the extension. Inline thinking becomes a thinking block,
   including split tags and a missing opening tag.
3. **Thinking-switch detection.** Recognise the template formats the
   host's models actually use. Send the switch each template understands,
   or offer no switch when it can't be driven. Don't guess formats no
   model on the host uses.
4. **Tests** with `core/test/fake-openai.ts`: `reasoning_content` deltas,
   `<think>` split across chunks, a reply with only `</think>`, and plain
   replies left untouched.
5. **Docs:** models.md and contracts.md for the switch; web.md if the
   marker changes.

## Out of scope

The vLLM parsers (lunasa install's host PR), opening the Thought marker
while thinking streams (a UI change for UI review to propose), and whether
reasoning is replayed into later context.

## Handoff

- **Done:** item 1 (principle 3: lean on Pi). Installed
  `node_modules/@earendil-works/pi-ai/package.json` confirms version 1.1.0.
  Findings below refer to `stream` in
  `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`
  and its local helpers `ensureThinkingBlock`, `ensureTextBlock` and
  `finishBlock`.

  | Case | Handled? | Stream and final assistant message |
  |---|---|---|
  | (a) `reasoning_content` deltas | Yes | `stream` uses `ensureThinkingBlock`, appends to `thinking`, emits `thinking_delta`; final block is `thinking`, with field name as `thinkingSignature`. |
  | (b) `reasoning` deltas (OpenRouter) | Yes | Same path as (a). Per chunk, only the first nonempty string among `reasoning_content`, `reasoning`, `reasoning_text` is used. |
  | (c) Inline `<think>...</think>` in content | No | `stream` uses `ensureTextBlock`, appends content unchanged and emits `text_delta`; reasoning and both tags remain in final `text`. |
  | (d) Either tag split across chunks | No | Same content path: fragments stream as text and concatenate verbatim into final `text`; no tag buffer or parser. |
  | (e) Mid-thought start with only `</think>` | No | Same content path: initial reasoning, closing tag and answer all remain `text`. |
  | (f) Final blocks | Yes for (a–b), no separation for (c–e) | `finishBlock` emits end events without reclassifying blocks; `stream` returns the same `output` in `done.message`. Separate content alongside (a–b) remains a `text` block. |

  No shared thinking/tag parser is called by this provider. In
  `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`,
  `AssistantMessageEventStream` passes through `done.message` as the result;
  `EventStream.result` returns it without parsing.
- **Done:** items 2 and 4 (principles 1 and 3). `extension/src/inline-thinking.ts`
  wraps Pi's provider `streamSimple` hook, registered in `extension/src/models.ts`,
  for inline and split tags in streamed events and final blocks. Leading content
  is held for a template-opened thought only when the call requests thinking
  after Pi clamps the level. Plain replies with thinking off stream live;
  plain and dedicated reasoning replies preserve Pi's events and final blocks.
  `extension/test/inline-thinking.test.ts` covers these cases using made-up
  replies from `core/test/fake-openai.ts`, including live plain text and a
  closing-only tag with thinking requested.
- **Done:** item 5. `docs/models.md` describes how provider reasoning and
  inline tags reach the Thought marker live and stored. `docs/contracts.md`
  was checked: stream and thinking-switch contracts remain current.
  `docs/web.md` needs no change because the marker did not change.
- **Done:** item 3. `templateCapabilities` in `host/src/library.ts` offers
  the on/off switch only when the chat template reads `enable_thinking`
  (Qwen 3, the model the host runs now). A template that opens `<think>` itself,
  like DeepSeek R1's, always thinks and gets no switch; vLLM's `deepseek_r1`
  parser (#225) and llama-server split its reasoning. Tested in
  `host/test/routing.test.ts`.
- **Next:** none. A model that thinks by default without a server-side parser
  and without a switch would still show its thinking; add a flag for it only
  when such a model is served.
- **Open:** none.
