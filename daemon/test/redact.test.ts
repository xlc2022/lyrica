import { describe, expect, it } from "vitest";
import { HIDDEN, redactUrl, unredactUrl } from "../src/redact.ts";

describe("URLs as the API shows them", () => {
  const stored = "https://mcp.example.com/mcp?api_key=FAKE-secret-value&region=eu";

  it("hides query values named like a credential, and only those", () => {
    const shown = redactUrl(stored);
    expect(shown).not.toContain("FAKE-secret-value");
    expect(new URL(shown).searchParams.get("api_key")).toBe(HIDDEN);
    expect(new URL(shown).searchParams.get("region")).toBe("eu");
    expect(redactUrl("http://192.168.1.50:1234/v1")).toBe("http://192.168.1.50:1234/v1");
  });

  it("keeps the stored value when an edit sends the hidden one back", () => {
    const edited = redactUrl(stored).replace("region=eu", "region=us");
    const saved = new URL(unredactUrl(edited, stored));
    expect(saved.searchParams.get("api_key")).toBe("FAKE-secret-value");
    expect(saved.searchParams.get("region")).toBe("us");
    expect(unredactUrl("https://other.example/mcp?token=new", stored)).toBe("https://other.example/mcp?token=new");
  });
});
