# Brief: Agent loop reliability

**Status:** in PR review. **Branch:** `claude/agent-loop-reliability-661bmo`
(stacked on #306). **Model:** Opus.

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
  checked in the tool; failures name the model label, recipe and error code.
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

## Out of scope

Showing tool calls while a reply streams (a UI change for UI review),
trimming the `threads` and `delegate` schemas, inline rename (Side panels
and files), image recipes and the cloud image 400 (Image settings and
recipes, #305).

## Handoff

- **Done:** all of Change, with tests and docs.
- **Next:** PR review; merge after #306.
- **Open:** whether to trim the largest tool schemas; whether the views
  should show tool calls as they stream.
