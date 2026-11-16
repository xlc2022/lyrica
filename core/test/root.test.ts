import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSudoers, Masker, rootAsk, rootStep, secretAsk, secretMasks, secretStep, sudoersCommand, sudoRunCommand } from "../src/index.ts";

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
    // The cleanup keeps the chain's status: a refused hash exits 1 for the person, not the rm's 0.
    expect(step.command).toBe(`f=$(mktemp) && cat '/home/lyrica/it'\\''s.sh' > "$f" && echo '${step.sha256}  '"$f" | sha256sum -c --quiet - && sudo bash "$f"; rc=$?; rm -f "$f"; (exit $rc)`);
    expect(step.why).toBe("Installs Docker.");
    expect(step.sudoers).toBeUndefined();
    // The copy runs under the shell the first line asks for: sh or dash as sh, anything else (or no shebang) as bash.
    for (const first of ["#!/bin/sh", "#!/usr/bin/sh", "#!/usr/bin/env sh", "#!/bin/dash", "#! /bin/sh -e"]) {
      expect(rootStep({ machine: "box", path: "/x.sh", why: "w" }, Buffer.from(`${first}\necho hi\n`), "u").command).toContain('sudo sh "$f"');
    }
    for (const first of ["#!/bin/bash", "#!/usr/bin/env bash", "#!/bin/shell", "echo hi"]) {
      expect(rootStep({ machine: "box", path: "/x.sh", why: "w" }, Buffer.from(`${first}\necho hi\n`), "u").command).toContain('sudo bash "$f"');
    }
  });

  it("carries the command that adds offered lines, as the card shows them: the file's own lines read first, each line quoted, checked beside the file by visudo before it replaces it", () => {
    const l1 = line("/usr/bin/systemctl restart ssh"), l2 = line("/usr/bin/nvidia-smi \"\"");
    const step = rootStep({ machine: "box", path: "/home/lyrica/x.sh", why: "w", sudoers: [` ${l1} `, `${l2}\n`] }, Buffer.from("echo hi\n"), "lyrica");
    expect(step.sudoers?.map((l) => l.line)).toEqual([l1, l2]);
    expect(step.sudoersCommand).toBe("f=$(mktemp) && g=$(mktemp) && { sudo test ! -e /etc/sudoers.d/lyrica || sudo cat /etc/sudoers.d/lyrica; } > \"$f\""
      + ` && { awk 1 "$f"; printf '%s\\n' '${l1}' '${l2}'; } | awk '!seen[$0]++' > "$g" && sudo install -m 0440 -o root -g root "$g" /etc/sudoers.d/lyrica.new`
      + ' && sudo visudo -c -f /etc/sudoers.d/lyrica.new && sudo mv -f /etc/sudoers.d/lyrica.new /etc/sudoers.d/lyrica; rc=$?; sudo -n rm -f /etc/sudoers.d/lyrica.new 2>/dev/null; rm -f "$f" "$g"; (exit $rc)');
    // The lines are checked first, so a refused one never reaches the command.
    expect(() => rootStep({ machine: "box", path: "/x.sh", why: "w", sudoers: [line("/usr/bin/apt-get install *")] }, Buffer.from("a"), "lyrica")).toThrow();
  });

  describe("the sudoers command, run with a stub sudo", () => {
    // `sudo` here runs its command as the test user, with root's ownership flags dropped; `visudo` passes; `cat` can be made to fail, as a mistyped password does.
    const run = (file: string, lines: string[], catFails = false) => {
      const bin = join(file, "..", "..", "bin");
      writeFileSync(join(bin, "sudo"), `#!/bin/bash\n[ "$1" = -n ] && shift\ncase "$1" in\n  cat) ${catFails ? "exit 1" : 'exec cat "\${@:2}"'} ;;\n  visudo) exit 0 ;;\n  install) exec install -m 0440 "\${@:8}" ;;\n  *) exec "$@" ;;\nesac\n`);
      chmodSync(join(bin, "sudo"), 0o755);
      try { execFileSync("bash", ["-c", sudoersCommand(lines, file)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" }); return 0; }
      catch (e) { return (e as { status: number }).status; }
    };
    const setup = () => { const dir = mkdtempSync(join(tmpdir(), "lyrica-sudoers-")); mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "etc")); return join(dir, "etc", "lyrica"); };

    it("keeps the file's lines, adds each new line once, gives a last line its newline, and leaves nothing beside the file", () => {
      const file = setup();
      writeFileSync(file, `${line("/usr/bin/true x")}\n${line("/usr/bin/systemctl restart ssh")}`);
      expect(run(file, [line("/usr/bin/systemctl restart ssh"), line("/usr/bin/nvidia-smi \"\"")])).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(`${line("/usr/bin/true x")}\n${line("/usr/bin/systemctl restart ssh")}\n${line("/usr/bin/nvidia-smi \"\"")}\n`);
      expect(existsSync(`${file}.new`)).toBe(false);
      rmSync(join(file, "..", ".."), { recursive: true, force: true });
    });

    it("makes the file when there is none, and installs nothing when reading the old file fails", () => {
      const file = setup();
      expect(run(file, [line("/usr/bin/true x")])).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(`${line("/usr/bin/true x")}\n`);
      // A failed sudo cat (the password mistyped) stops the chain: the old lines stay, and the new ones aren't installed alone.
      expect(run(file, [line("/usr/bin/false y")], true)).not.toBe(0);
      expect(readFileSync(file, "utf8")).toBe(`${line("/usr/bin/true x")}\n`);
      expect(existsSync(`${file}.new`)).toBe(false);
      rmSync(join(file, "..", ".."), { recursive: true, force: true });
    });
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

  it("asks Done, Not now or Run, keeping the stored answers' numbers, from the call's arguments alone", () => {
    expect(rootAsk({ machine: "box", why: "Installs Docker." })).toEqual({
      question: "Run as root on box?", context: "Installs Docker.", recommended: 0,
      options: [{ label: "Done", consequence: expect.any(String) }, { label: "Not now", consequence: expect.any(String) }, { label: "Run", consequence: expect.any(String), secret: true }],
    });
    expect(rootAsk({ why: "x" })).toBeUndefined();
  });
});

describe("a secret on a card", () => {
  // Runs a card's command as lyricad would, with `input` on its standard input and a stub `sudo` that checks the password line.
  const runCard = (command: string, input: string) => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-secret-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "sudo"), `#!/bin/bash
[ "$1 $2 $3 $4" = "-S -k -p " ] || exit 9
IFS= read -r pw; [ "$pw" = hunter2 ] || { echo "Sorry, try again." >&2; exit 1; }
shift 4; exec "$@"
`);
    chmodSync(join(dir, "bin", "sudo"), 0o755);
    try { return execFileSync("bash", ["-c", command], { input, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, stdio: "pipe" }).toString(); }
    catch (e) { return `exit ${(e as { status: number }).status}`; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const script = (dir: string, text: string) => { const path = join(dir, "s.sh"); writeFileSync(path, text); return path; };

  it("reads the script into a card labelled with the secret's name, and asks Run or Not now", () => {
    const step = secretStep({ machine: "box", path: "/home/lyrica/join.sh", why: "Joins the tailnet.", secret: " Tailscale auth key " }, Buffer.from("read -r k\n"));
    expect(step).toMatchObject({ secret: "Tailscale auth key", why: "Joins the tailnet.", sha256: createHash("sha256").update("read -r k\n").digest("hex") });
    expect(step.command).not.toContain("sudo");
    expect(secretStep({ machine: "box", path: "/k.sh", why: "w", secret: "Deploy key", lines: true }, Buffer.from("x")).lines).toBe(true);
    expect(() => secretStep({ machine: "box", path: "/k.sh", why: "w", secret: "" }, Buffer.from("x"))).toThrow(/label, 1 to 40/);
    expect(() => secretStep({ machine: "box", path: "/k.sh", why: "w", secret: "a\nb" }, Buffer.from("x"))).toThrow(/one line/);
    expect(secretAsk({ machine: "box", why: "w", secret: "Tailscale auth key" })?.options.map((o) => [o.label, !!o.secret])).toEqual([["Run", true], ["Not now", false]]);
  });

  it("gives the secret to the script's input only when the script is the one the card hashed", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-card-"));
    const path = script(dir, "IFS= read -r k\necho \"got ${#k} characters\"\n");
    const step = secretStep({ machine: "box", path, why: "w", secret: "Key" }, readFileSync(path));
    expect(runCard(step.command, "tskey-abc\n")).toBe("got 9 characters\n");
    writeFileSync(path, "IFS= read -r k\necho \"$k\"\n");
    expect(runCard(step.command, "tskey-abc\n")).toMatch(/^exit [1-9]/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a root step with the typed password as sudo's first line, and the rest as the script's input", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-card-"));
    const path = script(dir, "echo ran as root step\n");
    const step = rootStep({ machine: "box", path, why: "w" }, readFileSync(path), "lyrica");
    expect(runCard(sudoRunCommand(path, step.sha256), "hunter2\n")).toBe("ran as root step\n");
    expect(runCard(sudoRunCommand(path, step.sha256), "wrong\n")).toBe("exit 1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("masks the secret in output that comes in pieces, a key's long lines too, and wipes what it held", () => {
    const masks = secretMasks(Buffer.from("-----BEGIN KEY-----\nAAAAB3NzaC1yc2E\nxyz\n-----END KEY-----\n"));
    expect(masks.map(String)).toEqual(["-----BEGIN KEY-----\nAAAAB3NzaC1yc2E\nxyz\n-----END KEY-----", "-----BEGIN KEY-----", "-----END KEY-----", "AAAAB3NzaC1yc2E"]);
    const m = new Masker(secretMasks(Buffer.from("hunter2\n")));
    const out = [m.push(Buffer.from("pass: hun")), m.push(Buffer.from("ter2 ok\nhunter")), m.push(Buffer.from("2")), m.end()];
    expect(Buffer.concat(out).toString()).toBe("pass: [secret] ok\n[secret]");
    const held = secretMasks(Buffer.from("hunter2"));
    new Masker(held).wipe();
    expect(held[0]!.every((b) => b === 0)).toBe(true);
  });
});
