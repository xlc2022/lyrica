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
  is its file (the first shard for split files); a safetensors model or a
  voice model is its folder. Lyrica gives each its own offering ID; the host has none.
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
| 400 | `need_repo` | A lookup for a model whose repository the host doesn't know. |
| 400 | `too_big` | Saved settings with a placement that can't fit even on empty GPUs. |
| 401 | `unpaired` | The client certificate isn't pinned, or was revoked. |
| 403 | `refused` | Not allowed: a pickle file, a delete outside the download record, a dashboard-only action. |
| 404 | `not_found` | No such model, recipe, download or file. |
| 409 | `in_use` | The model or file is in use by a running request, or a link is already downloading. |
| 409 | `above_recommended` | A stretch above the factor the model's card documents, saved without `anyway`. |
| 413 | `too_big` | The model can't fit on any GPU it may use, even with everything idle unloaded. |
| 503 | `paused` | The host is paused. Lyrica uses her fallbacks. |
| 503 | `busy` | It could fit, but not within the wait limit, because the GPU is busy. The message names what with: "The GPU is busy with a chat model." |
| 503 | `restarting` | A restart is under way. |
| 503 | `model_unavailable` | The server for this model (llama.cpp, vLLM, ComfyUI, stable-diffusion.cpp or the speech server) isn't running, didn't answer or couldn't load it. The host itself is up: its other models may still work. |
| 503 | `unavailable` | A part of the host itself isn't running, such as the download service. |
| 507 | `no_space` | Not enough free space for a download. |

## Priority

A request may send `X-Lyrica-Priority: chat`, `image` or `background`.
Each GPU has one queue, served in that order, then oldest first. `/v1`
defaults to `chat`. `/host/v1/images/*` always runs at `image`; the header
is ignored there. Lyrica sends `background` for sleep and cheap subagents.

A queued request waits at most 120 seconds (`chat`), 300 (`image`) or 900
(`background`) for room, then fails with `busy`.

## OpenAI-compatible: `/v1`

Only for a paired client: the dashboard gets `refused`. Passed to the
server holding the model (llama.cpp for GGUF, vLLM for a safetensors
folder, the speech server for a voice model), loading it first where its
placement says. Request and response bodies are passed
through unchanged, including streaming (`text/event-stream`) and tool calls.
A client that disconnects cancels its request, queued or running; an answer
the model server cuts short is cut short too.

- `GET /v1/models`: every model in the models folder (chat, embedding,
  dictation and voice), loaded or not, as `{ "object": "list", "data":
  [{ "id", "object": "model", "created", "owned_by": "lyrica-host" }] }`.
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `POST /v1/audio/transcriptions`: dictation, on a `transcribe` model
  (Whisper or Voxtral, on vLLM). OpenAI's `multipart/form-data`: `file`
  (the audio), `model`, and optionally `language` (`en`, `zh`; without it
  the model detects the language), `response_format` (`json` or `text`)
  and `temperature`. Up to 64 MB. The form is passed to vLLM unchanged;
  host-api reads `model`, checks that `file` is there, and for usage reads a
  WAV file's header. Answers `{ "text": "..." }`.
- `POST /v1/audio/speech`: her voice, on a `speak` model.
  `{ "model", "input", "voice", "speed"?, "response_format"? }`: `input` is
  1 to 4096 characters, `voice` one of the model's voices (an unknown one is
  `invalid`, naming some that exist), `speed` 0.25 to 4 (default 1), and
  `response_format` only `pcm`. Answers raw 16-bit little-endian mono PCM at
  24 kHz (`audio/pcm;rate=24000`), streamed: long text is read in parts at
  sentence breaks, and each part is sent as soon as it is made.

Both audio routes run at `chat` priority unless the request says otherwise.
Neither the audio nor the text is logged or kept; usage counts only the
seconds of audio.

## Status and control: `/host/v1`

### `GET /host/v1/status`

