# Brief: prebuilt CMP images for the model host

Owner: the Agent loop thread (which built #466).
Tests: the danube thread, on danube.

## Why

A host with a CMP 100-210 builds llama.cpp and stable-diffusion.cpp from
source (`compose.cmp.yaml`, `compose.sdcpp.yaml`, #466). On danube, a
4-core i5-4590, the cold builds took 25 minutes (llama.cpp) and 18 minutes
(sd-server). `install.sh` runs `docker compose build` on every install and
update, so any change to either Dockerfile, or a lost build cache, means
that wait again. An image built elsewhere and copied in doesn't help:
`docker load` brings no build cache, so the build runs anyway.

The CMP is cheap, so hosts with weak CPUs and several of these cards are
likely. They should download the two images, not compile them.

## What

1. **Published images.** A workflow builds `host/llamacpp/Dockerfile` and
   `host/sdcpp/Dockerfile` on GitHub's hosted runners (the repository is
   public, so the minutes are free) and pushes them to the GitHub Container
   Registry as public packages: `ghcr.io/<owner>/lyrica-host-llamacpp` and
   `ghcr.io/<owner>/lyrica-host-sdcpp`. The registry and namespace are one
   setting (`host/prebuilt.sh`), so moving to another registry, such as a
   Forgejo instance's, is a one-line change. llama.cpp is built for one
   fixed `CUDA_ARCHS` list that covers the CMP and the NVIDIA cards a host
   is likely to pair with it (`70-real;75-real;80-real;86-real;89-real;120-real`);
   sd-server runs on the CMP alone, so it is built for `70-real`.
   The workflow runs on pushes to `main` that change either folder, and on
   pull requests as a build-only check, the way `host-images.yml` checks
   ComfyUI now.
2. **Tags the host can work out.** Each image is tagged with a hash of
   what goes into it: its Dockerfile, its build arguments (the tag and
   commit it pins, the `CUDA_ARCHS` list) and the base images' digests.
   `install.sh` computes the same hash from its own checkout. Then a host
   always asks for the image that matches the code it runs, with no
   registry lookup and no file for CI to commit back.
3. **Pull first, build as the fallback.** On a CMP host, `install.sh`
   pulls the matching tags when every GPU's compute capability is in the
   published list, and writes them into `.env` so the compose files use
   `image:` instead of `build:`. If the pull fails (offline, an
   unpublished commit, a capability outside the list), it builds from
   source as it does today, and says which and why in one line. The
   updater (`update.sh`) gets this for free, since it runs `install.sh`.
4. **Same trust as today's stock images.** Each image carries labels with
   its content hash and source commit, and `install.sh` refuses a pulled
   image whose hash label doesn't match the one it computed. Nothing is
   signed beyond what GHCR and the repository's own CI give, the same
   trust the host already places in the stock llama.cpp image.

## Out of scope

Prebuilt ComfyUI or speech images, building on the owner's machines
(Lunasa) instead of GitHub's runners, multi-architecture (arm64) images,
and any change to what the images contain or how they run.

## Checks

- The workflow builds both images and pushes them on `main`; a pull request
  only builds.
- `install.sh` tests (or a script check in CI's host-stack job): a matching
  tag is pulled, not built; a missing tag or an unlisted capability falls
  back to a build with a one-line reason; the hash changes when the
  Dockerfile or a build argument changes.
- On danube: from a clean Docker cache, `install.sh --yes` finishes without
  compiling, and the text and Z-Image numbers in `cmp-100-210.md` still
  hold. Danube is shared, so the host stays paused, with its GPU free,
  outside the test.
- Docs: `host/README.md` (how a CMP host gets its images), the operator
  guide for deploying a model host, and `docs/ci.md` (the new workflow).

## Open questions

- Whether the wider `CUDA_ARCHS` list makes the llama.cpp image too large
  or too slow to build on a hosted runner. If it does, publish 70-real
  only and let mixed hosts build.

## Handoff

Built in the Agent loop thread's pull request: `host/prebuilt.sh` (the
registry, the lists, the tag and the pick), `.github/workflows/cmp-images.yml`,
`compose.cmp.build.yaml` and `compose.sdcpp.build.yaml` as the build
fallback, and `host/test/prebuilt.test.ts`. The first push to `main`
creates both packages as private; the owner makes them public once
(docs/ci.md, "CMP images"). Next: the danube test from a clean Docker
cache. Measured on danube (2026-10-22): its connection downloaded a 5 GB
model from Hugging Face at about 24 MB/s, so a 3.5 GB image takes about
2½ minutes, against 18–25 minutes to compile.
