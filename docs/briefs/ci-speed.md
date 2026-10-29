# Brief: faster CI without losing coverage

**Status:** Merged as #364 (2fed39e).

Principle 8 (budgets) and AGENTS.md's test rule: CI protects what the user
would notice, and a PR's check job shouldn't cost more than it has to. The
analysis behind this lives outside the repo, in the project's shared
`ci-trim/report.md`. The operator picked these items from it.

## Scope

1. The relay certificate flake: `core/src/workspace/certs.ts` made a DER
   serial with a leading zero byte about 1 time in 256, and OpenSSL refused
   it ("illegal padding"). It now sets the second-highest bit, as
   `host/src/identity.ts` and `core/src/models/host.ts` do.
2. The question card shown twice and the "watching threads" e2e flake:
   already fixed by #344.
3. The phone header check in "each message shows when it was sent" polls
   until the header has settled, instead of measuring once.
4. Covered by 2.
5. Tests open self.db with one round of SQLCipher's PBKDF2 instead of
   256,000: `new Keyring(home, argon2, kdfIter)` and `LyricadOptions.kdfIter`.
   Production passes neither, so its key derivation is unchanged.
6. A template home for `daemon/test/helpers.ts` `runtime()`: measured after
   item 5 at 59 ms per call, so it isn't worth building.
7. A cache of migrated databases in `core/test/migrations.test.ts`: the file
   takes 2.9 s on a quiet machine, so it isn't worth building.
8. (Item 11 in the report.) `web/e2e/web.spec.ts` is split into
   `web-chat`, `web-projects` and `web-admin`, sharing `web/e2e/helpers.ts`.
   Each runs at phone and desktop size against its own lyricad: seven
   projects with the setup page.

Out of scope: cutting tests, and the phone e2e pass (the operator keeps it).

## Results (4-core cloud sandbox)

- 4 heavy unit files: 66 s summed down to 32 s. The full suite takes 137 s.
- e2e: 5.6 min down to about 3.6 min.
- The extra parallel load exposed timing races, now fixed:
  - `openSettings` now treats a cancelled slide-in as finished;
  - "private and local-only" waits for the general thread before opening its drawer;
  - Recent calls finds its Project select by role, not the header's Project button;
  - Her name is refilled until the field holds it;
  - the phone New project test measures the list again on each try;
  - the admin spec's routes that fetch the real response retry once on
    ECONNRESET and are removed after each test.
- The Files panel e2e test fails in the sandbox before and after the split.
  It passes on the runner.

## Handoff

Done: items 1 to 8 above, in one PR. CI now runs on GitHub's hosted runners
(docs/ci.md). If a runner is short of cores, lower `workers` in
`web/playwright.config.ts` before merging files back together.
Open questions: none.
