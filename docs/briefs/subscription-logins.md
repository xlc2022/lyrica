# Brief: subscription logins

**Status:** Merged as #169 (5b6963a).

**Thread:** Subscription logins (Opus). Asked by the owner on 2026-10-12 ("Lyrica
should be able to support Codex and Anthropic logins in addition to API
keys", so their subscriptions can be used). The owner approved the ChatGPT plan and
added Grok the same day; built in #169. How it works is in docs/models.md,
"Subscription plans"; this brief keeps the reasons and what's left.

## Why

The owner pays for a ChatGPT plan. Letting Lyrica's general threads answer from
that plan, instead of paying per token on top, is something the owner notices
in every cloud conversation (principle 1). Pi already ships the sign-in
and the provider, so this is wiring, not a client of our own (principle 3).

## What each provider allows (checked 2026-10-12)

| Provider | Plan sign-in in Lyrica |
|---|---|
| ChatGPT (OpenAI) | yes |
| Grok (xAI: SuperGrok, X Premium) | yes |
| Claude (Anthropic) | no: forbidden |
| Gemini (Google) | no: forbidden, and accounts were banned for it |
| DeepSeek | no plan exists; API key only |

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
  (ChatGPT Images instead runs the unmodified `codex` program with the
  user's own Codex sign-in: codex-images.md.)
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
  own flow; using it as a tool in her sandbox is a separate design (the
  owner asked for it on 2026-10-12, after this build).
- **Grok plan: allowed.** xAI announced SuperGrok and X Premium sign-in in
  third-party agents itself (x.ai/news/grok-opencode,
  x.ai/news/grok-kilocode). Pi's `xai` provider has it as a device code
  (`auth.x.ai`), so a headless server needs no pasted address.
- **Gemini plan: forbidden.** Google's Gemini CLI FAQ calls using
  third-party software "to harvest or piggyback on Gemini CLI's OAuth
  authentication" a violation of its terms, and Google banned AI Pro and
  Ultra subscribers for it from February 2026. Pi has no Google sign-in.
  Gemini stays on an AI Studio API key (OpenAI-compatible).
- **DeepSeek: no plan.** Its chat app is free and its API is pay per
  token; a DeepSeek API key is a plain cloud endpoint.

## Built (#169)

- Endpoints of `api` `chatgpt` and `grok`: cloud, personal only, the
  sign-in in the `api_key` column as JSON. Using that column instead of a
  new one means no migration, so the build doesn't wait for MCP's user
  step 3.
- `POST …/plans/sign-in` and `…/:id` in `lyricad`, with Pi's flows; the
  Add endpoint drawer's Kind (which offers the plans), the plan row's pill, Signed out and Sign in
  again.
- `PlanCredentials`: Pi's refresh written back to `user.db`, serialised per
  plan; a refused refresh signs the plan out.
- OpenRouter sign-in (added 2026-10-12 at the owner's request): not a plan.
  Its PKCE flow hands back a user-controlled API key, so it ends as a plain
  cloud endpoint with no refresh. Allowed: OpenRouter issues the key for
  exactly this. See docs/models.md, "OpenRouter sign-in".
- A plan's usage limit skips it for an hour, so the next turn falls back;
  the turn that hit it ends with the provider's message.
- Tests (`extension/test/plans.test.ts`): never in a private or local-only
  runtime, personal only, one refresh for concurrent calls, signed out on a
  refused refresh but not on a network failure, the usage limit, and Grok.

## Budgets

No model-facing tool, no schema change. About 300 lines across core,
extension, daemon and web.

## Open

- The first real sign-ins, after deploy: whether OpenAI accepts a
  self-hosted install's Sign in with ChatGPT (its help page speaks of
  "participating" apps), and xAI's wording for its usage-limit error,
  which `isPlanLimit` guesses.
- Every model in Pi's catalogue for the provider is listed, including ones
  a plan may not cover; a call to one fails like any refused call. Since
  #742 the user can switch such a model off in the plan's model list
  (docs/models.md, "Enabled"), so nothing picks it.

## Out of scope

Claude and Gemini plan sign-in (forbidden, above); the Codex CLI login;
the `claude` program as a tool (its own design); shared plans; a display
of the remaining limit.
