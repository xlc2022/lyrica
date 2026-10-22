import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkSudoers, rootAsk, rootStep } from "../src/index.ts";

const line = (cmd: string) => `lyrica ALL=(root) NOPASSWD: ${cmd}`;

describe("sudoers lines she offers", () => {
  it("keeps one command with fixed arguments, and warns where it can still reach root", () => {
    expect(checkSudoers([line("/usr/bin/systemctl restart lyrica-host-update.service")], "lyrica")).toEqual([{ line: line("/usr/bin/systemctl restart lyrica-host-update.service") }]);
    expect(checkSudoers([line("/usr/bin/docker compose pull")], "lyrica")[0]!.warning).toMatch(/container can mount the whole disk/);
    expect(checkSudoers([line("/usr/bin/apt-get update")], "lyrica")[0]!.warning).toMatch(/package/);
    expect(checkSudoers([line("/usr/bin/systemctl edit nginx")], "lyrica")[0]!.warning).toMatch(/what runs as root/);
    expect(checkSudoers([line('/usr/bin/nvidia-smi ""')], "lyrica")).toEqual([{ line: line('/usr/bin/nvidia-smi ""') }]);
  });

  it("refuses anything that runs anything, a wildcard, ALL, another account or a relative program", () => {
    const refused = (l: string, why: RegExp) => expect(() => checkSudoers([l], "lyrica")).toThrow(why);
    refused(line("/bin/bash"), /bash runs anything/);
    refused(line("/usr/bin/python3.12 x.py"), /python3.12 runs anything/);
    refused(line("/usr/bin/vim /etc/hosts"), /vim runs anything/);
    refused(line("/usr/bin/systemctl restart *"), /wildcards/);
    refused(line("ALL"), /ALL would let her run anything/);
    refused("lyrica ALL=(ALL) NOPASSWD: /usr/bin/true", /must start with/);
    refused("sam ALL=(root) NOPASSWD: /usr/bin/true", /must start with/);
    refused(line("systemctl restart nginx"), /absolute path/);
    refused(line("/usr/bin/systemctl --user restart x"), /without options/);
    refused(line("/usr/bin/true; rm -rf /"), /shell characters/);
    // sudoers reads # as a comment, so this would allow systemctl with any arguments.
    refused(line("/usr/bin/systemctl #restart"), /comments/);
    refused(line("/usr/bin/systemctl restart @x"), /comments/);
    refused(line("/usr/bin/nvidia-smi"), /a program alone allows any arguments/);
    refused(line('/usr/bin/systemctl "" restart'), /quotes/);
    refused(line("/home/lyrica/bin/tool run"), /must be in \/usr\/bin/);
    refused(line("/usr/local/bin/sub/tool run"), /must be in \/usr\/bin/);
    refused(line("/usr/bin/tee /tmp/x"), /a file she can change/);
    refused(line("/usr/bin/cp /srv/../home/a /etc/x"), /a file she can change/);
    refused(line("/usr/bin/vim.basic /etc/hosts"), /vim.basic runs anything/);
    refused(line("/usr/bin/systemd-run /usr/bin/id"), /systemd-run runs anything/);
    refused(line("/usr/sbin/chroot /"), /chroot runs anything/);
    refused(line("/usr/bin/git -C /srv/app pull"), /git runs anything/);
    expect(() => checkSudoers(Array(9).fill(line("/usr/bin/true x")), "lyrica")).toThrow(/at most 8/);
  });
});

describe("a root step", () => {
  it("hashes what was read and builds a command that checks the hash before running it", () => {
    const step = rootStep({ machine: "box", path: "/home/lyrica/it's.sh", why: " Installs Docker. " }, Buffer.from("echo hi\n"), "lyrica");
    expect(step.sha256).toBe(createHash("sha256").update("echo hi\n").digest("hex"));
    expect(step.command).toBe(`f=$(mktemp) && cat '/home/lyrica/it'\\''s.sh' > "$f" && echo '${step.sha256}  '"$f" | sha256sum -c --quiet - && sudo bash "$f"; rm -f "$f"`);
    expect(step.why).toBe("Installs Docker.");
    expect(step.sudoers).toBeUndefined();
  });

  it("refuses a script too long or not text, a relative path and an empty reason", () => {
    expect(() => rootStep({ machine: "m", path: "x.sh", why: "w" }, Buffer.from("a"), "u")).toThrow(/absolute path/);
    expect(() => rootStep({ machine: "m", path: "/x.sh", why: " " }, Buffer.from("a"), "u")).toThrow(/why is 1 to 600/);
    expect(() => rootStep({ machine: "m", path: "/x.sh", why: "w" }, Buffer.alloc(16 * 1024 + 1, 97), "u")).toThrow(/at most 16384/);
    expect(() => rootStep({ machine: "m", path: "/x.sh", why: "w" }, Buffer.from([0x61, 0, 0x62]), "u")).toThrow(/isn't text/);
    for (const hidden of ["echo hi\r\n", "echo \u202Eih\n", "rm\u200B -rf x\n", "\x1b[2Kecho hi\n"]) {
      expect(() => rootStep({ machine: "m", path: "/x.sh", why: "w" }, Buffer.from(hidden), "u")).toThrow(/invisible characters/);
    }
    expect(rootStep({ machine: "m", path: "/x.sh", why: "w" }, Buffer.from("if x; then\n\techo hi\nfi\n"), "u").script).toContain("\techo");
  });

  it("asks Done or Not now, from the call's arguments alone", () => {
    expect(rootAsk({ machine: "box", why: "Installs Docker." })).toEqual({
      question: "Run as root on box?", context: "Installs Docker.", recommended: 0,
      options: [{ label: "Done", consequence: expect.any(String) }, { label: "Not now", consequence: expect.any(String) }],
    });
    expect(rootAsk({ why: "x" })).toBeUndefined();
  });
});
