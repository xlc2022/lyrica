import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const host = new URL("..", import.meta.url).pathname;
const sh = (dir: string, script: string, env: Record<string, string> = {}) =>
  execFileSync("bash", ["-c", `. ${join(host, "prebuilt.sh")}; ${script}`], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" }).trim();

describe("the CMP's prebuilt images", () => {
  it("are tagged by what goes into them, so a host asks for the image that matches its code", () => {
    const copy = mkdtempSync(join(tmpdir(), "lyrica-prebuilt-"));
    cpSync(join(host, "llamacpp"), join(copy, "llamacpp"), { recursive: true });
    const tag = sh(host, "prebuilt_tag llamacpp");
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(sh(copy, "prebuilt_tag llamacpp")).toBe(tag);
    expect(sh(host, "prebuilt_tag sdcpp")).not.toBe(tag);
    const dockerfile = join(copy, "llamacpp", "Dockerfile");
    writeFileSync(dockerfile, readFileSync(dockerfile, "utf8").replace("b11459", "b11460"));
    expect(sh(copy, "prebuilt_tag llamacpp")).not.toBe(tag);
  });

  it("live in one registry setting", () => {
    expect(sh(host, "prebuilt_image sdcpp")).toMatch(/^ghcr\.io\/xlc2022\/lyrica-host-sdcpp:[0-9a-f]{16}$/);
    expect(sh(host, "prebuilt_image sdcpp", { LYRICA_HOST_REGISTRY: "forge.example/lyrica" })).toMatch(/^forge\.example\/lyrica\/lyrica-host-sdcpp:/);
  });

  it("are used only when they cover every GPU of the host", () => {
    const covers = (name: string, archs: string) => sh(host, `prebuilt_covers ${name} "${archs}" && echo yes || echo no`);
    expect(covers("llamacpp", "70-real")).toBe("yes");
    expect(covers("llamacpp", "70-real;86-real;120-real")).toBe("yes");
    expect(covers("llamacpp", "61-real;70-real")).toBe("no");
    expect(covers("sdcpp", "70-real")).toBe("yes");
    expect(covers("sdcpp", "86-real")).toBe("no");
  });

  it("are pulled and checked, and built here when the pull fails or doesn't match", () => {
    // A docker that pulls when PULL is set, labels the image with LABEL and
    // lists DIGESTS as its repository digests.
    const bin = mkdtempSync(join(tmpdir(), "lyrica-docker-"));
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\necho "$*" >>"$LOG"\ncase $1 in pull) [ -n "$PULL" ] ;; image) case $* in *RepoDigests*) printf "$DIGESTS" ;; *) echo "$LABEL" ;; esac ;; esac\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const log = join(bin, "log");
    const pick = (archs: string, start: string, env: Record<string, string>) => {
      writeFileSync(log, "");
      const out = sh(host, `prebuilt_pick llamacpp "${archs}" ${start}; echo "picked=$PREBUILT"`, { PATH: `${bin}:${process.env.PATH}`, LOG: log, ...env });
      return { out, calls: readFileSync(log, "utf8") };
    };
    const image = sh(host, "prebuilt_image llamacpp");
    const tag = image.split(":").pop()!;
    const repo = image.slice(0, -tag.length - 1);
    const pinned = `${repo}@sha256:${"ab".repeat(32)}`;
    const DIGESTS = `other.example/lyrica-host-llamacpp@sha256:${"cd".repeat(32)}\n${pinned}\n`;

    // What was pulled and checked is pinned by its digest.
    expect(pick("70-real", "1", { PULL: "1", LABEL: tag, DIGESTS }).out).toBe(`CMP 100-210: pulled ${pinned}.\npicked=${pinned}`);
    expect(pick("70-real", "1", { PULL: "1", LABEL: tag, DIGESTS: "" }).out).toMatch(new RegExp(`has no digest from ${repo.replaceAll(".", "\\.")}\\.\\npicked=$`));
    expect(pick("70-real", "1", { PULL: "", LABEL: tag }).out).toMatch(/building llamacpp here .*: .* couldn't be pulled\.\npicked=$/);
    expect(pick("70-real", "1", { PULL: "1", LABEL: "0000" }).out).toMatch(/doesn't carry its own tag as its content label\.\npicked=$/);
    // A GPU outside the list is built for here, without asking the registry.
    const odd = pick("61-real;70-real", "1", { PULL: "1", LABEL: tag });
    expect(odd.out).toMatch(/isn't built for CUDA 61-real;70-real\.\npicked=$/);
    expect(odd.calls).toBe("");
    // --no-start writes the choice without pulling.
    const quiet = pick("70-real", "0", { PULL: "", LABEL: "" });
    expect(quiet).toEqual({ out: `picked=${image}`, calls: "" });
  });

  it("leave building to the build overlays, which install.sh adds only as the fallback", () => {
    const read = (f: string) => readFileSync(join(host, f), "utf8");
    for (const f of ["compose.cmp.yaml", "compose.sdcpp.yaml"]) expect(read(f), f).not.toMatch(/\bbuild:/);
    for (const f of ["compose.cmp.build.yaml", "compose.sdcpp.build.yaml"]) expect(read(f), f).toMatch(/build:\n\s+context: \w+\n\s+args:\n\s+CUDA_ARCHS:/);
    expect(read("install.sh")).toMatch(/\[\[ -n \$PREBUILT \]\] \|\| FILES\+=:compose\.cmp\.build\.yaml/);
    expect(read("install.sh")).toMatch(/\[\[ -n \$PREBUILT \]\] \|\| FILES\+=:compose\.sdcpp\.build\.yaml/);
  });
});