```json
{
  "name": "lyrica-blackwell",
  "version": "0.1.0",
  "commit": "<the commit it runs>",
  "update": { "available": true, "state": "idle" },
  "fingerprint": "<host key fingerprint>",
  "state": "running",
  "backend": "cuda",
  "servers": ["llamacpp", "vllm", "images", "speech"],
  "cpuServers": [],
  "gpus": [{
    "index": 0,
    "name": "NVIDIA GeForce RTX 3090",
    "pciId": "10de:2204",
    "vendor": "nvidia",
    "integrated": false,
    "settings": { "servers": ["llamacpp", "vllm", "images", "speech"], "keepFree": 536870912, "excluded": false },
    "vram": { "total": 25769803776, "used": 9663676416 },
    "models": [{
      "id": "lyrica/huggingface/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      "kind": "embedding",
      "state": "loaded",
      "gpus": [0],
      "pinned": true,
      "busy": false,
      "vram": 805306368,
      "lastUsed": "2026-10-09T10:00:00Z"
    }],
    "queue": { "chat": 0, "image": 1, "background": 2 }
  }],
  "downloads": { "active": 1 },
  "modelsFolder": { "path": "/srv/models", "free": 512110190592 },
  "problems": []
}
```

- `state`: `running`, `pausing` (finishing the current job), `paused` or
  `restarting`.
- `commit`: the commit `install.sh` installed (absent on a host installed
  before updates). `update`: its updater, as `POST /host/v1/update` says.
- `backend`: how the model servers reach the GPUs: `cuda`, `rocm`, `vulkan`,
  or `null` with no GPU. `servers`: what this host runs. A Vulkan host (AMD
  GPUs that ROCm doesn't support) runs `llamacpp` only, so vLLM models and
  image recipes can't be placed there. `cpuServers`: servers that run on
  the CPU here instead. The speech server runs voices on the CPU on a host
  without CUDA (ROCm, Vulkan, or no GPU), so there it is `["speech"]` and
  `speech` isn't in `servers`. A model on the CPU isn't listed under any
  GPU.
- `pciId`: the GPU's PCI vendor and device ID (`vendor:device`, lower-case
  hex), so a card that names itself as another model still shows what it
  is. Absent when the driver doesn't say.
- `integrated`: an integrated GPU (an APU). Its `vram` counts the shared
  system memory it can use (GTT) as well as its BIOS carve-out, and
  `vram.carveOut` (`{ total, used }`) gives the carve-out alone. Which a
  server can use:
  - llama.cpp on Vulkan: all of it.
  - llama.cpp on ROCm: all of it on an APU without a discrete GPU (unified
    memory); otherwise the carve-out.
  - vLLM and images: the carve-out only.

  Placements are planned and refused against what the server can use. On
  ROCm an integrated GPU allows `llamacpp` only by default. Beside a
  discrete GPU it is left out (`settings.excluded`) until it's included.
- `problems`: plain sentences about what the last pause or restart couldn't
  do, such as "GPU 0: couldn't unload … it may still hold memory." Empty
  when all went well.
- `settings`: what the GPU may run (`llamacpp`, `vllm`, `images`, `speech`), the
  bytes it always keeps free, and whether it is left out entirely (see
  GPUs below).
- A GPU lists every model on it, including one split over several GPUs
  (`gpus` names them all). A model's `kind` is `chat`, `embedding`,
  `image`, `transcribe` or `speak`; `state` is `loading` or `loaded`; `vram` is what it takes on
  this GPU, measured at load with this placement (keeping the larger saved value), then increased
  after its first attributable completed request to include buffers allocated
  on first use. The host compares GPU usage before and after the request only
  when no other model serves or loads/unloads during that interval; otherwise
  it retries on a later request. It keeps the larger measurement for eviction
  accounting; unmeasured models use their expected size, and vLLM uses its
  reserved memory share. A load-only API call does not count as a request.
- `queue` counts the requests waiting for this GPU; a request for a split
  model waits for all of its GPUs.
- `modelsFolder.path` is the folder on the host machine. `POST
  /host/v1/models-folder` changes it.

### Models

