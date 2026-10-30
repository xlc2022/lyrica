# Brief: GLM 5.3 Flash as a starter

**Status:** In review.

Owner: the "Add GLM 5.3 Flash" thread. Tests: on the development
deployment's host with two RTX PRO 6000 Blackwell cards (102 GB each).

## Why

DESIGN ("Models and endpoints") names GLM 5.3 Flash as one of the models
Lyrica runs on; until now only through the cloud. On a local host it can
serve sensitive work too, which principle 2 settles by where the model
runs, and the operator asked for it on the two-card Blackwell host
(principle 1: a model she talks with this month).

## The model

Z.ai's GLM 5.3 Flash: a mixture of experts of about 320B parameters with
18B active per token, hybrid attention, a vision tower, MIT licence.
llama.cpp reads it as `glm5-next`.

| Unsloth quant | Files | Size | Fits two 96 GB GPUs? |
|---|---|---|---|
| UD-Q2_K_XL | 4 | 108.7 GB | yes, with room to spare |
| UD-Q3_K_XL | 4 | 147.5 GB | yes, about 40 GiB left for context |
| UD-Q4_K_XL | 6 | 199.7 GB | no: needs system RAM (out of scope) |

The starter is **UD-Q3_K_XL** with `mmproj-F16.gguf`, from
`unsloth/GLM-5.3-Flash-GGUF` at `a38483c8cd5df544f53d70fb281afe97369d5ab6`:
the largest that runs wholly on the GPUs. The host checks each file's
SHA-256 against the hub's as it downloads.

## What

1. **The starter.** A row in the dashboard's text starters: GLM 5.3 Flash,
   llama.cpp, its four parts and projector, needing 160 GiB of GPU memory.
   The library already takes a split GGUF once every part is here, and
   finds the projector at the repository's root.
2. **The fit check.** The dashboard said a starter was too big when it was
   bigger than the largest GPU. llama.cpp splits a model over every GPU
   that allows it (placement.ts), so for llama.cpp starters it now counts
   those GPUs together; other servers still use one GPU.

## Out of scope

- Spilling into system RAM, for this model's Q4 or any other: its own
  thread ("Let models spill into system RAM").
- A vLLM starter (an FP8 copy is about 320 GB).

## Open

- Whether llama.cpp b11960 (the host's pinned build) loads Unsloth's
  GGUFs of this architecture, and whether the host's KV estimate is right
  for its hybrid attention. Checked on the host once the download ends.

## Handoff

Done: starter, fit check, docs. Download started on the development
host through its paired Lyrica. Next: load it there, check the load
log and the context the host picks, and record the result here.
