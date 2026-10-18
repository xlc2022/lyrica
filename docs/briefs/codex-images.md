# Brief: ChatGPT Images through Codex

**Thread:** Image settings and recipes. **Branch:** `claude/image-settings-recipes-bpk70s`.
**Model:** Opus. **Depends on:** image settings (`image-settings.md`, #318).

**Read first:** AGENTS.md, PRINCIPLES.md (1, 2 and 8), docs/models.md
("Image canvases"), docs/workspace.md ("Claude Code"), the
subscription-logins brief.

## Goal

ChatGPT Images sent the plan's "Sign in with ChatGPT" token to
`api.openai.com/v1/responses` with the image tool, and OpenAI answers
Forbidden: that sign-in doesn't allow images. Reusing Codex's own OAuth
client inside Lyrica isn't something OpenAI says it allows. So the owner
chose (2026-10-18) to wrap Codex: the daemon runs the unmodified `codex`
program, signed in with the user's own Codex login, as ordinary Codex use.

1. **Image calls.** An image call that resolves to ChatGPT Images runs
   `codex exec` on the daemon's machine with image generation on, a
   read-only sandbox, no approvals, no saved session, an attached input for
   an edit, and reads back the PNG it saved. Masked edits and upscales still
   skip it. A restricted thread never reaches it, as before.
2. **Nothing in plaintext.** Codex's home (its sign-in, any file it writes,
   the input image) is `codex/` in the user's encrypted home workspace, and
   each call's files are removed after it. No prompt text is logged.
3. **Sign-in.** Settings gains a **Codex** section, as Claude Code has one:
   whether Codex is installed, **Sign in**, which runs Codex's own device
   sign-in and shows its link and code, then signed in with **Sign out**.
4. **Installed** with Lyrica: nixpkgs' `codex` on the daemon's path on
   NixOS, and a pinned `@openai/codex` in `/usr/local` from `install.sh`.
5. **Old path removed.** The HTTP plan image call, its token resolver and
   the driver-model choice go.

Defaults picked: ChatGPT Images still appears on a signed-in ChatGPT plan,
which is where its lists and checkboxes already are; Codex picks its own
model; a call without a Codex sign-in fails with a fixed line naming
Settings → Codex.

## Out of scope

ChatGPT Images without a ChatGPT plan endpoint; Codex for anything but
images; the 400 and 413 image tool errors (with the coordinator).

## Handoff

Done: the brief and the build (items 1 to 5), tested against a stand-in
`codex`.
Next: PR review and UI review; then one generation and one edit on lunasa
with the owner's yes, which also checks what the stand-in can't: the shape
of Codex's `saved_path` event, that `--ephemeral` still saves the image, and
that the daemon's systemd hardening lets Codex's own sandbox start. Do not
spend quota without the owner's yes.
