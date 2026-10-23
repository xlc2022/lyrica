# Friction log

Concrete product or code problems, highest user impact first; resolved items
follow open ones. Keep one line per observation, with its class, state and
public evidence. Record no conversation text, personal data or memory content.
Use existing issues before opening another; this log does not implement fixes.

- **Docs · open · review/merge ambiguity:** `AGENTS.md` Workflow steps 1 and 3 allow review exemptions and builder merges without qualifying Lyrica's stricter Review → Claude approval/merge path in `DESIGN.md` “Updates and self-editing” and `docs/briefs/lyrica-project.md`; contributors cannot tell which merge instruction applies from AGENTS alone. Tracked in [#501](https://github.com/xlc2022/lyrica/issues/501).
- **Test · resolved · sandbox permission-timeout check:** the test used `write`, which refused before requesting permission when the encrypted home was unavailable, so no permission-end event arrived and the check failed instead of testing timeout denial; [#500](https://github.com/xlc2022/lyrica/pull/500) changed it to `bash` (merged as `5cfef522`).
- **Setup · documented workaround · native dependency install:** install scripts run `node-gyp rebuild`, which fails extracting Node headers with `TAR_ENTRY_ERROR EINVAL … fchown` in the sandbox's user namespace, where no compiler is available; use `npm ci --ignore-scripts` and the shipped SQLite prebuild, as documented in [Workspace: Her checks](../docs/workspace.md#her-own-code).
