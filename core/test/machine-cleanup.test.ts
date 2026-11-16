import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyBlob, machineCleanup } from "../src/workspace/machine-cleanup.ts";

// Remove machine's optional clean-up commands: which steps each kind of
// machine gets, and the key and sudoers commands run against files of their
// own with a stub sudo, so they take away her lines and nothing else.

const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIK+x/9yZ0q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k";
const OTHER = "AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKey12";
const keyLine = `restrict,from="10.0.0.2,100.64.0.1" ssh-ed25519 ${BLOB}`;
const ssh = { kind: "ssh" as const, address: "lyrica@box.lan:2222", keyLine };

/** Runs `command` in bash with its file swapped for `file` and `sudo` running its command as the test user. */
function run(command: string, from: string, file: string): number {
  const bin = mkdtempSync(join(tmpdir(), "lyrica-cleanup-bin-"));
  writeFileSync(join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n');
  chmodSync(join(bin, "sudo"), 0o755);
  try { execFileSync("bash", ["-c", command.replaceAll(from, file)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" }); return 0; }
  catch (e) { return (e as { status: number }).status; }
  finally { rmSync(bin, { recursive: true, force: true }); }
}

describe("machine clean-up", () => {
  it("finds the key's blob whatever its options", () => {
    expect(keyBlob(keyLine)).toBe(BLOB);
    expect(keyBlob(`ssh-ed25519 ${BLOB} comment`)).toBe(BLOB);
    expect(keyBlob("")).toBeUndefined();
  });

  it("offers her own account the key, its sudo lines and the account; the user's own account only the key", () => {
    expect(machineCleanup(ssh).map((s) => s.name)).toEqual(["Key", "Sudo", "Account"]);
    const account = machineCleanup(ssh).find((s) => s.name === "Account")!.command;
    // Her logins go before the account: the keys file and sshd rule the setup wrote, then sshd reloaded.
    expect(account.indexOf("/etc/ssh/sshd_config.d/lyrica-lyrica.conf")).toBeLessThan(account.indexOf("userdel --remove lyrica"));
    expect(account).toContain("/etc/ssh/authorized_keys/lyrica ");
    expect(machineCleanup({ ...ssh, asUser: true, address: "sam@laptop.lan" }).map((s) => [s.name, s.command]))
      .toEqual([["Key", `sed -i '\\|${BLOB}|d' ~/.ssh/authorized_keys`]]);
    // Without a key line there's no key to take away.
    expect(machineCleanup({ ...ssh, keyLine: "" }).map((s) => s.name)).toEqual(["Sudo", "Account"]);
  });

  it("on NixOS, offers the rebuild that drops what her module declared, then her home folder", () => {
    expect(machineCleanup({ ...ssh, nixos: true }).map((s) => [s.name, s.command]))
      .toEqual([["Configuration", "sudo nixos-rebuild switch"], ["Home", "sudo rm -rf /home/lyrica"]]);
    expect(machineCleanup({ ...ssh, nixos: true, asUser: true, address: "sam@laptop.lan" }).map((s) => [s.name, s.command]))
      .toEqual([["Key", "sudo nixos-rebuild switch"]]);
  });

  it("offers a Proxmox token, and the user made for her, never the user's own Proxmox user", () => {
    expect(machineCleanup({ kind: "proxmox", address: "https://pve.lan:8006", tokenId: "lyrica@pve!agent" }).map((s) => s.command))
      .toEqual(["pveum user token remove lyrica@pve agent", "pveum user delete lyrica@pve"]);
    expect(machineCleanup({ kind: "proxmox", address: "https://pve.lan:8006", tokenId: "root@pam!lyrica", asUser: true }).map((s) => s.command))
      .toEqual(["pveum user token remove root@pam lyrica"]);
  });

  it("takes only her key out of the keys file, and only her account's lines out of the sudoers file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-cleanup-"));
    mkdirSync(join(dir, "etc"));
    const keys = join(dir, "etc", "keys"), sudoers = join(dir, "etc", "sudoers");
    writeFileSync(keys, `restrict ssh-ed25519 ${OTHER}\n${keyLine}\n`);
    writeFileSync(sudoers, "lyrica ALL=(root) NOPASSWD: /usr/bin/nvidia-smi \"\"\nlyrica2 ALL=(root) NOPASSWD: /usr/bin/true x\n");
    const steps = machineCleanup(ssh);
    expect(run(steps[0]!.command, "/etc/ssh/authorized_keys/lyrica", keys)).toBe(0);
    expect(readFileSync(keys, "utf8")).toBe(`restrict ssh-ed25519 ${OTHER}\n`);
    expect(run(steps[1]!.command, "/etc/sudoers.d/lyrica", sudoers)).toBe(0);
    expect(readFileSync(sudoers, "utf8")).toBe("lyrica2 ALL=(root) NOPASSWD: /usr/bin/true x\n");
    // No sudoers file is nothing to do, not a failure.
    expect(run(steps[1]!.command, "/etc/sudoers.d/lyrica", join(dir, "none"))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
