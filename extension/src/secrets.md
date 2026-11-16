---
name: secrets
description: Get a key, token, password or the person's sudo password into a command on one of your machines without it passing through chat, with run_with_secret or Run on a root step's card.
---

# Secrets for one command

A secret is anything the person would keep private: an auth key, an API key, a token, a password, a private key, a passphrase, their sudo password. You never see one and never ask for one in chat. It reaches a command one way: the person types it on a card, and lyricad hands it to one script's standard input, masks it in the output, and wipes it when the script ends.

That keeps it out of the conversation, not out of your account. A `run_with_secret` script runs as your account, so while it runs any other command of yours on that machine could reach the secret, and it is wherever the script leaves it. Say so in `why` when it matters, ask for a one-off, narrow or short-lived secret, and if the run fails, tell the person to revoke it. Don't start other commands on that machine while it runs. A sudo password on a root card goes to sudo, out of your ordinary commands' reach.

## Which card

- **A secret for a command that runs as your account:** `run_with_secret` with the machine, the script's path, `secret` (the field's label, such as "Tailscale auth key" or "Registry password"), `lines: true` for a private key, and `why`: what the script does with it, and where the person makes one.
- **A step that needs root:** first see whether you already may: `sudo -n true` succeeding means sudo without a password, so run it yourself with `sudo` after the person's yes, with no card. Otherwise `run_as_root`. Its card offers **Run**, where the person types their sudo password (lyricad runs your script with `sudo -S -k`, so the password opens that one script and sudo keeps nothing), and **Done**, for running it in their own terminal. On your own account, Run works only once the person has chosen **Sudo, with password** in Add machine, or when you log in as their account; if a Run fails with sudo's "is not in the sudoers file" or "Sorry, try again", say which, and point them to that block or to Done.
- **Root and a secret in one step:** not on one card. Split it: the root part with `run_as_root`, then the part that needs the secret as your account with `run_with_secret` (your account in the `docker` group can start containers, for instance), or ask the person to run that part in their own terminal.

Before asking, check whether the step is needed at all: a token already set, a device already joined, a login already there. Don't ask for what the machine already has.

## Writing the script

- Read the secret once, first: `IFS= read -r KEY` for one line, `KEY=$(cat)` for several. Nothing before that line reads standard input; give later commands that might read it `< /dev/null`.
- Hand it on through the program's own way of taking it on input (`--password-stdin`, `ssh-add -`, `chpasswd`), or in the environment of that one command (`KEY=… program`, `export` only inside the script). Never on a command line, which other accounts can see in `ps`.
- Never `echo` it, never `set -x`, never write it to a file, a log or `.env`. A program that wants a file gets `/dev/stdin` or a pipe.
- If the program keeps the secret (a container's environment, a credential store), say so in `why`, and remove it once it has done its job where you can (start the container again without it).
- A program that only reads a terminal (`passwd`, an SSH passphrase prompt) can't take a card's secret: use its input form, or give the person the command to run themselves.
- Prefer secrets that expire: ask for a one-off or short-lived key where the service offers one, with the narrowest scope that works, and say where to make it.

## After Run

The script runs as a background command of the thread; you're told when it ends, with its output, any copy of the secret shown as `[secret]`. Report the outcome. On a failure, read the output and say what went wrong; ask again on a new card only when a retry makes sense, and a one-off key that was used needs a fresh one.

## A secret in chat

If the person pastes one into the conversation anyway, it is now part of it, and stored with the thread. Say so plainly, don't use it, and ask them to make a new one and give it on the card instead.
