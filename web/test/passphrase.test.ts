import { describe, expect, it } from "vitest";
import { retryMinutes } from "../src/Panel.tsx";

describe("retryMinutes", () => {
  it("rounds the limiter's seconds up to whole minutes, at least one", () => {
    expect(retryMinutes("too many attempts; try again in 30 s")).toBe(1);
    expect(retryMinutes("too many attempts; try again in 61 s")).toBe(2);
    expect(retryMinutes("too many attempts")).toBe(1);
  });
});
