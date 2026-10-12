import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { Keyring } from "../src/keyring.ts";
import { SystemdCredentials } from "../src/credentials.ts";

const dirs: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "lyrica-creds-")); dirs.push(dir); return dir; }
function child() {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(process as unknown as ReturnType<typeof spawn>);
  return process;
}

describe("saved credentials", () => {
  it("loads through an async unsealer and leaves only the sealed file on disk", async () => {
    const dir = directory();
    const secret = Buffer.from("made-up-passphrase");
    const unseal = vi.fn(async () => { await Promise.resolve(); return secret; });
    const store = new SystemdCredentials(dir, async (_id, _secret, out) => writeFileSync(out, "sealed"), unseal);
    await store.save("self", secret);
    expect(await store.load("self")).toEqual(secret);
    expect(unseal).toHaveBeenCalledWith("lyrica_self", join(dir, "self"));
    expect(readdirSync(dir)).toEqual(["self"]);
    expect(readFileSync(join(dir, "self"), "utf8")).toBe("sealed");
  });

  it("unlocks self.db and a user's saved key at startup, while failed loads stay locked", async () => {
    const home = directory();
    const secrets = new Map<string, Buffer>();
    const store = new SystemdCredentials(join(home, "credentials"), async (id, secret, out) => {
      secrets.set(id, Buffer.from(secret));
      writeFileSync(out, "sealed");
    }, async (id) => {
      await Promise.resolve();
      const secret = secrets.get(id);
      if (!secret) throw new Error("cannot decrypt");
      return Buffer.from(secret);
    }, () => {});
    const first = new Keyring(home);
    first.credentials = store;
    await first.initSelf("made-up-passphrase");
    await first.saveSelfPassphrase("made-up-passphrase");
    const dataKey = Buffer.alloc(32, 7);
    await store.save("user-ada", dataKey);
    first.closeSelf();

    const started = new Keyring(home);
    started.credentials = store;
    try {
      expect(await started.unlockSaved()).toBe(true);
      expect(await started.loadSavedKey("ada")).toBe(true);
      expect(started.userKey("ada")).toEqual(dataKey);
      started.lockUser("ada");
      started.closeSelf();
      secrets.clear();
      expect(await started.unlockSaved()).toBe(false);
      expect(await started.loadSavedKey("ada")).toBe(false);
      expect(started.hasUserKey("ada")).toBe(false);
      expect(() => started.self()).toThrow("self.db is locked");
      expect(readFileSync(join(store.dir, "self"), "utf8")).toBe("sealed");
      expect(readFileSync(join(store.dir, "user-ada"), "utf8")).toBe("sealed");
    } finally {
      started.lockUser("ada");
      started.closeSelf();
    }
  });

  it("treats missing, failed and empty credentials as absent without logging error content", async () => {
    const dir = directory();
    const logs: string[] = [];
    const unseal = vi.fn(async (): Promise<Buffer> => { throw new Error("secret-in-stderr"); });
    const store = new SystemdCredentials(dir, undefined, unseal, (line) => logs.push(line));
    expect(await store.load("self")).toBeUndefined();
    expect(unseal).not.toHaveBeenCalled();
    writeFileSync(join(dir, "self"), "sealed");
    expect(await store.load("self")).toBeUndefined();
    unseal.mockResolvedValueOnce(Buffer.alloc(0));
    expect(await store.load("self")).toBeUndefined();
    expect(logs).toEqual(["credential self: decrypt failed: unseal error", "credential self: decrypt failed: empty output"]);
  });

  it("decrypts user-scoped files through stdout without a plaintext output path", async () => {
    const dir = directory();
    writeFileSync(join(dir, "self"), "sealed");
    const proc = child();
    const loaded = new SystemdCredentials(dir).load("self");
    expect(spawn).toHaveBeenCalledWith("systemd-creds", ["decrypt", "--user", "--name=lyrica_self", join(dir, "self"), "-"], { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.write(Buffer.from("made-up-passphrase"));
    proc.emit("close", 0);
    expect((await loaded)?.toString()).toBe("made-up-passphrase");
    expect(readdirSync(dir)).toEqual(["self"]);
    expect(readFileSync(join(dir, "self"), "utf8")).toBe("sealed");
  });

  it.each(["exit", "missing"])("drops partial stdout on %s failure", async (failure) => {
    const dir = directory();
    writeFileSync(join(dir, "self"), "sealed");
    const logs: string[] = [];
    const proc = child();
    const loaded = new SystemdCredentials(dir, undefined, undefined, (line) => logs.push(line)).load("self");
    proc.stdout.write(Buffer.from("secret-partial-output"));
    if (failure === "missing") proc.emit("error", Object.assign(new Error("secret-error-content"), { code: "ENOENT" }));
    proc.emit("close", failure === "exit" ? 1 : -2);
    expect(await loaded).toBeUndefined();
    expect(logs).toEqual([`credential self: decrypt failed: ${failure === "exit" ? "exit 1" : "command missing"}`]);
  });
});
