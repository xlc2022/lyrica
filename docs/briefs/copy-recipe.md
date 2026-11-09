# Brief: Copy an image model to another host

**Status:** In review.

**Read first:** host/API.md "Copying a model to another host", "Uploads"
and "Custom workflows"; docs/ux.md §6 "Image models, recipes and parts".

## Goal

The user has a model set up on one host (a recipe with its parts, LoRAs and
strengths, settings, maybe its own workflow) and wants the same model on
another host without rebuilding it by hand. Principle 3: the user's own
machines do the work; principle 6: fetch stays the only writer of `lyrica/`.

## Design

- **Where:** **Copy to host…** at the foot of a confirmed model's host
  block, beside Edit workflow, while the user manages another host.
- **Dialog:** the target plans the copy (`check`): which files it has
  already, which it downloads again from their hub, which are copied from
  the source, and which it can't get; Copy (<GB>).
- **Files:** a file the target has (same path, recorded checksum, or name
  and size) is used where it is; a hub file downloads to its usual path;
  any other GGUF or safetensors file is carried by lyricad from the source
  (`GET /host/v1/parts/content`, 32 MiB a read) into the target's uploads
  (`lyrica/upload/<name>`). Hosts never call each other.
- **Recipe:** made confirmed at once with `copiedFrom`, its parts, LoRAs and
  custom workflow's file names pointing where the files will be; ready once
  they arrive. Copying again answers the same recipe and fetches only what
  is missing, which also resumes a stopped carry.

## Out of scope

- Lyrica's `models` tool copying models (the app only, for now).
- Resuming a carry by itself after lyricad restarts: copy again.
- Text models (downloads and uploads already cover them).

## Handoff notes

**Done (2026-11-09):** host export, import and part reads
(host/src/recipe-copy.ts, images.ts), lyricad `copyRecipe` and the carry
(core/src/models), the dialog and Downloads words (web). Tests:
host/test/workflows.test.ts "copies a model…", daemon/test/daemon.test.ts
"copying an image model…", e2e "Copy to host…".

**Next:** both hosts need updating; test lunasa → mystria on real files.
