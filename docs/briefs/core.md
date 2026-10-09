# Brief: Core (milestone 1, "She is herself")

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
3. **`core/users`:** create, authenticate, list, `setAdmin` (the last admin
   can't be demoted), and change password (rewraps the key). Store them in
   per-user `user.db` files plus a small user index in `self.db`.
4. **Persona in `self.db`:**
   - On first run, import `persona/` (SOUL, STYLE, REGISTER, the matrix and
     topics).
   - Every change keeps a revision.
   - Add a function to read the current persona and one to apply a change as
     an administrator. The conversational approval flow comes later.
5. **Extension skeleton:** a factory that takes a `ThreadContext`.
   - `before_agent_start` assembles the persona core plus routed topic addenda,
     within size budgets.
   - Topic routing follows the v1 behavior described in the matrix: score by
     trigger overlap plus priority, pick up to three topics, and let a topic
     persist for up to three turns, decaying. The decay must actually expire.
     v1's notes say Monika's version reset its counter while persisting.
   - Leave stubs for memory sections (WAKE, page index, recall), returning
     nothing.
6. **Admin and dev launcher:**
   - `bin/lyrica admin init`: create the `self.db` passphrase and the first
     administrator.
   - `bin/lyrica admin user add|list|set-admin|passwd`.
   - `bin/lyrica dev --user <name>`: prompt for the password, then start Pi's
     terminal UI with `--no-session` and the extension loaded. Nothing is
     written in plaintext, and Pi's default model config is used for now.

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
  - prompt assembly budgets.
- `bin/lyrica dev` produces an in-character reply in which a routed topic is
  visible in the assembled prompt (shown by a debug flag).
- A short `core/README.md` and `extension/README.md` describe what exists.
- Any contract change is listed in the pull request description.

## Handoff notes

(The Core thread fills this in if it stops before it's done.)
