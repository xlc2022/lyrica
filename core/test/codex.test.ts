import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexImage, codexSignedIn, codexSignIn, codexSignOut } from "../src/index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");

/**
 * A stand-in `codex`: login status by auth.json, a device sign-in that prints
 * a link and code, and exec that saves one PNG and reports its saved_path.
 * It records its arguments and stdin next to itself, for the test to read.
 */
const FAKE = `#!/usr/bin/env bash
bin="$(dirname "$0")"
printf '%s\\n' "$@" > "$bin/args"
case "$1 $2" in
  "login status") [ -f "$CODEX_HOME/auth.json" ] ;;
  "login --device-auth") printf '\\e[1mOpen https://auth.openai.com/codex/device\\e[0m\\nEnter ABCD-12345\\n'; sleep 0.2; echo '{}' > "$CODEX_HOME/auth.json" ;;
  "logout ") rm -f "$CODEX_HOME/auth.json" ;;
  exec*)
    cat > "$bin/stdin"
    ls "$PWD" > "$bin/inputs"
    [ ! -f "$bin/fail" ] || { echo "$(cat "$bin/fail"): SECRET prompt text" >&2; exit 1; }
    mkdir -p "$CODEX_HOME/generated_images/t1"
    base64 -d > "$CODEX_HOME/generated_images/t1/ig_1.png" <<< "${png.toString("base64")}"
    echo '{"type":"thread.started"}'
    echo '{"type":"item.completed","item":{"type":"image_generation","saved_path":"'"$CODEX_HOME"'/generated_images/t1/ig_1.png"}}'
    ;;
esac
`;

let bin: string, home: string, path: string | undefined;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "codex-bin-"));
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(bin, "codex"), FAKE);
  chmodSync(join(bin, "codex"), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
});
afterEach(() => {
  process.env.PATH = path;
  rmSync(bin, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("ChatGPT Images through the user's own Codex (principles 1 and 2)", () => {
  it("signs in with Codex's device sign-in and out again", async () => {
    expect(await codexSignedIn(home)).toBe(false);
    const signIn = await codexSignIn(home);
    expect(signIn).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345" });
    expect(await signIn.done).toBe(true);
    expect(await codexSignedIn(home)).toBe(true);
    await codexSignOut(home);
    expect(await codexSignedIn(home)).toBe(false);
  });

  it("makes and edits an image, sending the prompt on stdin and leaving no files behind", async () => {
    writeFileSync(join(home, "auth.json"), "{}");
    const [made] = await codexImage(home, { action: "create", prompt: "A garden", tier: "quality", size: { width: 1024, height: 1536 } });
    expect(made).toMatchObject({ type: "image/png", width: 1, height: 1 });
    const args = readFileSync(join(bin, "args"), "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--sandbox", "read-only", "--enable", "image_generation", "-"]));
    expect(args.join(" ")).not.toContain("A garden");
    expect(readFileSync(join(bin, "stdin"), "utf8")).toMatch(/Generate one image[\s\S]*portrait[\s\S]*Prompt:\nA garden$/);
    await codexImage(home, { action: "edit", prompt: "Add flowers", image: { bytes: png, type: "image/png" }, references: [{ bytes: png, type: "image/jpeg" }] });
    expect(readFileSync(join(bin, "inputs"), "utf8").split("\n").filter(Boolean)).toEqual(["input-0.png", "input-1.jpg"]);
    expect(readFileSync(join(bin, "args"), "utf8")).toMatch(/--image\n.*input-0\.png\n--image\n.*input-1\.jpg/);
    expect(readdirSync(join(home, "calls"))).toEqual([]);
    expect(existsSync(join(home, "generated_images", "t1"))).toBe(false);
  });

  it("answers with fixed lines, never Codex's own output, and refuses what it can't do", async () => {
    await expect(codexImage(home, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "invalid", message: "Codex is signed out: sign in under Settings → Codex." });
    writeFileSync(join(home, "auth.json"), "{}");
    // Codex gets none of the daemon's environment, so the stand-in reads its failure from a file.
    writeFileSync(join(bin, "fail"), "You've hit your usage limit");
    await expect(codexImage(home, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "unavailable", message: "Codex reached its usage limit." });
    writeFileSync(join(bin, "fail"), "boom");
    await expect(codexImage(home, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ message: "Codex couldn't make the image." });
    await expect(codexImage(home, { action: "edit", prompt: "x", image: { bytes: png, type: "image/png" }, mask: { bytes: png, type: "image/png" } })).rejects.toMatchObject({ code: "unsupported" });
  });
});
