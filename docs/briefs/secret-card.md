# Secrets on a card

**Status:** built (this PR). The owner approved the card's mockup on
2026-11-16.

## Problem

A command sometimes needs a secret: a Tailscale auth key, a registry
password, a deploy key, the person's sudo password. Pasted into chat it
becomes part of the conversation and reaches the model. Before this, a
root step could only be run by the person in their own terminal, and a
key could only be typed there too.

## What was built

- `run_with_secret`: a question card with a masked field (label from her
  call, several lines for a private key, Show), the script's command, hash
  and text, **Run** and **Not now**. Run posts the secret as raw bytes; it
  goes to the hashed script's standard input as a background command, is
  masked in the output and wiped at the end (docs/workspace.md, "Secrets
  for one command").
- The root step's card gains **Password**, **Keep for** (0 to 60 minutes,
  in memory only) and **Run** (`sudo -S -k`, exec'd by her shell; the
  password written only once sudo prompts; root copies and checks the
  script), beside Done and Not now.
- A `run_with_secret` script runs as her account, so her account can
  reach the secret while it runs; the docs, skill and card say so.
- Add machine's **Sudo, with password**: a password for her account,
  chosen at the person's own prompt, that SSH refuses.
- Her `secrets` skill, and the `model-host` skill's Tailscale step on
  `run_with_secret` (no root: her account is in the `docker` group), and its
  root steps run with `sudo` herself when `sudo -n true` already succeeds.

## Out of bounds

- Secrets in the sandbox: only machines take one.
- Encrypting a kept password in lyricad's memory: the key would sit in the
  same process (offered to the owner, not asked for).

- Refusing Run while another command of hers runs on that machine (a
  partial guard against her own account; not built).

## Handoff

Done. Next, if asked: a card for a secret in the sandbox; switching other
skills' steps that ask for a key to `run_with_secret`.
