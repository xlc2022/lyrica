import { describe, expect, it } from "vitest";
import { maskSecrets, Sandbox, SECRET_HIDDEN, secretMasker } from "../src/index.ts";

// What she sees of a sandbox run never shows the run's tokens (docs/workspace.md, "Credentials").

describe("hiding a sandbox run's credentials", () => {
  const token = "github_pat_FAKE_0123456789abcdef";

  it("takes its tokens and their placeholders, longest first, and nothing else", () => {
    const account = (t: string) => ({ kind: "github" as const, host: "github.com", account: "someone-long-enough", token: t });
    const box = new Sandbox({ grants: [], network: { internet: false, services: false, hosts: [] }, credentials: {
      forge: [{ name: "a/b", account: account(token) }, { name: "a/c", account: account("short") }], anthropic: `${token}-longer`,
    } });
    const secrets = box.secrets();
    expect(secrets.filter((s) => !s.startsWith("lyrica_"))).toEqual([`${token}-longer`, token]);
    expect(secrets.filter((s) => s.startsWith("lyrica_"))).toHaveLength(2);
    expect(secrets).not.toContain("someone-long-enough");
  });

  it("replaces them in a file, keeping every other byte", () => {
    const out = maskSecrets(Buffer.from(`a ${token} b\nÿ`, "latin1"), [token]);
    expect(out.toString("latin1")).toBe(`a ${SECRET_HIDDEN} b\nÿ`);
  });

  it("catches a token split across chunks of output", () => {
    const seen: Buffer[] = [];
    const m = secretMasker([token], (d) => seen.push(d));
    for (const piece of ["export T=", token.slice(0, 7), token.slice(7, 20), `${token.slice(20)}\nok\n`]) m.push(Buffer.from(piece));
    m.end();
    expect(Buffer.concat(seen).toString()).toBe(`export T=${SECRET_HIDDEN}\nok\n`);
  });

  it("holds back only what could begin a token, so other output isn't delayed", () => {
    const seen: string[] = [];
    const m = secretMasker([token], (d) => seen.push(d.toString()));
    m.push(Buffer.from("http://127.0.0.1:4100\n"));
    m.push(Buffer.from("next gith"));
    expect(seen).toEqual(["http://127.0.0.1:4100\n", "next "]);
  });

  it("passes output through as is when the run holds none", () => {
    const seen: string[] = [];
    const m = secretMasker([], (d) => seen.push(d.toString()));
    m.push(Buffer.from("plain"));
    m.end();
    expect(seen).toEqual(["plain"]);
  });
});
