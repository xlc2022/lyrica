# Brief: Core (milestone 1, "She is herself")

**Status:** Merged as #3 (4238fd7).

**Thread:** Core. **Branch:** `feature/core`. **Depends on:** nothing.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md, docs/contracts.md.

## Goal

Lyrica runs as herself in a developer terminal session: her persona, topic
routing, and a real user who has logged in. Everything else builds on the
scaffolding, users, keys and extension skeleton from this thread.

## In scope

1. **Scaffolding.** The npm workspaces from contracts.md (`core`, `extension`,
   `daemon` as an empty package, `web` left out for now). Shared `tsconfig`,
   `vitest`, root scripts (`typecheck`, `test`), and a minimal GitHub Actions
   workflow that runs both on pull requests.
2. **`core/keyring`** as in the contracts: Argon2id-wrapped per-user keys, and
   the `self.db` passphrase. Saving keys with systemd credentials can be a
   stub that throws "not implemented."
3. **`core/users`:**
   - Create, authenticate, list, `setAdmin` (the last admin can't be
     demoted), and change password (rewraps the key).
   - `updateProfile`: display name and pronouns, changeable at any time.
     Previous names are kept with dates. The login name is separate from the
     display name.
   - Store users in per-user `user.db` files plus a small user index in
     `self.db`.
   - `bin/lyrica admin init` suggests a display name for the first user.
4. **`core/mentions`**, as in the contracts: `toStored`, `render` and
   `queryTokens`, with pronoun presets and custom pronouns. These are pure
   functions with thorough tests. The Memory thread wires them into the store.
5. **Persona in `self.db`:**
   - On first run, import `persona/` (SOUL, STYLE, REGISTER, the matrix and
     topics).
   - Every change keeps a revision.
   - Add a function to read the current persona and one to apply a change as
     an administrator. The conversational approval flow comes later.
6. **Extension skeleton:** a factory that takes a `ThreadContext`.
   - `before_agent_start` assembles the persona core, routed topic addenda,
     and the "who you're talking with" section, within size budgets.
   - Topic routing follows the v1 behavior described in the matrix: score by
     trigger overlap plus priority, pick up to three topics, and let a topic
     persist for up to three turns, decaying. The decay must actually expire.
     v1's notes say Monika's version reset its counter while persisting.
   - Leave stubs for memory sections (WAKE, page index, recall), returning
     nothing.
7. **The `lyrica` command** (TypeScript, one entry point with subcommands; see
   the `bin/lyrica` section of the contracts):
   - `lyrica admin init`: create the `self.db` passphrase and the first
     administrator.
   - `lyrica admin user add|list|set-admin|passwd|profile`.
   - `lyrica dev --init <dir>`: create a development runtime, with a marker
     file and a test administrator.
   - `lyrica dev --runtime <dir> --user <name>`:
     - refuses any directory without the development marker;
     - prompts for the password;
     - starts Pi's terminal UI with `--no-session` and the extension loaded;
     - `--debug-prompt` prints the assembled prompt for each turn;
     - Pi's default model config is used for now.
   - Leave `serve`, `chat` and `mem` as stubs that say which thread builds
     them.

## Out of scope

Memory pools and tools (Memory thread), the model router and local-only
enforcement (Models thread), `lyricad` and the web UI (Web thread), sleep, and
integrations.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests cover:
  - wrong-password refusal;
  - password change keeps data readable;
  - the last admin can't be demoted;
  - persona import and revisions;
  - topic selection and decay;
  - prompt assembly budgets;
  - mention round trips: store, rename, re-render, and custom pronouns.
- `bin/lyrica dev` produces an in-character reply in which a routed topic is
  visible in the assembled prompt (shown by a debug flag).
- A short `core/README.md` and `extension/README.md` describe what exists.
- Any contract change is listed in the pull request description.

## Handoff notes

(The Core thread fills this in if it stops before it's done.)
