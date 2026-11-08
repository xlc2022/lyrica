import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// On NixOS the updater runs with only the PATH the module gives it (nix/module.nix,
// `updater`): a command missing there fails the update before it can say why, as
// awk did for the latest merge's title. Each command the scripts run needs its package.

const UPDATER = fileURLToPath(new URL("../deploy/updater", import.meta.url));
const MODULE = fileURLToPath(new URL("../../nix/module.nix", import.meta.url));

/** Commands the updater scripts run, and the nixpkgs package that has each. */
const PACKAGE: Record<string, string> = {
  awk: "gawk", tar: "gnutar", cmp: "diffutils", jq: "jq", git: "git", curl: "curl", ssh: "openssh", "ssh-keygen": "openssh",
  grep: "gnugrep", sed: "gnused", find: "findutils", flock: "util-linux", runuser: "util-linux",
  systemctl: "systemd", nix: "config.nix.package", "nix-env": "config.nix.package", "nix-store": "config.nix.package",
  sha256sum: "coreutils", mktemp: "coreutils", timeout: "coreutils", stat: "coreutils", date: "coreutils", sort: "coreutils",
  paste: "coreutils", tail: "coreutils", head: "coreutils", cut: "coreutils", du: "coreutils", realpath: "coreutils",
};

describe("the updater on NixOS", () => {
  it("has every command its scripts run on its PATH", () => {
    const path = /PATH=\$\{lib\.makeBinPath \(with pkgs; \[([^\]]*)\]\)\}/.exec(readFileSync(MODULE, "utf8"))?.[1]?.trim().split(/\s+/);
    expect(path).toBeDefined();
    const used = new Set<string>();
    for (const f of readdirSync(UPDATER)) {
      const code = readFileSync(join(UPDATER, f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      for (const cmd of Object.keys(PACKAGE)) if (new RegExp(`(^|[\\s|;&(!])${cmd.replace("-", "\\-")}(?=\\s)`, "m").test(code)) used.add(cmd);
    }
    expect(used).toContain("awk");
    const missing = [...used].filter((c) => !path!.includes(PACKAGE[c]!)).map((c) => `${c} (${PACKAGE[c]})`);
    expect(missing).toEqual([]);
  });
});
