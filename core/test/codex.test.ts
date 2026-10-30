import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_DISABLED, codexImage, codexSandbox, codexSignedIn, codexSignIn, codexSignOut, type CodexBox } from "../src/index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");

/**
 * A stand-in `codex`: login status by auth.json, a device sign-in that prints
 * a link and code, and exec that saves one PNG and reports its saved_path.
 * It records its arguments, stdin and when each exec starts and ends next to
 * itself, for the test to read.
 */
const FAKE = `#!/usr/bin/env bash
bin="$(dirname "$0")"
printf '%s\\n' "$@" > "$bin/args"
case "$1 $2" in
  "login status") [ -f "$CODEX_HOME/auth.json" ] ;;
  "login --device-auth") printf '\\e[1mOpen https://auth.openai.com/codex/device\\e[0m\\nEnter ABCD-12345\\n'; sleep 0.2; echo '{}' > "$CODEX_HOME/auth.json" ;;
  "logout ") rm -f "$CODEX_HOME/auth.json" ;;
  "features list") for f in image_generation shell_tool unified_exec browser_use computer_use in_app_browser apps plugins memories goals hooks; do echo "$f  stable  true"; done ;;
  exec*)
    echo start >> "$bin/log"; sleep 0.1
    cat > "$bin/stdin"
    ls "$PWD" > "$bin/inputs"
    [ ! -f "$bin/fail" ] || { echo "$(cat "$bin/fail"): SECRET prompt text" >&2; exit 1; }
    echo '{"type":"thread.started"}'
    # Codex opens its databases whatever --ephemeral says.
    echo x > "$CODEX_HOME/memories_1.sqlite"; echo x > "$CODEX_HOME/logs_2.sqlite-wal"
    if [ -f "$bin/declines" ]; then
      echo '{"type":"item.completed","item":{"type":"agent_message","text":"I can'"'"'t make that image:\\n  it shows a real person."}}'
    elif [ -f "$bin/silent" ]; then
      :
    elif [ -f "$bin/unreported" ]; then
      # As Codex 0.146.0 does: generated_images/<session>/exec-<id>.png, and no saved_path in its events.
      mkdir -p "$CODEX_HOME/generated_images/s1"
      base64 -d > "$CODEX_HOME/generated_images/s1/exec-1.png" <<< "${png.toString("base64")}"
      if [ -f "$bin/twice" ]; then
        # A second image a few seconds later, in a session of its own: Lyrica stops Codex first.
        sleep 5 >/dev/null 2>&1 & wait $!
        mkdir -p "$CODEX_HOME/generated_images/s2"
        base64 -d > "$CODEX_HOME/generated_images/s2/exec-2.png" <<< "${png.toString("base64")}"
        echo second >> "$bin/log"
      fi
      echo '{"type":"item.completed","item":{"type":"agent_message","text":"SECRET done"}}'
    else
      mkdir -p "$CODEX_HOME/generated_images/t1"
      base64 -d > "$CODEX_HOME/generated_images/t1/ig_1.png" <<< "${png.toString("base64")}"
      echo '{"type":"item.completed","item":{"type":"image_generation","saved_path":"'"$CODEX_HOME"'/generated_images/t1/ig_1.png"}}'
    fi
    echo end >> "$bin/log"
    ;;
esac
`;

