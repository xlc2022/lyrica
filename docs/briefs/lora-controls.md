# LoRAs for one call, and their strength

**Status:** built on `claude/project-thread-5qvkhr`, one PR for both steps.

The owner asked (2026-10-30) for a review of how LoRAs are added to
ComfyUI images and clips and how their strength is set, and to be able to
tell Lyrica in chat to apply a LoRA at a strength if it is in the library.
Until now a LoRA lived only inside a recipe (DESIGN.md, Image models), so
asking for one in chat did nothing. This serves principle 1: the user's
own LoRAs work the way they ask for them.

## What was there

- **Image models:** Add part adds a LoRA with a strength (0 to 1.5), by
  default into a copy "<model> + <LoRA>"; a LoRA can be removed. Its
  strength shows but can't be changed, though the host has `setLora`.
- **The `image` tool** had no LoRA field and never saw which LoRAs exist.
- **Matching:** a Wan LoRA read as `wan` and never fitted Wan 2.2 5B; the
  14B two-expert recipes refused any LoRA but their own speed ones; a
  Qwen-Image 2.1 LoRA read as Qwen-Image's (or nothing); stable-diffusion.cpp
  hosts refuse LoRAs.

## What changes

1. **LoRAs for one call** (host, core, the `image` tool; PR review):
   - Each host recipe lists `takesLoras`, the LoRA files on its host whose
     architecture fits it. Create, edit and video jobs take
     `loras: [{ file, strength }]` from that list, for that job only
     (host/API.md, "LoRAs for one job"). On two experts a LoRA goes onto
     both, or onto the one a `high` or `low` LoRA was made for; a recipe
     with two experts can now also keep a LoRA of its own.
   - Wan 2.2 5B LoRAs read as `wan2.2-5b` by their width; `wan` LoRAs fit
     the 14B and SCAIL-2 recipes; a Qwen-Image 2.1 LoRA reads as
     `qwen-image-2.1` by its trainer metadata or file name.
   - The tool's `loras: [{ name, strength }]` (create, edit, video,
     animate) matches names loosely; models that take them all go first;
     any model passed over for lacking one is said; the result says which
     LoRAs at which strength; a name none takes fails with the list. The
     field's description lists the LoRAs there are.
2. **Strength in Image models** (web; UI review): each LoRA row in an open
   model gets a typed Strength (-4 to 4, max shown, clamped) saved with
   `setLora`; Add part's Strength takes the same range, and its LoRA list
   is the recipe's `takesLoras`.

## Out of scope

- An enable list or trigger words per LoRA: the owner reads the library as
  every LoRA on the hosts. The personal LoRA (`personal-lora.md`, shelved)
  would need its own rule before it joins.
- LoRAs on stable-diffusion.cpp hosts.

## Handoff

- Done: both steps (tests in host/test/images.test.ts, core/test/images.test.ts,
  extension/test/images.test.ts, and the Image models e2e in web/e2e/web-admin.spec.ts).
- Next: try a real LoRA on the GPU host once merged.
- Open: a LoRA for one job isn't in the recipe's scheduler size (its first
  measured job sets it); watch VRAM on the first real Wan 14B LoRA run.
- Open: a LoRA's tensor names alone can't tell Qwen-Image 2.1 from
  Qwen-Image; one trained without metadata and named otherwise reads as
  `qwen-image`.
