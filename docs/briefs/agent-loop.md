# Brief: Agent loop reliability

**Status:** Merged as #309 (ba76098), #314 (9bdf7b3), #315 (0f49a83) and
#321 (af87f0a). Handoff notes below are history. **Branch:** `claude/agent-loop-reliability-661bmo`. **Model:** Opus.

**Read first:** AGENTS.md, docs/delegation.md ("Child threads"),
docs/contracts.md (threads, turn tool limits, the `image` tool), docs/models.md.

## Problem

The user tried Lyrica working on her own code and in plain chats:

1. An LM Studio endpoint answered every turn with 400
   `invalid_union_discriminator` at `tools[8].function.parameters.type`.
2. Qwen3.8-27B called `image` with `{}`, then streamed hundreds of `image`
   calls in one reply. Nothing showed until Stop, which looked like hidden
   reasoning.
3. A failed image call didn't say which model, recipe or host it reached.
4. Child and parent threads failed to wake each other, and a coordination
   message was refused by the two-slot child limit.
5. She said she would continue, then stopped when the turn ended.
6. Self-work spent many tokens.

## Findings

- 1 and 2 are structural, not the model: `image`'s parameters were a
  top-level union (JSON Schema `anyOf`, no `"type": "object"`). LM Studio
  refuses that, and Qwen's chat template renders such a tool with no fields.
  Tool calls reach the views only when a reply ends, so a runaway reply is
  invisible while it streams; the turn limits act only after it ends.
- 4: a woken parent took one of the user's two child slots (`reserveRoutine`),
  so with one child working, its reply to an idle child was refused; and a
  woken parent's reply to the child that woke it was only appended, so a
  child that asked a question never got its answer as a turn.
- 5 is conduct, handled by #304 and #306. The tool results below now say
  exactly what became of a message, so she has the facts to say.
- 6: a plain thread's fixed prompt is about 32,000 characters (persona 7.3k,
  tool guidance 6.8k, tool definitions 16k; `threads` 5.2k and `delegate`
  3.7k of them), resent with every reply.

## Change

- `image`: one object schema with `action`, per-action required fields
  checked in the tool; failures name the model label (a recipe by name) and error code.
- `tool-stream.ts`, around local servers' and hosts' streams: every tool's
  parameters sent as an object; a reply with more than 32 tool calls ends
  with an error and none run.
- Child threads: parent wakes take no child slot; a woken parent's answer
  starts the child's turn for up to three rounds until the person writes; a
  message to an idle child past the limit is saved and the child wakes when
  a slot frees; `message` returns a `Delivery` the tool reports.
- `WORK_GUIDELINES` in her prompt and subagents': batch independent tool
  calls, don't re-read unchanged files, long output to a file.
- Folds in #303 (delegate `folders` guidance), with review's docs fix: an
  unnarrowed writer keeps the parent's repositories.

Principles 1 (long work doesn't swallow a conversation), 2 (structural
guards, not prompts, for the runaway and the schema) and 8 (tokens).

## Follow-up: smaller tool definitions

The user asked for the trim after #309. Measured as each tool's
`{ name, description, parameters }` JSON, the `threads` tool was the same
5,000-odd characters in every thread, though an ordinary child can use only
`message` and its own wake-ups, routines, checklist and compacting.

- `threads` sends each thread only its actions and their fields
  (`paramsFor`), and its description says what each action is for once:
  5,152 to 3,305 characters in a plain thread, 5,043 to 2,593 in a child,
  5,373 to 4,035 in a project chat. A test holds each under a ceiling.
- Every model-facing string choice is `StringEnum` (`"enum"`), not a union
  of `const`s: about 23 characters saved per choice, about 600 across
  `delegate`, `image`, `models`, `download_model`, `model_files` and
  `proxmox`.
- A plain thread's tool definitions drop by about 2,300 characters (of about
  17,500). The guidance in her prompt is unchanged.

Principle 8.

## Follow-up: tool calls while a reply streams

The user asked for this after #314. The views already fold three or more
markers into "<n> tool calls" with a running dot, but a call's marker arrived
only when it ran, after the reply ended, so a reply of many calls looked
silent.

- The daemon sends `tool_call` (`toolCallId`, `name`) on Pi's
  `toolcall_start`; the live view adds the call's marker, running, and
  `tool_start` fills in its arguments in place. Calls the 32-call cap stops
  show while they stream, then go when the stored reply (which has none)
  loads.
- Pi's OpenAI-compatible stream sends `toolcall_end` only after the whole
  reply, so `toolcall_start` is the only per-call signal; a call without an
  id at its start isn't shown early.
- No new control: docs/ux.md's markers row gains one sentence.

Principle 1.

## Follow-up: image errors and the LM Studio 400

The user saw a 413 when editing an image, and repeated 400s whenever an
LM Studio endpoint answered chat.

- The 413 is the model host's `too_big`: the edit recipe doesn't fit the
  GPU. The image tool said only `image endpoint answered 413`; it now passes
  the host's own message whole, so Lyrica can say how much memory the recipe
  needs. A cloud endpoint's error is named by its code, type and parameter
  only, since its prose may quote the prompt.
- The LM Studio 400 seen on 10/14 was `invalid_union_discriminator` on the
  tools list, fixed in #309. On the current build every tool goes to a local
  endpoint as an object, the request after a tool call is well formed
  (assistant `tool_calls`, `tool` results, replayed `reasoning_content`),
  and LM Studio's error text, whether answered or sent mid-stream, reaches
  the conversation whole. A check against LM Studio itself waits on the
  user.

Principles 1 and 2.

## Out of scope

Trimming the `delegate` schema further, inline rename (Side panels
and files), image recipes and the cloud image 400 (Image settings and
recipes, #305).

## Handoff

- **Done:** all of Change (#309), smaller tool definitions (#314), live
  tool calls (#315), image error messages, with tests and docs.
- **Next:** an LM Studio chat check on the current build when the user
  allows it.
