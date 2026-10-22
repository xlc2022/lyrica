import { describe, expect, it } from "vitest";
import { daemon, runtime } from "./helpers.ts";

describe("her tailscaled's proxy", () => {
  it("is never forwarded into a sandbox, even with Local services on", async () => {
    const { d } = await daemon(await runtime(), { tailnet: { proxy: "127.0.0.1:1056", binary: "/nonexistent/tailscale" } });
    // Local services forwards every loopback port but these, so her commands can't reach her tailnet through it.
    expect(d.sandboxExcluded).toEqual(expect.arrayContaining([1056, d.port, d.servePort]));
  });
});