let bin: string, home: string, box: CodexBox;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "codex-bin-"));
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(bin, "codex"), FAKE);
  chmodSync(join(bin, "codex"), 0o755);
  // Codex sees its home at another path, as in the sandbox: here a link to it.
  const inner = join(bin, "inner");
  symlinkSync(home, inner);
  box = {
    home, inner, installed: true,
    start: async (args, cwd) => spawn(join(bin, "codex"), args, { cwd: cwd ?? inner, env: { PATH: process.env.PATH, CODEX_HOME: inner } }),
  };
});
afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("ChatGPT Images through the user's own Codex (principles 1 and 2)", () => {
  it("signs in with Codex's device sign-in and out again", async () => {
    expect(await codexSignedIn(box)).toBe(false);
    const signIn = await codexSignIn(box);
    expect(signIn).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345" });
    expect(await signIn.done).toBe(true);
    expect(await codexSignedIn(box)).toBe(true);
    await codexSignOut(box);
    expect(await codexSignedIn(box)).toBe(false);
  });

  it("makes and edits an image, sending the prompt on stdin and leaving no files behind", async () => {
    writeFileSync(join(home, "auth.json"), "{}");
    // A call a restart cut short left its input behind; the next call takes it away.
    mkdirSync(join(home, "calls", "cut-short"), { recursive: true });
    writeFileSync(join(home, "calls", "cut-short", "input-0.png"), png);
    const [made] = await codexImage(box, { action: "create", prompt: "A garden", tier: "quality", size: { width: 1024, height: 1536 } });
    expect(made).toMatchObject({ type: "image/png", width: 1, height: 1 });
    const args = readFileSync(join(bin, "args"), "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--enable", "image_generation", "-"]));
    // Codex's own tools are off; Lyrica's sandbox is the fence.
    for (const f of ["shell_tool", "unified_exec", "browser_use", "computer_use", "apps", "plugins"]) expect(CODEX_DISABLED).toContain(f);
    // Every one this Codex lists is off; one it doesn't list (view_image here) isn't passed.
    for (const f of CODEX_DISABLED.filter((f) => f !== "view_image")) expect(args[args.indexOf(f) - 1]).toBe("--disable");
    expect(args).not.toContain("view_image");
    expect(args.join(" ")).not.toContain("A garden");
    expect(readFileSync(join(bin, "stdin"), "utf8")).toMatch(/Generate one image[\s\S]*portrait[\s\S]*Prompt:\nA garden$/);
    await codexImage(box, { action: "edit", prompt: "Add flowers", image: { bytes: png, type: "image/png" }, references: [{ bytes: png, type: "image/jpeg" }] });
    expect(readFileSync(join(bin, "inputs"), "utf8").split("\n").filter(Boolean)).toEqual(["input-0.png", "input-1.jpg"]);
    expect(readFileSync(join(bin, "args"), "utf8")).toMatch(/--image\n.*input-0\.png\n--image\n.*input-1\.jpg/);
    expect(readdirSync(join(home, "calls"))).toEqual([]);
    expect(existsSync(join(home, "generated_images", "t1"))).toBe(false);
    // Only the sign-in outlasts a call.
    expect(readdirSync(home).sort()).toEqual(["auth.json", "calls"]);
  });

  it("runs in a sandbox of its own with only its home and the internet, one call at a time", async () => {
    expect(codexSandbox(home, { exclude: [7000], front: [443] })).toEqual({
      exclude: [7000], front: [443], workdir: home, grants: [], network: { internet: true, services: false, hosts: [] },
    });
    writeFileSync(join(home, "auth.json"), "{}");
    await Promise.all([1, 2].map(() => codexImage(box, { action: "create", prompt: "A garden", tier: "fast" })));
    expect(readFileSync(join(bin, "log"), "utf8").split("\n").filter(Boolean)).toEqual(["start", "end", "start", "end"]);
  });

  it("finds an image Codex saved without reporting it, logs no text, and leaves generated_images empty", async () => {
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(bin, "unreported"), "");
    // A leftover from an earlier call is never taken for this one's.
    mkdirSync(join(home, "generated_images", "old"), { recursive: true });
    writeFileSync(join(home, "generated_images", "old", "stale.txt"), "x");
    const lines: string[] = [];
    const [made] = await codexImage({ ...box, log: (l) => lines.push(l) }, { action: "create", prompt: "A garden", tier: "fast" });
    expect(made).toMatchObject({ type: "image/png", width: 1, height: 1 });
    expect(lines).toEqual(["codex exec: exit 0, 1 image file saved, events: thread.started, item.completed:agent_message"]);
    expect(existsSync(join(home, "generated_images"))).toBe(false);
  });

  it("stops Codex once it has saved one image, so a second can't spend the plan", async () => {
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(bin, "unreported"), "");
    writeFileSync(join(bin, "twice"), "");
    const lines: string[] = [];
    const started = Date.now();
    const made = await codexImage({ ...box, log: (l) => lines.push(l) }, { action: "create", prompt: "A garden", tier: "fast" });
    expect(made).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readFileSync(join(bin, "log"), "utf8")).not.toContain("second");
    expect(lines[0]).toMatch(/^codex exec: stopped after its image, 1 image file saved/);
    expect(existsSync(join(home, "generated_images"))).toBe(false);
  });

  it("answers a failed run with a fixed line, never Codex's own output, and refuses what it can't do", async () => {
    await expect(codexImage(box, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "invalid", message: "Codex is signed out: sign in under Settings → Claude Code and Codex." });
    writeFileSync(join(home, "auth.json"), "{}");
    // Codex gets none of the daemon's environment, so the stand-in reads its failure from a file.
    writeFileSync(join(bin, "fail"), "You've hit your usage limit");
    await expect(codexImage(box, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "unavailable", message: "Codex reached its usage limit." });
    writeFileSync(join(bin, "fail"), "boom");
    await expect(codexImage(box, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ message: "Codex couldn't make the image." });
    await expect(codexImage(box, { action: "edit", prompt: "x", image: { bytes: png, type: "image/png" }, mask: { bytes: png, type: "image/png" } })).rejects.toMatchObject({ code: "unsupported" });
    rmSync(join(bin, "fail"));
    writeFileSync(join(bin, "silent"), "");
    await expect(codexImage(box, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "unavailable", message: "Codex returned no image." });
  });

  it("passes on Codex's reason when it declines, as a refusal, and keeps it out of the journal", async () => {
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(bin, "declines"), "");
    const lines: string[] = [];
    await expect(codexImage({ ...box, log: (l) => lines.push(l) }, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({
      code: "image_refusal", message: `Codex made no image (image_refusal). It said: "I can't make that image: it shows a real person."` });
    expect(lines).toEqual(["codex exec: exit 0, 0 image files saved, events: thread.started, item.completed:agent_message"]);
    expect(readdirSync(home).sort()).toEqual(["auth.json", "calls"]);
  });
});
