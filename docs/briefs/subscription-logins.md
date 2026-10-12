# Brief: subscription logins

**Thread:** Subscription logins (Opus). Asked by Li on 2026-10-12 ("Lyrica
should be able to support Codex and Anthropic logins in addition to API
keys", so her subscriptions can be used). Design lines live in DESIGN.md,
"Models and endpoints"; this brief is the build plan. Waits for Li's go.

## Why

Li pays for a ChatGPT plan. Letting Lyrica's general threads answer from
that plan, instead of paying per token on top, is something she notices
in every cloud conversation (principle 1). Pi already ships the sign-in
and the provider, so this is wiring, not a client of our own (principle 3).

## What each provider allows (checked 2026-10-12)

- **ChatGPT plan: allowed.** OpenAI's "Sign in with ChatGPT" lets Go,
  Plus and Pro subscribers spend their plan's included usage in other
  apps, with a weekly cap per app set in ChatGPT's settings (help article
  "Using your ChatGPT plan in other apps and sites", and the DevDay
  announcement of 2026-09-29). Pi implements it as its `openai` provider
  with `auth.oauth` ("Sign in with ChatGPT",
  `pi-ai/dist/auth/oauth/openai-chatgpt.js`): each installation registers
  its own client (`dynamic_agent_client`), and the token goes to
  `api.openai.com/v1` Responses. Not verified: OpenAI's pages couldn't be
  read from the cloud session, and its help page speaks of "participating"
  apps, so the first real sign-in is the test that a self-hosted install
  is accepted.
- **Codex CLI login: not used.** Pi's older `openai-codex` provider
  borrows the Codex CLI's own client and calls
  `chatgpt.com/backend-api/codex`. The official sign-in above replaces it.
- **Claude plan: forbidden.** Anthropic's Claude Code legal page
  (code.claude.com/docs/en/legal-and-compliance) says subscription OAuth
  "is designed to support ordinary use of Claude Code and other native
  Anthropic applications", that "Anthropic does not permit third-party
  developers to offer Claude.ai login into their own applications", and
  that developers "may not collect, store, or intermediate Claude.ai
  credentials or session tokens". Pi's Anthropic sign-in works by
  presenting itself as Claude Code (its user agent, betas and system
  prompt line), and Anthropic has blocked such clients since January 2026.
  So Lyrica doesn't build it. Claude stays on an API key: Anthropic's
  OpenAI-compatible endpoint (`https://api.anthropic.com/v1/`) already
  works as a plain cloud endpoint. The one permitted way to use a Claude
  plan is the unmodified `claude` program signed in through Anthropic's
  own flow; using it as a tool in her sandbox is a separate question for
  Li, not part of this build.

## Build

1. **A ChatGPT plan endpoint.** A new endpoint `api` value, `chatgpt`,
   always `cloud`, base URL `https://api.openai.com/v1`, no API key. Only
   a user's own: refused as a shared endpoint, since a plan belongs to one
   person and users are protected from each other (principle 2). An
   administrator adds one for themselves like anyone else.
2. **Schema:** the next free user database step after MCP's step 3 (adds
   only): `endpoints.oauth`, the sign-in's credential as JSON (`access`,
   `refresh`, `expires`, `clientId`, `scopes`), in `user.db` and so
   encrypted with the user's key. An older release reading the database
   sees a `chatgpt` endpoint with no key, whose calls fail and which is
   marked down; nothing breaks.
3. **Installation ID.** Sign in with ChatGPT needs a stable UUID per
   installation (`ext_agent_host_id`). One per `lyricad`, made on first
   use and kept in `self.db`'s settings; agent name "Lyrica".
4. **Signing in from a browser.** `lyricad` is headless and Li's browser
   is on another device. The daemon runs Pi's `login` with an
   `AuthInteraction` of its own:
   - `POST …/endpoints/chatgpt/sign-in` starts it and returns the
     authorize URL (the `auth_url` event) and a sign-in ID;
   - the web opens the URL in a new tab; after Li approves, OpenAI sends
     the browser to `http://127.0.0.1:1455/auth/callback?…`, which her
     device can't open, so she copies that address back into the drawer;
   - `POST …/endpoints/chatgpt/sign-in/:id` answers Pi's `manual_code`
     prompt with it. Pi checks the state, exchanges the code and returns
     the credential, which is saved with the endpoint.
   A pending sign-in lives in memory for 10 minutes, belongs to the user
   who started it, and is dropped on cancel, lock or log out. Pi's
   loopback listener on 127.0.0.1:1455 stays bound to loopback; when that
   port is taken, the error says so. Neither the pasted address nor any
   token is logged.
5. **Calls and refresh.** `modelRuntimeFor` registers a `chatgpt`
   endpoint as Pi's `openai` provider under the endpoint's ID with the
   Responses API, and gives the runtime a `CredentialStore` over the
   endpoint's `oauth` column instead of `setRuntimeApiKey`. Pi refreshes
   inside `modify` when under five minutes remain; Lyrica's store
   serialises `modify` per endpoint, so two threads don't both refresh. A
   refresh that fails marks the endpoint **Signed out**: the router skips
   it like a stale one, and the row offers **Sign in again**, which runs
   step 4 for the same endpoint and keeps every ID. Keep the runtime
   sealed otherwise: no other provider or login reaches it, and a private
   or local-only context still gets local endpoints only, so the plan can
   never answer there.
6. **Models.** Discovery reads Pi's catalogue for the `openai` provider
   as signed in (classifier models left out, as Pi does), not
   `/v1/models`, with Pi's capabilities (context, tools, vision,
   thinking). Thinking levels go out as Responses `reasoning.effort`.
7. **The plan's limit.** When the plan's usage or the per-app cap runs
   out, OpenAI refuses with a 429. That marks the endpoint down like any
   429, so the next model in the list answers. If the refusal says when
   the limit resets, the endpoint stays down until then rather than for
   30 seconds; Recent calls notes "Plan limit".
8. **Removing** the endpoint deletes the credential. It doesn't revoke the
   app in ChatGPT; the confirm dialog says so.
9. **Web** (docs/ux.md, Models row; UI review): the Add endpoint drawer
   gets a **Type** select first: OpenAI-compatible (today's fields) or
   ChatGPT plan (Name, **Sign in with ChatGPT**, then a **Redirect URL**
   field and **Finish**). The plain endpoint row shows a **ChatGPT plan**
   pill and, when the refresh failed, the state **Signed out** with **Sign
   in again** in its ⋯ menu. No other new controls.
10. **Tests** (what Li would notice): a private or local-only thread never
    gets a `chatgpt` endpoint; a shared one is refused; a refresh writes
    the new credential back and two concurrent refreshes make one call; a
    failed refresh marks Signed out and the router skips it; the
    migration from every released schema; no token or pasted address
    appears in a log line.

## Budgets

No model-facing tool. Core lines: the endpoint type, the credential store
and the sign-in state, roughly 300 of principle 8's extension budget.

## Out of scope

Claude plan sign-in (forbidden, above); the Codex CLI login; the `claude`
program as a tool; shared plans; spend or remaining-limit display.

## Order

After MCP takes user step 3. Opus builds; Sonnet for the tests and the
migration test.
