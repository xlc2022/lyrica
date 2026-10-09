# extension

The Lyrica Pi extension. `createLyricaExtension(thread, options)` returns a Pi
`ExtensionFactory` for one thread.

- **`before_agent_start`** routes topics for the user's message and assembles
  her context. It never replaces the whole system prompt. Instead it does
  three things:
  - It edits Pi's `systemPromptOptions`. The persona core becomes
    `customPrompt`, which also drops Pi's coding preamble. Topics, WAKE, the
    page index and "who you're talking with" become `sections`.
  - Pi's default tool list and rules are dropped along with the preamble, so
    `toolGuidance` rebuilds them into a `tools` section from each tool's own
    snippet and guidelines.
  - It returns content that changes every turn (recall and the time) as a
    hidden `lyrica-turn` message.

  Because only the turn message changes, the system prompt stays
  byte-identical from turn to turn when nothing in it changed. Pi then sends
  only the deltas, so the prompt prefix stays cacheable.
- **`routing.ts`**: a topic scores trigger overlap (whole words, simple
  plurals) plus its priority. Up to 3 topics load per turn. A triggered topic
  persists for 3 more turns with a decaying score; only a new trigger resets
  its count, so it always expires.
- **`assemble.ts`** builds these pieces:
  - stable: the persona core, topic addenda, WAKE, the page index, and who
    she's talking with (display name, pronouns, previous names with dates);
  - per turn: recall, and the time, with the time since you last talked.

  Each has a character budget (`DEFAULT_BUDGETS`) and is cut at a line break
  when it's over.
- **`memory.ts`** is a stub: WAKE, page index, recall and last-talk time come
  back empty until the Memory thread fills them in from the `PoolView`.
- With `debugPrompt: true`, each turn shows the routed topics, section sizes,
  and the full system prompt plus the turn message (a TUI notification, or stderr in
  print mode).

No tools or commands yet.

## Running it: `bin/lyrica`

```sh
bin/lyrica admin init                  # self.db passphrase, first administrator (suggests Li)
bin/lyrica admin user add <login> [--admin]
bin/lyrica admin user list | set-admin <login> on|off | passwd <login> | profile <login>
bin/lyrica dev --init <dir>            # development runtime with test administrator "tester"
bin/lyrica dev --runtime <dir> --user <login> [--debug-prompt] [-- <pi args>]
```

- Admin commands use `--runtime <dir>`, else `LYRICA_HOME`, else `./runtime`.
- Passwords and passphrases are read only at a hidden terminal prompt.
- `dev` is a developer bench. It refuses any directory without the
  `LYRICA_DEVELOPMENT_RUNTIME` marker that `dev --init` writes. It then starts
  Pi's TUI with `--no-session` and `--no-builtin-tools`, with no context
  files, skills, prompt templates, MCP or other extensions. It uses Pi's own
  model configuration.
- `serve`, `chat` and `mem` are stubs that name the thread that builds them.
