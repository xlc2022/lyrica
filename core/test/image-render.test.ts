import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Users, Workspace } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

const has = (name: string) => { try { execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }); return true; } catch { return false; } };
const chromium = has("chromium") || has("chromium-headless-shell") || has("chromium-browser");
const encryptedSandbox = process.getuid?.() !== 0 && has("bwrap") && has("gocryptfs") && has("fusermount3") && existsSync("/dev/fuse");

describe.skipIf(!chromium || !encryptedSandbox)("offline image rendering (principles 1 and 2)", () => {
  it("renders HTML to PNG inside the encrypted thread folder with internet off", async () => {
    const keyring = await freshKeyring(); const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true }); await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    const thread = { userId: ada.id, pool: "private" as const, threadId: "web/render" };
    try {
      await workspace.mountHome(ada.id);
      workspace.settings(ada.id).setThread(thread.threadId, thread.pool, { internet: false, services: false, hosts: [] });
      expect(workspace.network(thread)).toEqual({ internet: false, services: false, hosts: [] });
      const target = workspace.targetFor(thread); const ops = target.ops();
      // Geometry alone: no conversation or prompt text is written to a fixture.
      await ops.write.writeFile("/workspace/diagram.html", "<!doctype html><style>body{margin:0;background:#fff}div{width:200px;height:100px;background:#3050a0}</style><div></div>");
      const command = 'mkdir -p images; browser=$(command -v chromium || command -v chromium-headless-shell || command -v chromium-browser); "$browser" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir=/tmp/chromium --screenshot=/workspace/images/diagram.png --window-size=800,600 file:///workspace/diagram.html';
      const result = await ops.bash.exec(command, "/workspace", { onData: () => {} });
      expect(result.exitCode).toBe(0);
      const bytes = readFileSync(join(workspace.threadDir(thread), "images", "diagram.png"));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(800); expect(bytes.readUInt32BE(20)).toBe(600);
      for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf"]) expect(bytes.includes(Buffer.from(chunk))).toBe(false);
    } finally { await workspace.unmountHome(ada.id); }
  }, 120_000);
});
