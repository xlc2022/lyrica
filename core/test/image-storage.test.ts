import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePhotosDir, ThreadImages, Users, Workspace } from "../src/index.ts";
import { cleanPng } from "../src/models/images.ts";
import { png } from "./fake-images.ts";
import { freshKeyring, profile } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "lyrica-image-files-")); dirs.push(root);
  const home = join(root, "home"); mkdirSync(home); ensurePhotosDir(home);
  const portraits = new Set<string>();
  const files = new ThreadImages(() => home, () => ["threads", "web%2Fa"], async () => ({ stream: Readable.from([png]), size: png.length }),
    { isPortraitImage: hash => portraits.has(hash), recordPortraitImage: hash => { portraits.add(hash); } });
  return { root, home, files };
}
const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }); return true; } catch { return false; } };
const fuse = process.getuid?.() !== 0 && existsSync("/dev/fuse") && has("gocryptfs") && has("fusermount3");
if (process.env.LYRICA_SANDBOX_TESTS === "require" && !fuse) throw new Error("encrypted image home tests require gocryptfs, fusermount3 and /dev/fuse as an unprivileged user");

describe("image storage boundaries (principles 2 and 4)", () => {
  it("marks portrait paths, refuses traversals and symlinks, and sniffs the actual image bytes", async () => {
    const { root, home, files } = setup();
    writeFileSync(join(home, "photos-of-me", "portrait.png"), png);
    expect((await files.read("/photos-of-me/portrait.png")).portrait).toBe(true);
    expect((await files.read("photos-of-me/portrait.png")).portrait).toBe(true);
    expect((await files.read("/workspace/uploads/landscape.png")).portrait).toBe(false);
    symlinkSync(join(home, "photos-of-me", "portrait.png"), join(home, "photos-of-me", "link.png"));
    await expect(files.read("/photos-of-me/link.png")).rejects.toThrow();
    await expect(files.read("/photos-of-me/../portrait.png")).rejects.toThrow(/invalid portrait path/);
    symlinkSync(root, join(home, "photos-of-me", "escape"));
    await expect(files.read("/photos-of-me/escape/portrait.png")).rejects.toThrow();
    writeFileSync(join(home, "photos-of-me", "not-an-image.png"), Buffer.alloc(32));
    await expect(files.read("/photos-of-me/not-an-image.png")).rejects.toThrow(/PNG, JPEG or WebP/);
  });
  it("saves exclusively inside the thread folder, strips metadata again and refuses an images symlink", () => {
    const { root, home, files } = setup();
    const text = Buffer.alloc(18); text.writeUInt32BE(6); text.write("tEXt", 4); text.write("secret", 8);
    const dirty = Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]);
    const paths = files.save([{ ...cleanPng(png), bytes: dirty }]);
    expect(readFileSync(join(home, "threads", "web%2Fa", "images", paths[0]!.split("/").at(-1)!))).toEqual(png);
    expect(files.save([cleanPng(png)])[0]).not.toBe(paths[0]);
    rmSync(join(home, "threads", "web%2Fa", "images"), { recursive: true });
    symlinkSync(root, join(home, "threads", "web%2Fa", "images"));
    expect(() => files.save([cleanPng(png)])).toThrow();
    expect(readdirSync(root)).toEqual(["home"]);
  });
  it("saves a project chat's results in its shared folder, where the chat still shows them", () => {
    const { home } = setup();
    const chat = new ThreadImages(() => home, () => ["threads", "p1"], async () => ({ stream: Readable.from([png]), size: png.length }),
      { isPortraitImage: () => false, recordPortraitImage: () => {} }, () => {}, () => true);
    const [path] = chat.save([cleanPng(png)]);
    expect(path).toMatch(/^\/workspace\/shared\/images\/[0-9a-f-]{36}\.png$/);
    expect(readFileSync(join(home, "threads", "p1", "shared", "images", path!.split("/").at(-1)!))).toEqual(png);
    const shown = chat.content(path!); shown.stream.destroy();
    expect(shown.type).toBe("image/png");
  });
  it("doesn't read portraits or save results while the user's encrypted home is unmounted", async () => {
    const keyring = await freshKeyring(), users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true }); await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const files = workspace.imageFiles({ userId: ada.id, pool: "private", threadId: "web/a" });
    expect(() => files.save([cleanPng(png)])).toThrow(/not mounted/);
    await expect(files.read("/photos-of-me/portrait.png")).rejects.toThrow(/not mounted/);
    keyring.lockUser(ada.id);
    expect(() => files.save([cleanPng(png)])).toThrow(/locked/);
  });
});

describe.skipIf(!fuse)("images in a real encrypted home", () => {
  it("saves under the thread's encrypted folder and keeps no readable PNG on disk after unmount", async () => {
    const keyring = await freshKeyring(), users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true }); await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const t = { userId: ada.id, pool: "private" as const, threadId: "web/a" };
    try {
      await workspace.mountHome(ada.id);
      expect(existsSync(join(workspace.homeDir(ada.id), "photos-of-me"))).toBe(true);
      const [path] = workspace.imageFiles(t).save([cleanPng(png)]);
      expect(readFileSync(join(workspace.threadDir(t), "images", path!.split("/").at(-1)!))).toEqual(png);
    } finally { await workspace.unmountHome(ada.id); }
    expect(readdirSync(workspace.homeDir(ada.id))).toEqual([]);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path); else expect(readFileSync(path).subarray(0, 8)).not.toEqual(png.subarray(0, 8));
      }
    };
    walk(join(users.userDir(ada.id), "home.crypt"));
  });
});
