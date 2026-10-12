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
- Lyrica itself does no tag parsing. Splitting `<think>` tags,
  `reasoning_content` (DeepSeek's API, LM Studio, llama.cpp), `reasoning`
  (OpenRouter) and Anthropic thinking blocks is up to Pi and the server.
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

- **Done:** nothing yet.
- **Next:** item 1.
- **Open:** none.
