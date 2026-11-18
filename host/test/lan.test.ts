import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// lan.sh keeps host-api published when DHCP gives the machine a new LAN
// address: without it, Docker starts host-api with no published port at all,
// and the updater can't reach it to pause it.
const LAN = fileURLToPath(new URL("../lan.sh", import.meta.url));
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs lan.sh with a fake ip (the machine's addresses) and docker (host-api's bindings, and a log of what it was asked). */
function run(env: string, addrs: string[], bound: string[]) {
  dir = mkdtempSync(join(tmpdir(), "lan-"));
  const bin = join(dir, "bin");
  execFileSync("mkdir", [join(dir, "host"), bin]);
  copyFileSync(LAN, join(dir, "host", "lan.sh"));
  writeFileSync(join(dir, "host", ".env"), env);
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const lines = addrs.map((a, i) => `${i + 2}: eth0    inet ${a}/24 brd x scope global eth0`).join("\\n");
  fake("ip", `case "$*" in
  *"route get"*) ${addrs[0] ? `echo "1.1.1.1 via x dev eth0 src ${addrs[0]} uid 0"` : "exit 2"} ;;
  *) printf '${lines}\\n' ;;
esac`);
  fake("docker", `echo "$*" >>"${join(dir, "docker.log")}"
case "$1" in port) printf '${bound.join("\\n")}\\n' ;; esac`);
  const out = execFileSync("bash", [join(dir, "host", "lan.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const log = (() => { try { return readFileSync(join(dir, "docker.log"), "utf8"); } catch { return ""; } })();
  return { out, env: readFileSync(join(dir, "host", ".env"), "utf8"), restarted: log.includes("compose up") };
}

describe("lan.sh", () => {
  it("does nothing while the address is the machine's and bound", () => {
    const r = run("LAN_ADDRESS=10.0.0.5\nLAN_BIND=10.0.0.5\nLAN_INTERFACE=eth0\n", ["10.0.0.5"], ["10.0.0.5:7236"]);
    expect(r.restarted).toBe(false);
  });

  it("follows a new DHCP address on the same interface, and starts host-api on it", () => {
    const r = run("LAN_ADDRESS=10.0.0.5\nLAN_BIND=10.0.0.5\nLAN_INTERFACE=eth0\nHOST_NAME=n\n", ["10.69.128.97"], []);
    expect(r.env).toContain("LAN_ADDRESS=10.69.128.97\nLAN_BIND=10.69.128.97\n");
    expect(r.env).toContain("HOST_NAME=n");
    expect(r.restarted).toBe(true);
  });

  it("starts host-api again when it came up before its address did", () => {
    const r = run("LAN_ADDRESS=10.0.0.5\nLAN_BIND=10.0.0.5\n", ["10.0.0.5"], []);
    expect(r.env).toContain("LAN_ADDRESS=10.0.0.5\n");
    expect(r.restarted).toBe(true);
  });

  it("never publishes on a public address", () => {
    const r = run("LAN_ADDRESS=10.0.0.5\nLAN_BIND=10.0.0.5\n", ["203.0.113.7"], []);
    expect(r.env).toContain("LAN_ADDRESS=10.0.0.5\n");
    expect(r.restarted).toBe(false);
  });

  it("leaves a host without a LAN address alone", () => {
    const r = run("LAN_ADDRESS=\nTS_HOSTNAME=n\n", ["10.0.0.5"], []);
    expect(r.restarted).toBe(false);
  });
});
