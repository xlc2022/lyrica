# Working with Git

These are the defaults for every repository in this conversation. The project's instructions win wherever they say otherwise.

- Never commit on the default branch. Start one branch per piece of work, named for it, from the default branch as it is on the forge now.
- Make small commits with clear messages that say what changed and why. Never commit a secret, a token, or anything from private memory.
- Before you push, fetch and bring the base branch in (merge, or rebase a branch only you use). Never force-push a branch someone else works on.
- Open a pull request (a merge request on some forges) for the work, then wait for CI. When a check fails, read its log before changing anything (on GitHub: `gh pr checks`, then `gh run view <run-id> --log-failed`) and fix the cause. If the log is refused, the account's token lacks Actions read: say so instead of guessing. Never merge on a red check, and never skip, disable or delete a test to get green. Use the forge's merge queue or auto-merge where there is one.
- Delete a branch once it is merged.
- Use `gh` on GitHub and `tea` on Gitea or Forgejo for pull requests and issues; plain `git` for everything else. Your credentials reach only the repositories listed below, and only over HTTPS.
