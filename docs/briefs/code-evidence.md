# Brief: Evidence for "done" in code turns

**Status:** Not started. Comes from a study of the hermes-agent and opencode
coding prompts (2026-11-01); the prompt-only lessons from that study are in
the code-mode brief's follow-up note.

**Branch:** `feature/code-evidence`. **Owner:** the Agent loop thread.
**Read first:** AGENTS.md, PRINCIPLES.md (2, 6, 8), DESIGN.md (Memory, the
code-mode paragraph), docs/contracts.md (extension, code mode),
docs/workspace.md ("Project checks"), docs/ux.md (the Checks row),
extension/src/checks.ts, extension/src/turn-tools.ts.

## Goal

When a code turn says it is done, the claim rests on what the tools showed.
In the code-mode runs, local models said they had seen a screenshot they
never saw, left half-built parts and reported success, and project checks
only catch what a check command tests. Three small parts, in this order:

## In scope

**A. Evidence check at the end of a code turn** (principles 2, 6).

- Runs when a code-mode thread's run ends with a reply after a file-changing
  call succeeded, the same trigger as project checks, and after the
  checks pass or when the project has none. Never in a project chat, Plan
  mode or a subagent.
- One call to the thread's own `code` model list through `core/models`, so
  a local-only or private thread stays local and the Claude Code wrapper
  rule holds; no paid model is added.
- The judge prompt (adapted from opencode's `plugin/goal/judge.txt`, MIT,
  credited where it lives): the person's request and the Code task as
  data, then the turn's tool calls with each result's tail (the checks'
  `tail` limits). Her own reply is not evidence. It answers one JSON line:
  `done`, `continue` with a reason and the next step, or `blocked` with
  what only the person can give.
- `continue` goes back to her unseen, as `CHECKS_FAILED` does, and she
  works on in the same run. At most 2 rounds; the same reason twice ends
  it. When the rounds run out, her reply must say what is unverified.
- No unparseable verdict blocks her: it counts as `done` and is noted in
  the notice.
- The thread shows a notice headed **Evidence** beside **Checks**, with the
  same dot and word (**checked** or **not shown**) and the judge's reason
  as its body. It lives in the thread like the checks notice, encrypted
  with the pool; nothing is logged.

**B. Syntax check after each write** (principle 2, from hermes-agent's lint
tier).

- After a successful `write` or `edit` of a `.js`, `.mjs`, `.cjs`, `.json`
  or `.py` file, run one file-local check on the execution target with a
  10 s limit: `node --check`, `JSON.parse` through `node -e`, and Python's
  `ast.parse` through `python3 -c` (never `py_compile`, which writes
  `__pycache__`). Skip when the tool isn't on the target.
- A failure is appended to the tool result ("Syntax check failed: …", at
  most 20 lines); a pass adds nothing.
- TypeScript and other languages are left to project checks, since they
  need the project's own config.

**C. Repair small models' tool calls** (from opencode's tool-input repair).

- Pi already coerces numbers, booleans and strings by schema
  (pi-ai `utils/validation.js`). It doesn't parse an object or array sent
  as a JSON string (Qwen does this with `edit`'s `edits`), and an unknown
  tool name gets only "Tool X not found".
- Before validation, parse a string argument whose schema type is object
  or array, when it parses to that type.
- Map common names from other harnesses to her tools when no tool has that
  name: `read_file`→`read`, `write_file`→`write`, `str_replace` and
  `apply_edit`→`edit`, `shell`, `terminal` and `run_command`→`bash`, and
  add "There is no X tool, so this ran as Y. Call Y next time." to the
  result. A name with no match lists her active tools in the error.

## Out of scope

- A judge outside code mode, or for coder subagents (their parent reads
  the report).
- A setting to turn A off. If its cost shows on a cloud code model, that
  is a decision for the person, and it would need a home in docs/ux.md.
- LSP, type checking on write, formatters.

## Done when

- Scripted: a code turn whose tool results show a failing test and whose
  reply says "all tests pass" gets `continue` from a fake judge, the
  continuation reaches her unseen, and the notice says **not shown**; a
  second identical reason ends the rounds. A turn with no file change runs
  no judge. A private thread's judge call resolves to its local code model.
- A broken `.js` write returns the syntax error; a good one returns the
  plain result; a `.ts` write runs nothing.
- `edit` with `edits` as a JSON string applies; `read_file` runs `read`
  with the note.
- docs/workspace.md ("Project checks"), docs/contracts.md, DESIGN.md (the
  code-mode paragraph) and docs/ux.md (the Evidence notice beside Checks)
  are updated in the same PR. UI review checks the notice.
- The code-mode eval's real-model check, run on lunasa with the local
  models, records how often the judge said `continue` and whether she then
  fixed what it named.

## Handoff notes

None yet.
