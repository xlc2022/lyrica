import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// On NixOS the host's updater runs with only the PATH the module gives it
// (nix/host-module.nix, `updaterPath`), and so does the install.sh --yes it runs
// in the new tree: a command missing there fails the update before it can say
// why, as awk did for lyricad's own updater (#838). Each command the scripts run
// needs its package.

const HOST = fileURLToPath(new URL("..", import.meta.url));
const MODULE = fileURLToPath(new URL("../../nix/host-module.nix", import.meta.url));
const SCRIPTS = ["update.sh", "install.sh", "egress.sh", "prebuilt.sh"];

/** Commands the host scripts run, and the nixpkgs package (or option) that has each. */
const PACKAGE: Record<string, string> = {
  awk: "gawk", tar: "gnutar", jq: "jq", git: "git", curl: "curl", ssh: "openssh", "ssh-keygen": "openssh",
  grep: "gnugrep", sed: "gnused", find: "findutils", xargs: "findutils", flock: "util-linux",
  systemctl: "systemd", docker: "config.virtualisation.docker.package", iptables: "iptables", ip: "iproute2",
  lsmod: "kmod", hostname: "nettools", getent: "getent", "nvidia-smi": "config.hardware.nvidia.package.bin",
  sha256sum: "coreutils", mktemp: "coreutils", timeout: "coreutils", stat: "coreutils", date: "coreutils", sort: "coreutils",
  paste: "coreutils", tail: "coreutils", head: "coreutils", cut: "coreutils", du: "coreutils", realpath: "coreutils",
  install: "coreutils", tee: "coreutils", tr: "coreutils", uname: "coreutils", seq: "coreutils", wc: "coreutils",
};

describe("the host updater on NixOS", () => {
  it("has every command its scripts run on its PATH", () => {
    const path = /updaterPath = lib\.makeBinPath \(([\s\S]*?)\);/.exec(readFileSync(MODULE, "utf8"))?.[1];
    expect(path).toBeDefined();
    const used = new Set<string>();
    for (const f of SCRIPTS) {
      const code = readFileSync(`${HOST}${f}`, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      for (const cmd of Object.keys(PACKAGE)) if (new RegExp(`(^|[\\s|;&(!]|\\$\\()${cmd.replace("-", "\\-")}(?=\\s)`, "m").test(code)) used.add(cmd);
    }
    for (const cmd of ["docker", "iptables", "jq", "git", "tar", "flock", "nvidia-smi"]) expect(used).toContain(cmd);
    const missing = [...used].filter((c) => !new RegExp(`(^|[\\s\\[])${PACKAGE[c]!.replace(/\./g, "\\.")}(?=[\\s\\])]|$)`).test(path!)).map((c) => `${c} (${PACKAGE[c]})`);
    expect(missing).toEqual([]);
  });
});
