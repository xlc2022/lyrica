# Brief: Rejected image attempts

**Thread:** Tuck rejected image attempts away.

**Read first:** docs/workspace.md "Rejected attempts", docs/ux.md §6 "An image
the agent made", docs/briefs/images.md.

## Goal

When she makes an image, judges that it misses the prompt and tries again, the
attempts she gave up on move to a reject folder for that thread and the chat
folds them into one collapsible group. Her final attempt, or the one she likes
best, shows on its own after the group. The user can ask her to delete a
thread's rejects. This serves principle 1 (images as part of how she works
with the user, without clutter) and principle 2 (the files stay the user's,
in the encrypted thread folder).

## In scope

- `reject`, `pick` and `clear_rejected` actions on the existing `image` tool
  (no new tool, within principle 8's budget), with no model call.
- Rejects move to the images folder's `rejected/`; thumbnails and origin
  records follow; `clear_rejected` deletes only the tool's own results there,
  only when the user asks (her tool guidance says so).
- The web groups each turn's rejects into one closed "<n> rejected" marker
  and shows the pick last.

## Out of scope

- Restoring deleted rejects (deletion is for good).
- A button in the UI to delete rejects; the user asks her in words.

## Handoff notes

**Done (2026-10-26):** built on `claude/project-thread-0h79uw`: core
`ThreadImages.reject`/`pick`/`clearRejected`, the tool actions and guidance,
`picked` on `ImagePart`, `web/src/rejects.ts` and the marker, docs. Tests:
core/test/image-storage.test.ts, extension/test/images.test.ts,
web/test/rejects.test.ts.

**Next:** PR review and UI review.
