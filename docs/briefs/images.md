# Brief: Images

**Thread:** Images. **Branch:** `feature/images`.

**Depends on:** Models 2 (hosts and fallbacks) and Model host (the image API
and workflow templates). Start once both are merged. Cloud image services
don't need a host, so that part can start earlier if useful.

**Read first:**
- AGENTS.md and PRINCIPLES.md;
- DESIGN.md: "Images", "Models and endpoints" and "Who Lyrica is for" (the
  part on operators);
- docs/contracts.md: `core/models`, `core/workspace` and `extension`;
- docs/workspace.md;
- `host/README.md` and the host's image API.

## Goal

Lyrica creates and edits images in conversation, as ChatGPT does. She writes
the prompt herself, looks at the result and tries again. Images stay as
private as the thread they belong to, and photos of the user go to a cloud
model only by the user's choice. This serves principle 1: images become part
of how she works with Li, from storyboards to edits of Li's own photos.

## In scope

1. **The `image` tool**, one tool within the budget of 30:
   - `create`: a prompt, `fast` or `quality`, a size or aspect ratio, a
     count, and optional reference images;
   - `edit`: an image, an instruction, an optional mask, and optional
     references.

   Images are named by workspace path: uploads, earlier results, or the
   user's photos.
2. **Routing.**
   - The tasks `image.create` and `image.edit` resolve through the router
     with the thread's `CallContext`, using the ordered fallbacks.
   - Private and local-only threads get local models only.
   - `fast` and `quality` are the two tiers of `image.create`.
3. **Providers.**
   - **Model host:** its image API, which takes a confirmed recipe and
     parameters. The recipe's defaults (steps, CFG, sampler, size) apply
     unless the tool asks for a size or count. The tool never names parts or
     LoRAs: those live in the recipe.
   - **Cloud:** OpenAI's image API first (generate and edit), declared as a
     cloud endpoint with a key.
   - Further providers (Black Forest Labs, Krea, Google, fal, Replicate) come
     through one small provider table, like the DNS providers in web access.
     Add one or two if they're cheap; the table matters more than the count.
4. **Photos of you.**
   - Each user has a `photos-of-me/` folder in their encrypted home, managed
     from the UI.
   - A per-user setting in `user.db`: **Never**, **Ask once a day** (the
     default) or **Always**. The tool enforces it when any reference comes
     from that folder and the chosen model is cloud:
     - Never: a plain refusal;
     - Ask: a permission prompt (the existing approval flow), "Send photos of
       you to <provider>?". An approval holds until the end of that day for
       that user;
     - Always: allowed.
   - Local models are always allowed.
5. **Results.**
   - Saved into the thread's folder in the encrypted home (`images/`), with
     the prompt kept only in the thread's tool call.
   - Returned to her as images, so a vision-capable model can look and try
     again.
   - Nothing is written outside the encrypted home, and no metadata with the
     prompt is embedded in files.
6. **Daemon and API.**
   - An authenticated route serves a thread's files for display: the thread's
     folder only, with Content-Type sniffed, `no-store`, and the same user
     checks as everything else.
   - An `image` message part (paths, model, tier) on messages and
     `tool_end`.
   - Routes to manage `photos-of-me/` and the setting.
7. **Wireframes and diagrams.**
   - The deployment installs a headless Chromium on the `lyricad` host. Her
     sandbox, which sees the host's read-only system, can then render HTML
     or SVG to PNG with internet off.
   - Document the command in docs/workspace.md, so she draws layouts as code
     rather than asking an image model.

## Out of scope

- Inline images, the lightbox, and the photos-of-me and setting screens in
  the UI (Web UI thread, from this API).
- The personal LoRA (later).
- Video.

## Done when

- `npm run typecheck` and `npm test` pass in CI.
- Tests, with a fake host image API and a fake OpenAI images endpoint, show
  that:
  - create and edit work through a host template and through the cloud
    provider;
  - a private thread never reaches the cloud provider;
  - fallbacks go from the workstation to the 3090;
  - photos-of-me references are refused under Never, ask once per day under
    Ask (deny and allow both tested, and the next day asks again), and are
    allowed under Always and for local models;
  - results land in the thread's encrypted folder, are served only to their
    owner, and carry no prompt metadata;
  - she receives the image back as image content;
  - the sandbox renders an HTML file to PNG with internet off.
- docs/workspace.md and docs/models.md describe what exists, and the PR lists
  any contract change.

## Handoff notes

(The thread fills this in if it stops before it's done.)
