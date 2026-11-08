import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { wrongDoor } from "../src/http.ts";

const req = (headers: Record<string, string>, remote = "127.0.0.1") => ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
const proxied = (host: string, fwd?: string) => req({ host, "x-forwarded-proto": "https", ...(fwd ? { "x-forwarded-host": fwd } : {}) });

describe("wrongDoor behind the built-in Caddy", () => {
  const names = ["lyrica.example.net"];

  it("accepts the proxy's own name, as Caddy passes the browser's Host on", () => {
    expect(wrongDoor(proxied("lyrica.example.net", "lyrica.example.net"), true, names)).toBeUndefined();
    expect(wrongDoor(proxied("127.0.0.1:7340"), true, names)).toBeUndefined();
  });

  it("refuses a page that rebound its own name to loopback, whatever forwarded headers its script sets", () => {
    expect(wrongDoor(proxied("evil.example:7340", "lyrica.example.net"), true, names)).toBe("evil.example");
    expect(wrongDoor(proxied("lyrica.example.net", "evil.example"), true, names)).toBe("evil.example");
    expect(wrongDoor(req({ host: "evil.example:7340" }), true, names)).toBe("evil.example");
  });

  it("trusts the forwarded headers as before on an install that hasn't saved its names yet", () => {
    expect(wrongDoor(proxied("evil.example:7340"), true, undefined)).toBeUndefined();
  });

  it("ignores forwarded headers from a listener with no proxy in front", () => {
    expect(wrongDoor(proxied("lyrica.example.net"), false, names)).toBe("lyrica.example.net");
    expect(wrongDoor(req({ host: "localhost:7340" }), false, [])).toBeUndefined();
  });
});
