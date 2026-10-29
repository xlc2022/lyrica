# Brief: delegation folder guidance

**Status:** Merged in #309 (ba76098).

Issue: #300. Principles 1 (observed friction) and 2 (structural boundaries).

## Goal

A repository-reading delegation must not be led to put a sandbox checkout
path in `folders`, which accepts granted host folders only. Clarify the
parameter and make a refused folder explain the supported alternative.

## Scope and decision

Keep validation, clone mounts and credential inheritance unchanged. Omit
`folders` to let a scout read the parent's clones through the existing
read-only mount. Never reinterpret `/workspace/repos/<name>` as a host grant:
that mixes sandbox paths with operator-approved paths and changes a boundary
when better guidance solves the observed failure.

Read-only child checkout inheritance is separate work. Children and
subagents use different checkout paths; a successful scout does not prove
that a narrowed child receives repositories.

## Checks

A parent with a repository and no host grants gets an actionable rejection
for a checkout path. With `folders` omitted, its scout keeps `reposOf` set to
the parent and `reposReadOnly: true`, with no repository grants or forge
credentials. The model-facing schema carries the distinction. Existing
folder-widening tests remain in place. Run typecheck and tests sequentially.
These tests check delegation wiring, not a real FUSE-backed clone mount.
