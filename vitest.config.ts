import { defineConfig } from "vitest/config";

// The CI runners share one machine, so a busy run is several times slower than a quiet one. Each
// test's setup (argon2, a database, a daemon) runs in a hook, which sat at vitest's 10 s default and
// failed a run on main when the runner was loaded.
export default defineConfig({
  // Tests that print times expect UTC, as on the runners; a host in another zone (a developer's machine) gets it too.
  test: { include: ["*/test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, env: { TZ: "UTC" } },
});
