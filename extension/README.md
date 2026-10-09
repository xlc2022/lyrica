# extension

The Lyrica Pi extension. `createLyricaExtension(thread, options)` returns a Pi
`ExtensionFactory` for one thread.

- **`before_agent_start`** routes topics for the user's message, assembles the
  prompt and returns it as the whole system prompt, so Pi's coding prompt is
  never sent.
- **`routing.ts`**: a topic scores trigger overlap (whole words, simple
  plurals) plus its priority. Up to 3 topics load per turn. A triggered topic
  persists for 3 more turns with a decaying score; only a new trigger resets
  its count, so it always expires.
- **`assemble.ts`** builds sections in order: persona core, topic addenda,
  WAKE, page index, recall, the time (and time since you last talked), and the
  user's display name. Each has a character budget (`DEFAULT_BUDGETS`) and is
  cut at a line break when it's over.
- **`memory.ts`** is a stub: WAKE, page index, recall and last-talk time come
  back empty until the Memory thread fills them in from the `PoolView`.
- With `debug: true`, each turn shows the routed topics, section sizes and the
  full prompt (a TUI notification, or stderr in print mode).

No tools or commands yet.

## Running it

```sh
bin/lyrica admin init                   # self.db passphrase and first administrator
bin/lyrica admin user add <name> [--admin]
bin/lyrica admin user list | set-admin <name> on|off | passwd <name>
bin/lyrica dev --user <name> [--debug] [-- <pi args>]
```

`dev` starts Pi's TUI with `--no-session`, no context files, skills, prompt
templates, MCP or other extensions, and no built-in tools. It uses Pi's own
model configuration. Data lives in `LYRICA_HOME` (default `./runtime`).
