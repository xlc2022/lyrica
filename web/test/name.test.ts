import { afterEach, describe, expect, it, vi } from "vitest";
import { checkName } from "../src/name.ts";
import { saveName } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("her name", () => {
  it("trims a name and counts Unicode code points", () => {
    expect(checkName("  Lyrica  ")).toBe("Lyrica");
    expect(checkName("🌙".repeat(40))).toBe("🌙".repeat(40));
    expect(() => checkName("🌙".repeat(41))).toThrow("1 to 40 characters");
  });

  it("refuses empty names and controls or line separators inside a name", () => {
    for (const name of ["", "   ", "x".repeat(41), "Ly\n rica", "Ly\t rica", "Ly\u0000rica", "Ly\u0085rica", "Ly\u2028rica", "Ly\u2029rica"]) {
      expect(() => checkName(name)).toThrow();
    }
    expect(checkName("\nLyrica\n")).toBe("Lyrica");
  });

  it("saves through the existing administrator endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "Lyrica" }), { status: 200 }));
    globalThis.fetch = fetch;
    expect(await saveName("user/one", "Lyrica")).toEqual({ name: "Lyrica" });
    expect(fetch).toHaveBeenCalledWith("/api/u/user%2Fone/admin/name", expect.objectContaining({ method: "PUT", body: JSON.stringify({ name: "Lyrica" }) }));
  });
});
