# Model host API

What a paired Lyrica server can call on a model host. Pairing and the TLS
checks are in [PAIRING.md](PAIRING.md); everything here needs a pinned
client certificate unless it says otherwise.

- Base: `https://<address>:7236`, TLS 1.3, mutual TLS.
- Bodies are JSON (`Content-Type: application/json`) unless stated.
  Unknown fields in a request body are refused with `invalid`.
- Sizes are bytes. Times are ISO 8601 UTC strings.
- **Model IDs** and **file paths** are paths relative to the models folder,
  with `/` separators, exactly as on disk:
  `lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf`. A GGUF model
  is its file (the first shard for split files); a safetensors text model is
  its folder. Lyrica gives each its own offering ID; the host has none.
- Nothing the host returns or logs contains prompt or result text, except
  the result of the request that asked for it.

## Errors

```json
{ "error": { "code": "paused", "message": "The model host is paused." } }
```

`message` is a plain sentence that can be shown as is. The same shape is used
on `/v1`, where OpenAI clients read `error.message`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid` | A malformed request, unknown field or bad value. |
| 401 | `unpaired` | The client certificate isn't pinned, or was revoked. |
| 403 | `refused` | Not allowed: a pickle file, a delete outside the download record, a dashboard-only action. |
| 404 | `not_found` | No such model, recipe, download or file. |
| 409 | `in_use` | The model or file is in use by a running request. |
| 413 | `too_big` | The model can't fit on any GPU it may use, even with everything idle unloaded. |
| 503 | `paused` | The host is paused. Lyrica uses her fallbacks. |
| 503 | `busy` | It could fit, but not within the wait limit, because the GPU is busy. The message names what with: "The GPU is busy with a chat model." |
| 503 | `restarting` | A restart is under way. |
| 503 | `unavailable` | The server for this model isn't running or didn't answer. |
| 507 | `no_space` | Not enough free space for a download. |

## Priority

A request may send `X-Lyrica-Priority: chat`, `image` or `background`.
Each GPU has one queue, served in that order, then oldest first. Defaults:
`chat` for `/v1`, `image` for `/host/v1/images/*`. Lyrica sends `background`
for sleep and cheap subagents.

A queued request waits at most 120 seconds (`chat`), 300 (`image`) or 900
(`background`) for room, then fails with `busy`.

## OpenAI-compatible: `/v1`

Passed to the server holding the model (llama.cpp for GGUF on a shared GPU,
vLLM on a vLLM GPU), loading it first if needed. Request and response bodies
are passed through unchanged, including streaming (`text/event-stream`) and
tool calls.

- `GET /v1/models`: every text and embedding model in the models folder,
  loaded or not, as `{ "object": "list", "data": [{ "id", "object": "model",
  "created", "owned_by": "lyrica-host" }] }`.
- `POST /v1/chat/completions`
- `POST /v1/embeddings`

## Status and control: `/host/v1`

### `GET /host/v1/status`

```json
{
  "name": "lyrica-blackwell",
  "version": "0.1.0",
  "fingerprint": "<host key fingerprint>",
  "state": "running",
  "gpus": [{
    "index": 0,
    "name": "NVIDIA GeForce RTX 3090",
    "vendor": "nvidia",
    "role": "shared",
    "vram": { "total": 25769803776, "used": 9663676416 },
    "models": [{
      "id": "lyrica/huggingface/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      "kind": "embedding",
      "state": "loaded",
      "pinned": true,
      "busy": false,
      "vram": 805306368,
      "lastUsed": "2026-10-09T10:00:00Z"
    }],
    "queue": { "chat": 0, "image": 1, "background": 2 }
  }],
  "downloads": { "active": 1 },
  "modelsFolder": { "path": "/srv/models", "free": 512110190592 }
}
```

- `state`: `running`, `pausing` (finishing the current job), `paused` or
  `restarting`.
- `role`: `vllm` (one vLLM model holds the GPU) or `shared` (llama.cpp
  models and ComfyUI, loaded on demand).
- A model's `kind` is `chat`, `embedding` or `image`; `state` is `loading`
  or `loaded`; `vram` is measured on its first load (`null` until then).
- `modelsFolder.path` is the folder on the host machine.

### Models

- `GET /host/v1/models`: the text library, one entry per model file or
  folder:

  ```json
  {
    "id": "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf",
    "kind": "chat",
    "server": "llamacpp",
    "format": "gguf",
    "size": 5027783488,
    "sha256": "<hex, or null when not downloaded by the host>",
    "downloaded": true,
    "identity": {
      "basename": "Qwen3", "sizeLabel": "8B", "finetune": null,
      "baseModels": [{ "name": "Qwen3 8B Base", "organization": "Qwen", "repoUrl": "https://huggingface.co/Qwen/Qwen3-8B-Base" }],
      "card": { "baseModel": ["Qwen/Qwen3-8B"], "baseModelRelation": "quantized" }
    },
    "capabilities": { "tools": true, "vision": false, "embedding": false, "reasoning": ["off", "on"] },
    "contextLength": 40960,
    "state": "unloaded",
    "gpu": null,
    "pinned": false,
    "vram": null
  }
  ```

  - `server`: `llamacpp` (GGUF) or `vllm` (a safetensors folder with a
    `config.json`).
  - `identity` comes from GGUF metadata (`general.basename`,
    `general.size_label`, `general.finetune`, `general.base_model.*`); any
    of it may be `null`. `card` is from the model card's `base_model` and
    `base_model_relation`, kept with a download; `null` for other files.
  - `capabilities` are what the host can tell from the file (the chat
    template's tool and thinking support, a vision projector next to it,
    pooling for embeddings). `reasoning` is `null` or the levels it takes.
  - `state`: `unloaded`, `loading` or `loaded`.
- `POST /host/v1/scan`: reads the models folder again (text models and image
  parts). Returns `{ "models": 12, "parts": 30, "proposals": 2 }`. The host
  also scans at start and after each download.
- `POST /host/v1/models/load` `{ "model": "<id>", "gpu": 0 }`: loads it
  (`gpu` optional; the host picks otherwise). Waits until loaded. Errors:
  `too_big`, `busy`, `paused`, `refused` (a vLLM model that would need
  `trust_remote_code`, or a GGUF model on a vLLM GPU).
- `POST /host/v1/models/unload` `{ "model": "<id>" }`: `in_use` while a
  request is running on it.
- `POST /host/v1/models/pin` `{ "model": "<id>", "gpu": 0, "pinned": true }`:
  a pinned model is loaded now and kept loaded; it is never unloaded to make
  room. Only on a `shared` GPU. Pins survive a restart.

### GPUs

- `PUT /host/v1/gpus/<index>` `{ "role": "vllm" | "shared" }`: changing a
  role unloads what's on the GPU first (`in_use` while a request runs on it)
  and drops its pins.

### Pause, resume, restart

- `POST /host/v1/pause`: answers at once with the status; the current job
  finishes, then everything is unloaded and the state is `paused`. Queued
  and new requests get `paused`. Downloads continue. Survives a restart.
- `POST /host/v1/resume`: back to `running`; pinned models are loaded again.
- `POST /host/v1/restart`: fails queued requests with `restarting`, unloads
  everything, asks each server to reset, and loads pinned models again.

### Usage

`GET /host/v1/usage`: counts since the host first started, per model. Never
prompts, results or who asked.

```json
{ "since": "2026-10-01T00:00:00Z",
  "models": [{ "id": "<model id or recipe id>", "requests": 120, "promptTokens": 50000,
               "completionTokens": 9000, "images": 0, "seconds": 340.5 }] }
```

## Downloads

Fetching is done by the host's `fetch` service, the only part of the host
with internet access.

- Sources: `huggingface`, `modelscope`, or `url` (https only).
- A gated repository's token travels in the `X-Hub-Token` header of the
  request that needs it. The host passes it to `fetch` for that request and
  never stores or logs it.
- Allowed files: `.gguf` and `.safetensors`, plus the small files a model
  folder needs (`.json`, `.txt`, `.jinja`, `.model`, `.tiktoken`). Pickle
  formats (`.bin`, `.pt`, `.pth`, `.ckpt`, `.pkl`, `.pickle`) and code
  (`.py`) are refused, as is anything else.
- Each file goes to `lyrica/<source>/<repo>/<path>` (for a link,
  `lyrica/url/<hostname>/<file name>`) in the models folder. It downloads
  under a temporary name, is checked against the hub's SHA-256 (or the one
  given with a link), and only then gets its real name. A link without a
  checksum is kept but marked unverified. A wrong checksum leaves nothing
  behind.
- Addresses, redirects included, must be public: loopback, private,
  link-local, CGNAT and tailnet ranges, and multicast are refused.

### `GET /host/v1/hub/files?source=huggingface&repo=Qwen/Qwen3-8B-GGUF&revision=main`

`revision` is optional (default `main`; `master` on ModelScope).

```json
{
  "source": "huggingface", "repo": "Qwen/Qwen3-8B-GGUF", "revision": "<commit sha>",
  "gated": false,
  "card": { "baseModel": ["Qwen/Qwen3-8B"], "baseModelRelation": "quantized" },
  "free": 512110190592,
  "files": [{
    "path": "Qwen3-8B-Q4_K_M.gguf", "size": 5027783488, "sha256": "<hex or null>",
    "allowed": true, "reason": null,
    "present": false, "fits": true
  }, {
    "path": "pytorch_model.bin", "size": 16000000000, "sha256": null,
    "allowed": false, "reason": "Pickle files can run code when loaded.",
    "present": false, "fits": true
  }]
}
```

`present` is true when that file is already in the download record (same
destination and checksum). `fits` compares its size with free space.
A gated repository without a valid token fails with `refused` and a message
saying a token is needed.

### `POST /host/v1/downloads`

```json
{ "source": "huggingface", "repo": "Qwen/Qwen3-8B-GGUF", "revision": "main",
  "files": ["Qwen3-8B-Q4_K_M.gguf"] }
```

or `{ "source": "url", "url": "https://...", "sha256": "<hex, optional>" }`.

Checks free space for the whole set first (`no_space`), then answers `202`
with `{ "downloads": [<download>] }`. A `refused` file refuses the whole
request.

A **download**:

```json
{ "id": "<uuid>", "source": "huggingface", "repo": "Qwen/Qwen3-8B-GGUF",
  "revision": "<commit sha>", "url": null,
  "path": "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf",
  "size": 5027783488, "received": 1200000000,
  "state": "downloading", "verified": null, "error": null,
  "startedAt": "...", "finishedAt": null }
```

- `state`: `queued`, `downloading`, `verifying`, `done`, `failed` or
  `cancelled`.
- `verified`: `true` (checksum matched), `false` (no checksum was given; the
  file is unverified), or `null` until done.
- Unfinished downloads resume after a restart. The token isn't kept, so
  a gated download interrupted by a restart fails with "Start this download
  again to give the token."; starting it again resumes the partial file.

### Other download calls

- `GET /host/v1/downloads`: all downloads, newest first, until cleared.
- `GET /host/v1/downloads/<id>`
- `DELETE /host/v1/downloads/<id>`: cancels an unfinished download and
  deletes its partial file, or clears a finished one from the list.

### The download record and deleting

- `GET /host/v1/files`: the download record, one entry per file fetch
  downloaded:

  ```json
  { "path": "lyrica/huggingface/...", "size": 5027783488, "sha256": "<hex>",
    "verified": true, "downloadedAt": "...",
    "source": "huggingface", "repo": "Qwen/Qwen3-8B-GGUF", "revision": "<sha>", "url": null,
    "card": { "baseModel": ["Qwen/Qwen3-8B"], "baseModelRelation": "quantized" } }
  ```

- `DELETE /host/v1/files?path=<path>`: deletes one file, only if it is in
  the record, inside `lyrica/` after resolving `..` and symlinks, and has the
  size and checksum it was downloaded with. A loaded model is unloaded first
  (`in_use` if a request is running on it). Answers
  `{ "deleted": "<path>", "unloaded": ["<model id>"] }`. Anything else is
  `refused`, with the reason: "Only files the host downloaded can be
  deleted.", "This file changed since it was downloaded.", or "That path is
  outside the host's downloads."

## Image models

Image models are **recipes** of **parts**. Lyrica names a confirmed recipe
and gives parameters; she never names parts, LoRAs or workflows.

### Parts

`GET /host/v1/parts`: every image model file found in the models folder.

```json
{ "file": "lyrica/huggingface/Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors",
  "size": 335304388, "format": "safetensors",
  "role": "vae", "slot": null, "arch": "flux", "precision": "bf16",
  "downloaded": true, "usedBy": ["<recipe id>"], "vram": null }
```

- `role`: `checkpoint` (holds its own encoders and VAE), `diffusion`,
  `text_encoder`, `vae`, `lora`, `upscaler` (a SeedVR2 DiT), or `unknown`.
- `slot`: for a text encoder, which one: `clip_l`, `clip_g`, `t5`,
  `qwen2.5vl`, `qwen3`, …; otherwise `null`.
- `arch`: the architecture read from the tensor names (`sdxl`, `flux`,
  `z-image`, `qwen-image`, `seedvr2`, …), or `null`. A file whose
  architecture has no template stays a file: it is listed but no recipe
  can use it.
- `precision`: `fp32`, `bf16`, `fp16`, `fp8`, or a GGUF quantisation such
  as `Q4_K`.
- Only the safetensors header (or GGUF metadata) is read, never the
  weights. Files are used where they are.

### Recipes

```json
{
  "id": "<uuid>",
  "name": "Z-Image Turbo",
  "state": "confirmed",
  "ready": true,
  "arch": "z-image",
  "template": "z-image",
  "does": ["create"],
  "parts": [
    { "role": "diffusion", "slot": null, "file": "lyrica/.../z_image_turbo_bf16.safetensors", "added": false },
    { "role": "text_encoder", "slot": "qwen3", "file": "lyrica/.../qwen_3_4b.safetensors", "added": false },
    { "role": "vae", "slot": null, "file": null, "added": false,
      "missing": { "source": "huggingface", "repo": "Comfy-Org/z_image_turbo",
                   "path": "split_files/vae/ae.safetensors", "sha256": "<hex>", "size": 335304388 } }
  ],
  "loras": [{ "file": "lyrica/.../style.safetensors", "strength": 0.8 }],
  "defaults": { "steps": 8, "cfg": 1.0, "sampler": "res_multistep", "scheduler": "simple",
                "width": 1024, "height": 1024 },
  "base": null,
  "starter": "z-image-turbo"
}
```

- `state`: `proposed` (found by a scan or made from a starter; does
  nothing yet), `confirmed`, or `ignored` (a proposal set aside; a scan
  won't propose it again).
- `ready`: every part is present. Only a confirmed, ready recipe runs.
- `does`: what it can be used for: `create`, `edit`, `upscale`.
- `added`: a VAE or text encoder used instead of the checkpoint's own.
- `base`: the recipe this one was copied from, if any.
- `starter`: the starter recipe it came from, if any.

Calls:

- `GET /host/v1/recipes?state=proposed`: all recipes, or those in one
  state.
- `GET /host/v1/recipes/<id>`
- `GET /host/v1/starters`: the starter recipes shipped with the host, each
  with its parts' files and checksums and which are present.
- `POST /host/v1/starters/<starter>/install`: downloads the missing parts
  (as `POST /host/v1/downloads`, with `X-Hub-Token` if needed) and creates
  the recipe as `confirmed`; it becomes `ready` when they finish. Answers
  `{ "recipe": <recipe>, "downloads": [<download>] }`.
- `POST /host/v1/recipes/<id>/confirm`, `POST /host/v1/recipes/<id>/ignore`:
  for proposals. Several at once: `POST /host/v1/recipes/confirm` or
  `/ignore` with `{ "ids": ["<id>", ...] }`.
- `POST /host/v1/recipes/<id>/download-parts`: downloads the missing parts
  it knows the source of.
- `POST /host/v1/recipes/<id>/copy` `{ "name": "Z-Image Turbo, watercolour" }`:
  saves a confirmed copy with `base` set to `<id>`. Lyrica copies before
  adding a LoRA unless the user chose to change the recipe itself.
- `PATCH /host/v1/recipes/<id>` with one change:
  - `{ "op": "swap", "role": "text_encoder", "slot": "t5", "file": "<path>" }`:
    the file must have the same role, slot and architecture;
  - `{ "op": "addPart", "role": "vae", "file": "<path>" }` (or a
    `text_encoder` with its `slot`): used instead of a checkpoint's own;
  - `{ "op": "removePart", "role": "vae", "slot": null }`: only an added
    part;
  - `{ "op": "addLora", "file": "<path>", "strength": 0.8 }`,
    `{ "op": "setLora", "file": "<path>", "strength": 1.0 }`,
    `{ "op": "removeLora", "file": "<path>" }`: the LoRA's architecture
    must match;
  - `{ "op": "defaults", "defaults": { "steps": 30 } }`: merged into the
    defaults;
  - `{ "op": "rename", "name": "..." }`.

  Answers with the recipe.
- `DELETE /host/v1/recipes/<id>`: deletes the recipe and the parts it used
  that are in the download record, unchanged, and used by no other recipe.
  Answers `{ "deleted": ["<path>"], "kept": [{ "file": "<path>", "reason":
  "Used by Z-Image Turbo, watercolour." }] }`. Other reasons: "Not
  downloaded by the host." and "Changed since it was downloaded."

### Making images

All three answer `{ "images": [{ "png": "<base64>", "width": 1024,
"height": 1024, "seed": 1234 }], "seconds": 6.2 }`. Input images are base64
PNG, JPEG or WebP, at most 20 MB each. Any field not listed is `invalid`.
A recipe that isn't confirmed and ready is `not_found`; one that doesn't do
the action is `invalid`.

- `POST /host/v1/images/create`

  ```json
  { "recipe": "<id>", "prompt": "...", "negativePrompt": "...",
    "width": 1024, "height": 1024, "count": 1,
    "steps": 8, "cfg": 1.0, "seed": 1234,
    "references": ["<base64>"] }
  ```

  Only `recipe` and `prompt` are required; the rest fall back to the
  recipe's defaults. `count` is 1 to 4. `width` and `height` are multiples
  of 16 from 256 to 2048. `references` only for a template that takes them
  (otherwise `invalid`).
- `POST /host/v1/images/edit`: as create, plus `"image": "<base64>"` and an
  optional `"mask": "<base64>"` (white is changed). Size defaults to the
  image's.
- `POST /host/v1/images/upscale`

  ```json
  { "recipe": "<id>", "image": "<base64>", "scale": 2, "maxSize": 4096,
    "colorMatch": "lab", "seed": 1234 }
  ```

  `scale` is 1 to 4; `maxSize` caps the longer side; `colorMatch` is
  `lab`, `wavelet`, `wavelet_adaptive`, `hsv`, `adain` or `none`. Defaults
  come from the recipe.

Prompts and images exist only in memory for the job: ComfyUI's folders are
`tmpfs`, metadata saving is off, and its history is cleared after each job.