- `GET /host/v1/models`: the text and speech library, `{ "models": [...] }`
  with one entry per model file or folder:

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
    "contextLength": 32768,
    "maxContextLength": 40960,
    "parallel": 1,
    "sampling": { "temperature": 0.7, "topP": 0.8, "topK": 20 },
    "kvBytes": 4294967296,
    "stretch": null,
    "state": "unloaded",
    "gpus": null,
    "placement": { "mode": "auto" },
    "pinned": false,
    "vram": { "0": { "0": 7516192768 } }
  }
  ```

  - `server`: `llamacpp` (GGUF), `vllm` (a safetensors folder with a
    `config.json`) or `speech` (a voice model: see below). `kind` is
    `chat`, `embedding`, `transcribe` (Whisper or Voxtral, on vLLM) or
    `speak`.
  - `identity` comes from GGUF metadata (`general.basename`,
    `general.size_label`, `general.finetune`, `general.base_model.*`); any
    of it may be `null`. `card` is from the model card's `base_model` and
    `base_model_relation`, kept with a download; `null` for other files.
  - `capabilities` are what the host can tell from the file (the chat
    template's tool and thinking support, a vision projector next to it,
    pooling for embeddings). `reasoning` is `null` or the levels it takes:
    `["off", "on"]` when the template reads `enable_thinking`.
    `opensThinking: true` when the template writes `<think>` itself, so a
    reply can start mid-thought with only `</think>`.
    A `transcribe` model has `"transcribe": true`. A `speak` model has
    `"speak": { "voices": [{ "id": "af_heart", "language": "en" },
    { "id": "zf_xiaoxiao", "language": "zh" }] }`: the voices the speech
    server can read, English (`en`) and Mandarin (`zh`); a Mandarin voice
    also reads the English words in Mandarin text.
  - A voice model is a folder with an `.onnx` file (in it or in `onnx/`;
    `model.onnx` where there are several), its vocabulary in `config.json`
    or `tokenizer.json`, and `voices/*.bin`, one raw float32 array per
    voice: Kokoro's ONNX export. Its `contextLength` is `null`.
  - `contextLength` is the context it is served with: its setting, else,
    for a chat model, the largest that fits its GPUs once the host's other
    unpinned models are unloaded (in steps of 1024, from 4096), never more than the
    trained length times the stretch; 32768 when nothing fits or the
    trained length is unknown. A model keeps the context it loaded with
    while it stays loaded.
    `maxContextLength` is the trained length alone, `null` when the host
    couldn't read it. `kvBytes` is the KV cache at the served context, by
    the host's estimate (`null` for voices, and where it can't tell), and
    `stretch` is the YaRN factor, or `null`. Lyrica plans her context by
    `contextLength`. `parallel` is how many requests a chat model serves at
    once (see "Placement and serving settings"), `null` for other models; Lyrica sends it
    no more at once.
  - `sampling` is what the model's publisher recommends, which its server
    uses for a setting a request leaves out: a GGUF's `general.sampling.*`
    (`temp`, `top_p`, `top_k`, `min_p`, `penalty_repeat`), or a safetensors
    folder's `generation_config.json` (`temperature`, `top_p`, `top_k`,
    `min_p`, `repetition_penalty`). Only the values present; `null` when
    there are none. Lyrica shows them as the model's own and sends none of
    them.
  - A GGUF's companions are never models of their own: a vision projector
    (`mmproj` in its name) and an MTP draft (`mtp-…`, or anything in an
    `MTP` folder). A model finds them beside it or in its repository's
    folder one or two levels up: the projector F16 or BF16 first, the MTP
    file whose name is closest to its own. A projector picked in the
    model's settings (`mmproj` below) replaces the one its name matches.
    `capabilities.vision` is true while it runs with its projector
    (`vision` below).
  - `state`: `unloaded`, `loading` or `loaded`; `gpus` lists where it is
    loaded.
  - `vram`: bytes measured on each GPU, per placement it has been loaded
    with (keyed like `0`, `0+1:1,1` or `2@0.4`). Saving its settings
    forgets these, and it is measured again at its next load.
- `POST /host/v1/scan`: reads the models folder again (text models and image
  parts). Returns `{ "models": 12, "parts": 30, "proposals": 2 }`. The host
  also scans at start and after each download.
- Each of the four calls below answers with the model's entry.
- `POST /host/v1/models/load` `{ "model": "<id>" }`: loads it where its
  placement says, and waits until it is loaded. Errors: `too_big`, `busy`,
  `paused`, `refused` (a vLLM model that would need `trust_remote_code`).
- `POST /host/v1/models/unload` `{ "model": "<id>" }`: unloads it from all
  its GPUs; `in_use` while a request is running on it.
- `POST /host/v1/models/reload` `{ "model": "<id>" }`: applies its saved
  settings now, by unloading and loading it again; `in_use` while busy.
  A refused placement leaves the previous instance serving. If the new load
  fails after unloading, the host reverts the saved settings and attempts to
  reload the previous instance. It reports the original load error even if
  restoration fails. Nothing happens to a model that isn't loaded.
- `POST /host/v1/models/pin` `{ "model": "<id>", "pinned": true }`: a pinned
  model is loaded now, where its placement says, and kept loaded; it is
  never unloaded to make room. Pins survive a restart.

### Placement and serving settings

Each model has a placement and serving settings, kept in the host's data
volume. They apply at its next load, or at once with Reload. Save-time fit
checks subtract memory currently used by other programs (GPU usage minus
this host's loaded models) and the GPU's kept-free amount. Load refusal
messages include pinned, other-program and kept-free memory.

llama.cpp loads are confirmed through the router's `/models` status. A child
that fails to load returns `model_unavailable`. If a serving child disappears
and the router says the model is not loaded, the host returns a 503
`model_unavailable`, marks it unloaded, and loads again on the next request.

For vLLM chat, the host selects parsers from `config.json` family metadata:
Qwen2.5 uses `hermes` for tools; Qwen3.x uses `hermes` and `qwen3` for
reasoning. Llama 3.x families use `llama3_json`; Llama 2 and plain `llama`
receive no tool parser. Mistral/Mixtral uses `mistral`. DeepSeek uses
`deepseek_v3` for tools, with `deepseek_r1` for reasoning only when the
model name or family contains `r1`. Tool parsers enable automatic
tool choice. Unknown families receive no tool flags and report `tools: false`;
embeddings and dictation receive neither parser.

- `GET /host/v1/models/settings?model=<id>` answers
  `{ "model": "<id>", "settings": { ... }, "contextLength": 32768,
  "maxContextLength": 262144, "trainedContextLength": 262144,
  "kvBytes": 4294967296, "recommended": { ... } | null,
  "stretchUntested": false, "extras": { "vision": true, "mtp": "file" } }`:
  the context served, its maximum (the trained
  length times the stretch), the trained length (null when the host couldn't
  read it), the KV cache at the served context by the host's estimate, what
  the model's card recommends, and whether a stretch on this server is
  untested: true for any vLLM model until the pinned image carries the fix
  for vllm#58870 (vLLM 0.30 misreads the original context on Qwen3.5-style
  M-RoPE). `extras` says what `vision` and `mtp` can turn off: a vision
  projector, and an MTP file (`"file"`) or the model's own MTP layers
  (`"built-in"`, from `<arch>.nextn_predict_layers`), else `null`. A model
  never set has `{ "placement": { "mode": "auto" } }`. A llama.cpp chat
  model also has `projector` (the one it loads, or null),
  `matchedProjector` (the one its name matches), `projectors` (every file
  with `mmproj` in its name under the models folder, `{ path, size }`, its
  own folders first) and `origin` (`{ source, repo, revision }` from the
  download record, or null when the host didn't download it), where a
  missing projector or MTP file can be looked up with `hub/files` and
  downloaded beside it.
- `PUT /host/v1/models/settings` `{ "model": "<id>", "settings": { ... },
  "anyway": true }` saves them, whole, and answers with the model's entry. A
  stretch above the factor the card documents is refused
  (`above_recommended`, "Qwen documents 4.") unless `anyway` is true. A placement that
  can't work is refused (`invalid`, or `too_big` when it's about memory)
  with the reason, such as "GPU 2 doesn't allow vLLM.", "This model needs
  about 41.2 GB on GPU 0, which has 23.5 GB to give." or "A context of
  131072 tokens needs about 9.0 GB more than GPU 0 has; lower the context
  length."

`settings`:

```json
{
  "placement": { "mode": "gpus", "gpus": [0, 1], "split": [3, 1] },
  "contextLength": 32768,
  "kvCacheType": "q8_0", "flashAttention": "auto", "gpuLayers": 999,
  "parallel": 2, "batchSize": 2048,
  "chatTemplate": "{% for message in messages %}...{% endfor %}"
}
```

- `placement`:
  - `{ "mode": "auto" }`, the default: one GPU that has room without
    unloading anything (the largest first), else one where idle models can
    be unloaded, else split over every GPU that allows its server.
  - `{ "mode": "gpus", "gpus": [...] }`: these GPUs. For llama.cpp, several
    GPUs split by `split` ratios, each 0.01 to 1000 (default: each GPU's
    memory less what it keeps free). For vLLM, `"parallel": "tensor"` (matching GPUs, two, four
    or eight) or `"pipeline"`; by default tensor where the GPUs match, else
    pipeline.
- `contextLength`: 512 up to what the model was trained for, times its
  stretch. Unset by default: the host then serves a chat model at the
  largest context that fits (see `contextLength` under Models). Over it: "This model was trained for 262144
  tokens; with a stretch of 4 it serves 1048576 at most."
- `stretch`: `{ "type": "yarn", "factor": 4, "originalContext": 262144 }`,
  off unless set. The factor is 1 to 8 (whole for llama.cpp; 1 is no
  stretch and is not saved); the original context defaults to the trained
  length. Chat models only; one whose trained length the host couldn't
  read needs `originalContext`, which its maximum then multiplies. llama.cpp gets `rope-scaling = yarn`,
  `rope-scale` and `yarn-orig-ctx`; vLLM gets `--hf-overrides` with the
  model's own `rope_parameters` (or `rope_scaling`) and the YaRN fields
  merged in, and `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` for that server only.
- The fit check counts KV cache for the layers that hold one: `layer_types`
  entries for attention (not linear attention), else one in every
  `full_attention_interval`, else every layer; a GGUF's
  `full_attention_interval` the same way.
- llama.cpp only: `kvCacheType` (`f16`, `q8_0`, `q4_0`), `flashAttention`
  (`auto`, `on`, `off`), `gpuLayers` (0 to 999), `parallel` (requests
  served at once, 1 to 64; see below). A `q8_0` or `q4_0` KV cache needs
  `flashAttention` set to `on`. `vision: false` loads it without its
  projector (less memory, no images). `mmproj` is a projector picked by
  hand, a path from `projectors`, for a fine-tune whose name doesn't match
  its base's projector; it applies at the next load, and a path not in the
  models folder is refused. A projector of the wrong architecture fails when
  the model loads. `mtp: false` turns off drafting with
  MTP, which is on when the model has an MTP file or layers: llama.cpp gets
  `spec-type = draft-mtp`, `spec-draft-n-max` (`draftMax`, 1 to 6, 2 by
  default) and, for a file, `model-draft`. The fit check counts the
  projector and the MTP file while they are used.
- vLLM only: `memoryShare` (0.05 to 0.95 of each of its GPUs; by default
  what the model needs, in steps of 5%, so several vLLM models can share a
  GPU), `maxSeqs` (requests served at once, 1 to 1024; see below), `dtype`
  (`auto`, `bfloat16`, `float16`).
  The weights and the KV cache for the context must fit in the share of
  each GPU (`too_big` otherwise, saying to lower the context length or
  raise the share). A vLLM server that exits while starting fails its load
  at once (`model_unavailable`), rather than after the load timeout.
- Requests a chat model serves at once: `parallel` (llama.cpp) or
  `maxSeqs` (vLLM), else by the context it is served with: 1 below 200k
  tokens, 2 from 200k, 4 from 500k. They share one cache of the whole
  context (llama.cpp gets `kv-unified = true`), and the model list reports
  the number as `parallel`, which the daemon never exceeds.
- Both: `batchSize` (32 to 65536: llama.cpp's batch size, vLLM's batched
  tokens), `chatTemplate` (a Jinja template, at most 64 kB, used instead of
  the model's own).
- A setting for the other server, or one not listed, is `invalid`.

### Recommended settings

What a model's card recommends for its context, kept with the model:
`{ "native": 262144, "stretched": 1010000, "factor": 4,
"originalContext": 262144, "source": { "hub": "huggingface", "repo":
"Qwen/Qwen3.8-27B", "revision": "<sha>", "at": "<ISO time>" } }`; a card
with no recipe has `native` only. It is filled when a download from a hub
finishes, and on `POST /host/v1/models/lookup`
`{ "model": "<id>", "repo": "owner/name" }`, which answers like `GET
/host/v1/models/settings`. Without `repo`, the host reads the repository the
model was downloaded from, or the one its GGUF names
(`general.source.huggingface.repository`, `general.base_model.0.repo_url`);
with neither it answers `need_repo`. `repo` may be `modelscope:owner/name`
or a link. A hub token in `x-hub-token` is used only when `x-hub` names the
hub the lookup reads. The dashboard's Settings drawer for a chat model
has **Look up**, asking for the repository on `need_repo`, and its model
list shows each model's KV cache and stretch.

The fetch service reads the repository's `config.json` and `README.md`
(`POST /read`: at most 1 MB, returned as text, never written; `.md` is still
never downloadable). It takes `max_position_embeddings`, the first YaRN
block in the card and its first `-c N … --yarn-orig-ctx M` line, and, when
a quantization's card has no recipe, its `base_model`'s card one hop on.
Only the repository's name and revision leave the host.

### GPUs

- `PUT /host/v1/gpus/<index>`
  `{ "servers": ["llamacpp", "vllm", "images"], "keepFree": 536870912, "excluded": false }`:
  what the GPU may run, the bytes it always keeps free, or that it is left
  out entirely (a GPU kept for the display, for example). Every field is
  optional; the defaults are all the servers this host runs, 512 MiB, and
  not left out (left out for an integrated GPU beside a discrete one). A
  server the host doesn't run is `invalid`.
  `keepFree` must be less than the GPU's memory.
  Models it may no longer hold are unloaded first (`in_use` while a request
  runs on one). Answers `{ "settings": { ... } }`.
- A GPU can hold several models of any mix. A model split over several GPUs
  loads only when each has room, counts against each, and unloads from all
  at once.

### Pause, resume, restart

- `POST /host/v1/pause`: answers at once with `{ "state": "pausing" }`
  (pause, resume and restart answer only the state; Lyrica reads the status
  after).
  Queued and new requests get `paused` at once. The running jobs and any
  load under way finish, then every model is unloaded (vLLM's servers are
  stopped) and the state is `paused`: nothing of the host's stays in VRAM.
  Anything that couldn't be unloaded is listed in `problems`. Downloads
  continue. Survives a restart.
- `POST /host/v1/resume`: back to `running`; pinned models are loaded again,
  and others load on demand. Pause, resume and restart run one after
  another, never interleaved.
- `POST /host/v1/restart`: fails queued requests with `restarting`, unloads
  everything, asks each server to reset, and loads pinned models again.
- `POST /host/v1/update` with `{ "tag": "update/<name>" }` (a paired
  Lyrica, or the dashboard): asks the host's updater (README.md, "Updates") for that release, and answers `202`
  with `{ "update": … }`. `409 unavailable` when the host has no updater
  (NixOS, no systemd, or an install from before updates), with the reason;
  `409 updating` while one runs. `update` is `{ available, reason?, state,
  since?, tag?, error?, last? }`: `state` is `idle`, `requested`, `fetching`,
  `draining`, `building`, `rolling-back` or `failed`; `error` names the
  failed step (`fetch`, `drain`, `probation`, or a refusal such as `not on
  main`); `last` is the last update, `{ tag, commit, at, ok }`. While it
  updates the host pauses, restarts and, unless it was paused before,
  resumes. `changesFolder` is true when the updater also takes a models
  folder.
- `POST /host/v1/models-folder` with `{ "path": "/mnt/big/models" }` (a
  paired Lyrica, or the dashboard): asks the updater to move the host to
  that folder on the host machine (README.md, "The models folder"), and
  answers `202` with `{ "update": … }`. `400` for a path that isn't
  absolute or holds a control character; `409 unavailable` when the host
  has no updater or one without `changesFolder`; `409 updating` while one
  runs. While it moves, `update.models` is the folder asked for, and `state`
  goes through the same steps as an update; a refusal leaves `state`
  `failed` with `models` and `error`: `not a folder`, `a system folder`,
  `holds the host's own files`, `someone else can change it`, `its lyrica
  subfolder isn't a folder`,
  `drain`, `fetch` (the running commit wasn't in the updater's repository
  and couldn't be fetched) or `probation` (it went back to the old folder).
  `last` is then `{ models, commit, at, ok }`.
- After an unload, a server's process can take seconds to let go of its
  memory. Until a GPU has freed half of what the model held (30 s at most),
  a request that wouldn't fit there waits for it rather than failing with
  `too_big`, and a load that unloaded something to make room plans again
  once the memory is back.

### Usage

`GET /host/v1/usage`: counts since the host first started, per model. Never
prompts, results or who asked.

```json
{ "since": "2026-10-01T00:00:00Z",
  "models": [{ "id": "<model id or recipe id>", "requests": 120, "promptTokens": 50000,
               "completionTokens": 9000, "images": 0, "audioSeconds": 0, "seconds": 340.5 }] }
```

`audioSeconds` is the audio transcribed (from a WAV file's header; 0 for
other formats) or spoken.

## Downloads

Fetching is done by the host's `fetch` service. It is the only part of
the host that downloads, and nothing that sees prompts (host-api, the model
servers) has a route out.

- Sources: `huggingface`, `modelscope`, or `url` (https only).
- A gated repository's token travels in the `X-Hub-Token` header of the
  request that needs it. The host passes it to `fetch` for that request and
  never stores or logs it. It is sent only to that hub's own host
  (`huggingface.co` or `modelscope.cn`), never to a CDN it redirects to,
  and never with a link.
- Allowed files: `.gguf`, `.safetensors` and `.onnx`, plus the small files
  a model folder needs (`.json`, `.txt`, `.jinja`, `.model`, `.tiktoken`).
  Pickle formats (`.bin`, `.pt`, `.pth`, `.ckpt`, `.pkl`, `.pickle`) and
  code (`.py`) are refused, as is anything else. The one exception is a
  voice model's voices, `voices/<name>.bin`: plain float32 arrays the
  speech server reads as numbers. Once downloaded, a voice that is a
  pickle, a zip or not whole 4-byte numbers is deleted, as is an `.onnx`
  file that doesn't start like one.
- Each file goes to `lyrica/<source>/<repo>/<path>` (for a link,
  `lyrica/url/<hostname>/<file name>`) in the models folder. It downloads
  under a temporary name, is checked against the hub's SHA-256 (or the one
  given with a link), and only then gets its real name. A link without a
  checksum is kept but marked unverified. A wrong checksum leaves nothing
  behind.
- Addresses, redirects included, must be public: loopback, private,
  link-local, CGNAT and tailnet ranges, and multicast are refused; for
  IPv6, only global unicast is allowed.
- A link must say its size (`Content-Length`), and free space is checked
  against it and every download already queued. No download is written past
  its size. A link's query string is kept in memory for the transfer only
  and never recorded; while the link downloads, its `url` shows it in full.
- A link is at most 1024 characters, https, with no user name or
  password, and only one downloads at a time (`in_use` otherwise).
- **Known channel.** A paired client can still carry data out of the host
  in a link's path or query: a little at a time, one link at once, and
  each shown in full on the dashboard's Downloads. These limits make it
  slow and visible, not impossible.
- A file must be what its name says (a GGUF header, a readable safetensors
  header) before it appears.
- A sharded model is offered once all its shards are here.

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

Every call here is open to any paired client, including installing,
confirming and deleting. The host doesn't know who is behind a client:
lyricad decides which of these only an administrator may ask for.

### Parts

`GET /host/v1/parts`: every image model file found in the models folder,
as `{ "parts": [...] }`, each entry like this:

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
- Architectures with templates: `sdxl` and `flux` (a checkpoint, or
  diffusion model, encoders and VAE), `z-image`, `qwen-image` (create, and
  edit for a diffusion model whose file name says "edit"), and `seedvr2`
  (upscale).

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
  "useFor": "both",
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
- `useFor`: `fast`, `quality` or `both` (default). An optional field in
  `recipes.json`; an older recipe without it reads as both. Copies keep the tag.
  Lyrica's router filters create tiers by this tag; the host keeps recipe defaults.
- `added`: a VAE or text encoder used instead of the checkpoint's own.
- `base`: the recipe this one was copied from, if any.
- `starter`: the starter recipe it came from, if any.

Calls:

- `GET /host/v1/recipes?state=proposed`: all recipes, or those in one
  state, as `{ "recipes": [...] }`.
- `GET /host/v1/recipes/<id>`
- `GET /host/v1/starters`: the starter recipes shipped with the host, each
  with its parts' files and checksums and which are present.
- `POST /host/v1/starters/<starter>/install`: downloads the missing parts
  (as `POST /host/v1/downloads`, with `X-Hub-Token` if needed) and creates
  the recipe as `confirmed`; it becomes `ready` when they finish. Answers
  `{ "recipe": <recipe>, "downloads": [<download>] }`. Installing it again
  answers with the same recipe, downloading only the parts neither here
  nor already downloading.
- `POST /host/v1/recipes/<id>/confirm`, `POST /host/v1/recipes/<id>/ignore`:
  for proposals. One already in that state answers as it is, so a retry is
  harmless; another state is `invalid`. Several at once:
  `POST /host/v1/recipes/confirm` or `/ignore` with
  `{ "ids": ["<id>", ...] }`, each handled on its own; answers
  `{ "recipes": [<recipe>], "failed": [{ "id": "<id>", "message": "..." }] }`.
- `POST /host/v1/recipes/<id>/download-parts`: downloads the missing parts
  it knows the source of.
- `POST /host/v1/recipes/<id>/copy` `{ "name": "Z-Image Turbo, watercolour" }`:
  saves a copy, in the same state as its source, with `base` set to `<id>`. Lyrica copies before
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
    defaults. Each must be one a request could give (the ranges below;
    `shift` 0 to 20, `guidance` 0 to 30, `sampler` and `scheduler` ComfyUI
    names, `negativePrompt` at most 4096 characters);
  - `{ "op": "rename", "name": "..." }`;
  - `{ "op": "useFor", "useFor": "fast" }`: `fast`, `quality` or `both`,
    saved in `recipes.json`.

  Answers with the recipe.
- `DELETE /host/v1/recipes/<id>`: deletes the recipe and the parts it used
  that are in the download record, unchanged, and used by no other recipe.
  Answers `{ "deleted": ["<path>"], "kept": [{ "file": "<path>", "reason":
  "Used by Z-Image Turbo, watercolour." }] }`. Other reasons: "Not
  downloaded by the host." and "Changed since it was downloaded."

### Making images

All three answer `{ "images": [{ "png": "<base64>", "width": 1024,
"height": 1024, "seed": 1234 }], "seconds": 6.2 }`. Input images are base64
PNG, JPEG or WebP, at most 20 MB each and, by their header, at most 8192
pixels a side and 36 megapixels. Any field not listed is `invalid`.
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
  of 16 from 256 to 2048. `steps` is 1 to 150, `cfg` 0 to 30, `seed` 0 to
  2^48 (random when left out; every image of one request shares it).
  `references` only for a template that takes them (otherwise `invalid`).
- `POST /host/v1/images/edit`: as create without `width` and `height`, plus
  `"image": "<base64>"` and an optional `"mask": "<base64>"` (its white
  part is changed). The result follows the image's shape, at about one
  megapixel. Up to two `references` for Qwen-Image-Edit.
- `POST /host/v1/images/upscale`

  ```json
  { "recipe": "<id>", "image": "<base64>", "scale": 2, "maxSize": 4096,
    "colorMatch": "lab", "seed": 1234 }
  ```

  `scale` (1 to 4) multiplies the shorter side; `maxSize` (256 to 8192)
  caps the longer one; `colorMatch` is
  `lab`, `wavelet`, `wavelet_adaptive`, `hsv`, `adain` or `none`. Defaults
  come from the recipe.

For upscale, the shorter side's target (`scale` times the shorter side) is
capped at 4096.

A client that closes its connection cancels its job, queued or running. A
job that fails, times out (30 minutes) or is cancelled is interrupted in
ComfyUI and removed from its queue.

Prompts and images exist only in memory for the job: ComfyUI's folders are
`tmpfs`, metadata saving is off, uploaded images are overwritten with a
blank one and its history is cleared after each job. ComfyUI itself has no
authentication: anything on the `models` network could call it, which is
why only the model servers are there and none of them has a route out.

On a host whose image GPU is a CMP 100-210, stable-diffusion.cpp makes the
images instead (README.md, "Image models"): create only, for Z-Image,
Qwen-Image, FLUX and SDXL recipes without LoRAs. The recipe list says so:
`does` holds only `create`, or is empty with an `unsupported` reason for a
recipe it can't run. A job for one is `invalid`, saying why. `sampler` and `scheduler` take the nearest sd.cpp names, or its
defaults. Each image of a batch is made from the next seed, and says so. A
cancelled job is cancelled in sd-server.

A recipe's memory is measured after its first job, as for text models.
