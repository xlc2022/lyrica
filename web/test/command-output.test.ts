import { describe, expect, it } from "vitest";
import { endLine } from "../src/CommandOutput.tsx";
import type { CommandOutputInfo } from "../src/api.ts";

describe("command output's end line", () => {
  it("names her when she stopped a job herself, and gives any other reason as stored", () => {
    const stopped = (reason?: string) => endLine({ state: "stopped", reason } as CommandOutputInfo);
    expect(stopped("stopped by her")).toBe("Stopped by Lyrica");
    expect(stopped("the turn ended")).toBe("Stopped: the turn ended");
  });
});
