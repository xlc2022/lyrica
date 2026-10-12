# Brief: Image providers

**Thread:** Images UI build (coordinates). **Branch:** `feature/image-providers`.
**Built by:** Codex on the test machine, queued through the project chat.
The coordinating thread reviews each run before PR review and UI review.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Images" and
"Subscription plans", docs/contracts.md (Models, the image API), docs/models.md,
docs/ux.md §5 and the rows "Models, hosts, downloads, clean-up" and "Image
models, recipes and parts", and the code this extends:
`core/src/models/images.ts` (`CLOUD_IMAGE_PROVIDERS`), `core/src/models/index.ts`
(`PLAN_URLS`, `isPlan`, the image `unfit` rules), `web/src/Models.tsx`,
`web/src/ImageModels.tsx`, `web/src/TextModels.tsx`.

## Goal

The user can make images with the ChatGPT plan they already pay for, and add
other cloud image services without code changes per model. Today every cloud
image call goes to one OpenAI adapter that needs an API key and a `gpt-image`
model, and a ChatGPT plan and an OpenAI API-key endpoint look the same in
Hosts and endpoints. Serves principle 1 (the user uses images now) and
principle 8 (no new tool: providers sit behind `core/models`, the router's
cloud, private-thread and portrait rules apply unchanged).

## In scope

**A. Providers.** `CLOUD_IMAGE_PROVIDERS` becomes a real table, chosen by the
endpoint's kind, as plans are chosen today. Each entry is one function
(request in, PNGs out) plus what it can do (create, edit, mask, references,
sizes, count) and how fast and quality map onto its options.
- **ChatGPT plan:** image calls go through the plan's own Responses endpoint
  with the built-in `image_generation` tool, using the plan's token and
  limits. Fast and quality map to low and high quality. A test call on
  2026-10-12 returned a PNG; the model is unreported (probably gpt-image-2).
  Allowed because it is the plan's own endpoint and built-in tool, used by
  the plan's owner on the plan's own limits, as with chat in
  docs/briefs/subscription-logins.md.
  If the tool takes no mask, the plan serves create and maskless edits only,
  and a masked edit falls down the task's list.
- **OpenAI-compatible with a key:** today's adapter, no longer limited to
  `gpt-image-*` model IDs; any model the endpoint marks as making images.
- Results are cleaned to PNG without metadata as today; errors carry codes,
  never provider text. Outages and limits still fall down the task's list.
  A content refusal (decided by the user, 2026-10-12) does not: the call
  stops, the image marker shows the failure with its code, and under it
  three small text links, not buttons: **Edit message** (the triggering
  message back in the composer), **Resend**, and **Try <next model>** (the
  next model on a different endpoint in the list the router would use for
  this thread, with the cloud, private-thread and portrait rules already
  applied). **Try**
  shows only when such a model exists, and **Edit message** only while that
  message is still the thread's last user message; otherwise the link is
  left out, never disabled. docs/ux.md records this row of links beside
  the §5 exception. A new
  refusal code from the provider adapters marks it apart from other errors.

**B. Use for on cloud models.** A cloud image model can be tagged fast,
quality or both (default both), like a host recipe, so a cheap model can be
fast-only. The router's tier rule applies to cloud as it does to recipes.

**Storage.** The tag (`useFor`) and the image generation and editing flags
live in the offering's `hand` JSON (`offerings.hand` in
core/src/models/schema.ts, self.db for shared endpoints and user.db for the
user's own), beside the capabilities already set by hand, so no schema step
is needed. If the build finds it needs one after all, it is expand-only with
a migration test from every released schema, and since command rules and
spend share add user.db steps in parallel, whichever merges later renumbers
its step after merging main.

**C. Telling endpoints apart** (decided by the user, 2026-10-12):
1. A plan's row keeps its **ChatGPT plan** (or **Grok plan**) pill; every
   cloud endpoint with a key gets an **API key** pill.
2. A plan's facts line drops the placeholder URL (`PLAN_URLS`) and reads
   "ChatGPT plan · only you", with the signed-in account if the sign-in
   exposes one. A keyed endpoint keeps its URL and adds "key ••••last4". The key and
   the account are in mono.
3. Default names: "ChatGPT" for a ChatGPT plan, "OpenAI" for an endpoint at
   api.openai.com with a key; the user can rename either.
4. Every place a model is picked (the model picker, Tasks cells, Text models
   copies, Image models) shows the endpoint's name after the model, muted, since a plan and a
   key can offer the same model IDs; at 390 px the endpoint name truncates
   first.
5. No new control for order: the user lists the plan first and the API key
   as the paid fallback in Tasks.

**D. Capability pills** (decided by the user, 2026-10-12, an exception to
docs/ux.md §5): a cloud endpoint's row shows **Text**, **Vision** and
**Image** pills, each when at least one of its models can do it (Image only
when Lyrica can actually call it there). Local endpoints and host cards stay
as they are. The row's pills are thus its kind pill, API key or plan pill,
and these; the §5 limit of two does not apply to them. Each model on a cloud
endpoint gets **Image generation** and **Image editing** switches in its
model list, each with a tooltip saying what it lets her do, replacing the
HTTP-only step in the getting-started guide. On a phone (390 px) the
capability pills wrap onto their own line under the name, with no sideways
scroll, and the row's actions stay where they are.

## Out of scope

- Providers that queue a job and report back (Black Forest Labs, fal,
  Replicate) and Google's image API: a later build, which would also give the
  image marker real "step n of m".
- Grok plan images: unknown until a Grok plan is signed in for a test, and a
  test spends plan usage, so it waits for the user's yes.
- Any change to local hosts, recipes or the image tool's arguments.

## Done when

- A ChatGPT plan in `image.create` makes an image in a general thread, and a
  private or local-only thread never reaches it (test with a fake plan).
- A keyed endpoint serves a non-`gpt-image` model marked as making images.
- A cloud model tagged fast-only is skipped for quality and used for fast.
- In a private or local-only thread, Try never offers a cloud model.
- A refusal stops with the three links, and Try <next model> makes the
  image on that model.
- Hosts and endpoints shows the pills and facts lines in C and D; every
  picker names the endpoint.
- Screenshots at 1280 and 390 px of a cloud row with all five pills, and
  of a refusal with its links.
- docs/ux.md §4 lists Text, Vision, Image, API key, Image generation, Image
  editing, Edit message, Resend and Try <model>.
- docs/ux.md (§5 exception, the Hosts and endpoints row), DESIGN.md "Images",
  docs/contracts.md, docs/models.md and the getting-started guide match.
- Typecheck, unit tests and e2e green in CI; PR review and UI review verified.

## Handoff notes

(The building thread fills this in if it stops before it's done.) A partial
diff from a stopped pills run is at /tmp/claude-1000/iu/run4-stopped.patch on
the test machine; use it only as a reference.
