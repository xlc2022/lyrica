import { defineConfig } from "vitest/config";

// Continuity evals (PRINCIPLES.md, "Evaluation"). Kept out of `npm test`: a
// failing eval is evidence for the next piece of work, not a broken build.
export default defineConfig({
  test: { include: ["evals/**/*.eval.ts"], testTimeout: 30_000 },
});
