# Brief: Custom ComfyUI workflows

**Status:** Building. **Thread:** Add custom ComfyUI workflow editing.
**Branch:** `claude/project-thread-kocpz1`.

**Read first:** AGENTS.md, DESIGN.md ("Local images", "Image models are
recipes"), `host/README.md` (Images), `host/API.md` ("Image models"),
docs/ux.md ("Image models, recipes and parts").

## Goal

A person who manages a model host can add an image or video workflow they
built in ComfyUI, adjust it by hand, and use it as an image model like any
other. They can also copy a built-in workflow and change the copy. Serves
principle 1 (better images through the same tool) while keeping the host's
containment: Lyrica herself still never writes a workflow, and ComfyUI still
runs only the custom nodes pinned in its image.

The operator chose (2026-11-07): import, a form editor, a raw JSON editor,
copy to edit, images and videos, and missing custom nodes added only by a
reviewed pull request that pins them (no install from the app).

## How it works

- **Import.** ComfyUI's **Export (API)** file (node id → `class_type`,
  `inputs`) is pasted or chosen on Download image model's **Workflow**
  source. The host turns it into a draft, without saving anything:
  - its save and preview nodes become the host's websocket outputs
    (`SaveImageWebsocket`, `SaveVideoWebsocket`); any other node that writes
    files is refused;
  - the standard loaders (one checkpoint or diffusion model, one or two text
    encoders, a VAE, model-only LoRAs) become the recipe's parts, matched to
    this host's files by file name, so Change, Add part and LoRAs for one
    job work as on any recipe. Anything else stays in the workflow and
    loads its own files (`loaders: "template"`), matched the same way;
  - it guesses the blanks: the sampler's positive and negative text become
    `$prompt` and `$negativePrompt`, seeds `$seed`, the first sampler's
    steps, CFG, sampler and scheduler, the empty latent's size and batch
    (`$count`, or `$frames` for a video), image loaders `$image`,
    `$reference1…`, `$mask`. The values it replaced become the recipe's
    defaults; the prompt text itself is dropped.
- **Edit.** The **Edit workflow** page shows the draft or a saved custom
  workflow: what it does, the parts it found, and a row per node input with
  **Fixed** or a blank. **JSON** shows the same workflow as text. The host
  checks every save: known blanks only, links that resolve, an output, no
  file-writing node, every image loader a blank, and the blanks its action
  needs.
- **Copy to edit.** A built-in recipe's **Copy workflow to edit** makes a
  custom copy of its template and a recipe on it, then opens the editor.
- **Where it lives.** Per host, in its data folder (`workflows/`), next to
  `recipes.json`; it moves with the host, not the repository. Only the
  host's managers add or change one: an administrator on a shared host, the
  owner on a private one. Deleting its last recipe deletes it.
- **Nodes.** The host keeps the node list ComfyUI reported the last time it
  ran (`comfy-nodes.json`). A workflow naming a node type not on it saves,
  but its recipe says which nodes it needs and does nothing until a host
  update brings them. The editor lists them with **Copy request**: text to
  give Lyrica or a pull request, which adds each node to
  `host/comfyui/Dockerfile` at a reviewed commit.

## In scope

1. Host: `host/src/workflows.ts` (import, check, store), routes under
   `/host/v1/workflows`, the node list cache, recipe readiness and
   `describe` for custom templates.
2. Core: the routes passed on through `manage`, rediscovery after a change.
3. Web: Workflow source, Edit workflow page, Copy workflow to edit and Edit
   workflow on a recipe's host block.
4. Docs: DESIGN.md, host/API.md, host/README.md, docs/ux.md,
   docs/contracts.md, docs/guides/model-hosts.md.

## Out of scope

Upscale and motion workflows, and continuations (a custom video is one
clip); ComfyUI's UI-format files (only API format); installing nodes from
the app; sharing a workflow between hosts (export and import it again);
Lyrica proposing workflows.

## Handoff note

(Filled in as the work lands.)
