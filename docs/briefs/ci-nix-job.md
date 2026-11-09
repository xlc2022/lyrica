# Brief: a shorter nix job

**Status:** Built, in review.

**Branch:** `claude/project-thread-5aac8y-nix`. **Asked for:** by the
operator, 2026-11-09, after [ci-e2e-matrix.md](ci-e2e-matrix.md) left the
nix job as CI's longest.

**Serves:** principle 8 (budgets): a pull request pays the nix job's time
on every push.

## Problem

The nix job took 6 min 20 s: about 50 s of setup (Nix, apt, `npm ci`),
1 min 54 s restoring the Nix store from GitHub's cache, 1 min 06 s for
`nix flake check` (which rebuilds the lyrica package on every code change),
2 min for the sandbox tests with the NixOS tools, and 16 s to root the
builds and collect garbage.

The cache is 4.7 GB compressed and it is real content: the sandbox toolset
(Chromium, gcc, Python and its libraries, ffmpeg, Node, Claude Code,
Codex), the NixOS system the flake check builds, the kernel headers for
the GPU unlock module, the lyrica package and the inputs the flake check
would otherwise refetch. Every run needs nearly all of it, so shrinking it
was not the lever. The restore's spread (1 to 6 minutes across runs) is
GitHub's cache backend; 1:54 is the normal case.

## Change

1. The flake check and the sandbox tests run side by side in one step: the
   check in the background (CPU-bound, the web build), `npm ci` and the
   tests in the foreground (mostly waiting on sandboxes and network
   timeouts). The check's log goes to a file and is printed in a log group
   when it ends, so the two outputs don't interleave; the step fails if
   either failed, naming which. Two nix commands share the daemon's locks,
   so nothing builds twice. Expected: about a minute off the job.
2. The profile keeps the 3 newest generations of builds instead of 10
   (the operator's choice). On a hosted runner the profile is new every
   run, so this matters on a self-hosted runner, where it bounds the store.

Out of scope, offered and left to the operator: running only the two
NixOS-specific sandbox tests in this job (another 1.5 min, but it drops
the end-to-end check of the sandbox with the module's toolset).

## Docs

docs/ci.md (the nix job's description and the generation count).

## Handoff

Done: the overlap, the generation count, the docs. Next: PR review, then
record the measured time here. Open questions: the sandbox-test scope,
with the operator.
