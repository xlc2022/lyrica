import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { gitEnv } from "../src/index.ts";

// The gh and tea wrappers (core/src/workspace/forge.sh), run directly in front
// of stand-ins that print what they were given. In a sandbox they sit at
// /run/lyrica/bin, first on PATH; core/test/sandbox.test.ts checks that.
const FORGE = fileURLToPath(new URL("../src/workspace/forge.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "lyrica-forge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const wrappers = join(dir, "run/lyrica/bin");
const real = join(dir, "real");
mkdirSync(wrappers, { recursive: true });
mkdirSync(real);
for (const tool of ["gh", "tea"]) {
  symlinkSync(FORGE, join(wrappers, tool));
  writeFileSync(join(real, tool), `#!/bin/sh\necho "${tool} GH_TOKEN=$GH_TOKEN GH_HOST=$GH_HOST GH_ENTERPRISE_TOKEN=$GH_ENTERPRISE_TOKEN"\necho "config=$XDG_CONFIG_HOME"\ncat "$XDG_CONFIG_HOME/tea/config.yml" 2>/dev/null || true\n`);
  chmodSync(join(real, tool), 0o755);
}
const clone = (name: string, url: string) => {
  const path = join(dir, name);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", url]);
  return path;
};

const env = gitEnv([
  { name: "xlc2022/lyrica", account: { kind: "github", host: "github.com", account: "lyrica-bot", token: "bot-token" } },
  { name: "li/notes", account: { kind: "github", host: "github.com", account: "li", token: "li-token" } },
  { name: "li/home", account: { kind: "forgejo", host: "forge.lan:3000", account: "li", token: "it's-forge" } },
]);
// The wrapper finds itself by the first PATH entry, as in a sandbox.
const run = (tool: string, cwd: string) => execFileSync("sh", [join(wrappers, tool)], {
  cwd, encoding: "utf8",
  env: { ...env, PATH: `/run/lyrica/bin:${real}:${process.env.PATH}`, GH_TOKEN: "leaked" },
});

describe("the gh and tea wrappers", () => {
  it("give gh only the token of the account whose repository the clone is", () => {
    expect(run("gh", clone("lyrica", "https://github.com/xlc2022/lyrica.git"))).toContain("gh GH_TOKEN=bot-token GH_HOST= ");
    expect(run("gh", clone("notes", "https://github.com/Li/Notes"))).toContain("gh GH_TOKEN=li-token GH_HOST= ");
    expect(run("gh", clone("other", "https://github.com/xlc2022/other.git"))).toContain("gh GH_TOKEN= GH_HOST= GH_ENTERPRISE_TOKEN=\n");
    expect(run("gh", dir)).toContain("gh GH_TOKEN= GH_HOST= GH_ENTERPRISE_TOKEN=\n");
  });

  it("write tea one login, under /tmp, only in its own account's clone", () => {
    const home = clone("home", "https://forge.lan:3000/li/home.git");
    const out = run("tea", home);
    expect(out).toContain("url: 'https://forge.lan:3000'\n  token: 'it''s-forge'\n  user: 'li'\n");
    expect(out).toContain("config=/tmp/lyrica-forge\n");
    expect(out).not.toContain("li-token");
    expect(run("gh", home)).toContain("gh GH_TOKEN= ");
    expect(run("tea", join(dir, "lyrica"))).not.toContain("token:");
  });
});
