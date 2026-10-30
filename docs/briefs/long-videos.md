# Videos longer than one clip

**Status:** built (#690, #694); follow-up fixes on `claude/project-thread-5q2352`.

The owner asked (2026-10-30) for videos longer than a model's longest
clip. She asked MiniMax H3 for 16 s and hit the 15 s cap: one H3 clip is
4 to 15 s at 24 fps. Longer videos are made by chaining clips: each new
clip starts from the last ~22 frames (and their sound) of the one before,
anchored with H3's own `MiniMaxH3AddGuide` node, so motion and sound carry
across the join. This serves principle 1: she can make the video asked
for, on the operator's own hardware. It builds on [video.md](video.md).

## What changes

1. **Long videos through the same call.** `POST /host/v1/videos/create`
   takes a `duration` past the recipe's `maxSeconds`, up to its
   `longestSeconds`, when its template has a **continuation** workflow.
   The host splits the length into near-equal clips no longer than the
   continuation's `clipSeconds` (8 for H3: lunasa found a hard scene cut
   at 6.6 s inside a 15 s H3 clip, so shorter clips hold one shot better),
   makes the first as now, then each next one with the
   continuation workflow: the clip so far goes in, its last `overlap`
   frames and their sound anchor frame 0 of the new clip (the first of them
   is also the image H3's text encoder reads the prompt with, and the prompt
   is prefixed to say the shot goes on with no cut), the new clip's
   first `overlap` frames are dropped, and the rest is appended. One MP4
   comes back. The clips share one GPU hold and one progress, weighted by
   frames; each clip's seed is the next. Joining happens in ComfyUI (our
   `LyricaClipTail` and `LyricaJoinClips` nodes), which re-encodes the
   clip frame by frame, so no clip's frames are all held in memory and
   nothing is written to disk.
2. **Extend.** The same request with `extend`, an existing clip (an MP4
   of at most 64 MB, at the recipe's frame rate and a size it makes),
   adds `duration` seconds to it with continuation clips only, and
   answers with the whole clip. The image tool's new `extend` action
   takes the clip's path, a prompt and the seconds to add, and saves a
   new clip beside it.
3. **Real limits.** A recipe's listing has `longestSeconds`: its
   `maxSeconds`, or 60 with a continuation. Core reads it into the
   offering, refuses a longer request before calling the host, naming the
   model's longest, and the image tool's `duration` says the thread's
   Videos model's longest. A template without a continuation (Wan,
   LTX-2.5, SCAIL-2) refuses past its `maxSeconds` with that number. The
   recipe settings' duration field, if one is added, shows the max and
   clamps (docs/ux.md: numbers typed, max shown).

Only MiniMax H3 gets a continuation now
(`host/workflows/minimax-h3-continue.json`). A continuation file names
the template it continues and its overlap; it is not a template of its
own, so no recipe can pick it.

## Out of scope

- A "final" quality setting: the steps field belongs to the H3 thread.
- Reference to video (locking a person's look and voice across clips);
  it needs another large download. Later, once chaining works.
- Continuations for LTX-2.5 and Wan.

## Checks

- Host tests: the clip plan (16 s is three clips of 5 to 7 s; 60 s is
  nine), the continuation graph (tail, guide, join), the
  `extend` field's checks (size, frame rate, length), the refusal past
  `maxSeconds` without a continuation, and `longestSeconds` in the
  listing.
- Core tests: the offering's `longestSeconds` and `extend`, the refusal
  past it, and routing `extend` only to recipes that extend.
- A real run on the workstation (16 s, then an extend) after merge. The
  ComfyUI nodes (`host/comfyui/clip_chain.py`) are untested until then:
  this sandbox can't run ComfyUI. A scene-cut check (a jump in the mean
  frame difference) on the joined clip is a cheap way to judge it.

## Handoff

- Done: host (continuation template and nodes, clip plan, `extend`,
  `longestSeconds`), core (offering fields, routing, `firstVideoModel`),
  the image tool's `extend` action and per-model duration, docs.
- Next: PR review; the workstation run; a Duration field in the recipe
  settings beside Steps (#688), showing the recipe's longest.
