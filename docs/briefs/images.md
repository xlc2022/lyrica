# Brief: Images

**Thread:** Images. **Branch:** `feature/images`.

**Depends on:** Models 2 (hosts and fallbacks) and Model host (the image API
and workflow templates). Both are merged.

**Where things stand (2026-10-12).** Host recipes, parts, ComfyUI templates
and SeedVR2 are built. Step A is committed as `69ec66c`: image calls through
`core/models`, including upscale, host recipes and OpenAI. Step B adds the
image tool, portrait policy and storage, and image message metadata. Step C's
routes and headless-browser deployment remain. Nothing has run on real
ComfyUI yet; the image tests use in-memory API fakes.

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
of how she works with the user, from storyboards to edits of the user's own photos.

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
   - `upscale` resolves `image.upscale` (SeedVR2 on the hosts). It takes an
     image from the thread or the user's photos, so the photos-of-you rule
     applies as for edits.
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
4. **Portrait photos.**
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

**Done:** A was committed/pushed by the supervisor as `69ec66c`; supervisor
checks had no new failures. B is complete, uncommitted/unpushed, serving
principles 1, 2, 4 and 8. One `image` tool handles create/edit/upscale in hosted
and bench sessions, and subagents whose role permits it. Inputs use workspace
paths or the tool-only `/photos-of-me/<file>` path. GPT Image 1 maps requested
sizes/ratios to its nearest supported canvas; host recipe defaults stay intact.

`Workspace.imageFiles` checks the unlocked/mounted encrypted home, refuses
symlinks, saves metadata-free `images/<uuid>.png`, and returns Pi image content.
User schema 5 adds the photo-cloud default Ask (expand only, oldest reader 1).
The tool checks Never/Ask/Always against every actual provider attempt through
`Models.image.beforeSend`, including local → cloud fallbacks. Daily approval is
per user, persists encrypted across threads/restarts, expires at server-local
midnight and clears on a policy change; the clock is injectable. Messages and
`tool_end.image` carry `ImagePart` path/model/tier metadata, never base64 bytes.
Component docs/contracts and the own-project handoff are updated. No web UI,
management routes, host API, deployment or new profile shape changed in B.

**Checks:** typecheck passes; 31 image/storage/migration/message tests and 12
existing workspace-gate tests pass (43 total). One real encrypted-home test
skips here for missing FUSE; CI's `LYRICA_SANDBOX_TESTS=require` requires it.
Fakes are shared in `core/test/fake-images.ts`; no sockets. Run the full suite
on the supervisor host. No real ComfyUI has been exercised.

**Next:** C only: authenticated owner-checked file serving, photo/policy
management routes, Chromium deployment and the offline render command/test.
The shared ImagePart is ready for the separate Web UI thread.

**Open:** current recipes/router have no speed-tier metadata, so host fast and
quality share the image.create list and defaults. If use needs separation,
propose exposing a recipe's supported tier as capability metadata and filtering
the existing ordered list, rather than changing profiles. Portrait consent uses
server-local midnight because there is no per-user time-zone setting.
