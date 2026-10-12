import { describe, expect, it } from "vitest";
import { HIDDEN, redactUrl, unredactUrl } from "../src/redact.ts";

describe("URLs as the API shows them", () => {
  const stored = "https://mcp.example.com/mcp?api_key=FAKE-secret-value&scope=a:b%20c";

  it("hides query values named like a credential, and leaves the rest exactly as stored", () => {
    expect(redactUrl(stored)).toBe(`https://mcp.example.com/mcp?api_key=${HIDDEN}&scope=a:b%20c`);
    expect(redactUrl("http://192.168.1.50:1234/v1")).toBe("http://192.168.1.50:1234/v1");
    expect(redactUrl("https://x.example/?a=1&token=t#frag")).toBe(`https://x.example/?a=1&token=${HIDDEN}#frag`);
  });

  it("keeps the stored value when an edit sends the hidden one back on the same origin", () => {
    const edited = redactUrl(stored).replace("/mcp?", "/v2/mcp?");
    expect(unredactUrl(edited, stored)).toBe("https://mcp.example.com/v2/mcp?api_key=FAKE-secret-value&scope=a:b%20c");
    const encoded = `https://mcp.example.com/mcp?api_key=${encodeURIComponent(HIDDEN)}`;
    expect(unredactUrl(encoded, stored)).toBe("https://mcp.example.com/mcp?api_key=FAKE-secret-value");
  });

  it("never carries a key to another host", () => {
    expect(unredactUrl(`https://other.example/mcp?api_key=${HIDDEN}`, stored)).toBe(`https://other.example/mcp?api_key=${HIDDEN}`);
  });
});
