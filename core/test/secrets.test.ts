import { describe, expect, it } from "vitest";
import { maskSecrets, Sandbox, SECRET_HIDDEN, secretMasker } from "../src/index.ts";

// What she sees of a sandbox run never shows the run's tokens (docs/workspace.md, "Credentials").

describe("hiding a sandbox run's credentials", () => {
  const token = "github_pat_FAKE_0123456789abcdef";

  it("takes every variable named for a token, longest first, and nothing else", () => {
    const box = new Sandbox({ grants: [], network: { internet: false, services: false, hosts: [] }, env: {
      LYRICA_GIT_TOKEN_0: token, LYRICA_GIT_TOKEN_1: "short", CLAUDE_CODE_OAUTH_TOKEN: `${token}-longer`, LYRICA_GIT_USER_0: "someone-long-enough",
    } });
    expect(box.secrets()).toEqual([`${token}-longer`, token]);
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

  it("passes output through as is when the run holds none", () => {
    const seen: string[] = [];
    const m = secretMasker([], (d) => seen.push(d.toString()));
    m.push(Buffer.from("plain"));
    m.end();
    expect(seen).toEqual(["plain"]);
  });
});
