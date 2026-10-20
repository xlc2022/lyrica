import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openEncrypted, wipePools, type Keyring, type Users } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A user's folder holding the given files, and the keyring and users wipePools needs. */
function home(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "lyrica-wipe-")); dirs.push(root);
  const dir = join(root, "ada"); mkdirSync(dir);
  for (const f of files) writeFileSync(join(dir, f), f);
  const self = openEncrypted(join(root, "self.db"), { raw: Buffer.alloc(32, 7) });
  migrate(self, "self");
  const keyring = { self: () => self } as unknown as Keyring;
  const users = { all: () => [{ id: "ada" }], userDir: () => dir } as unknown as Users;
  return { dir, wipe: (keep: boolean) => wipePools(keyring, users, undefined, keep), files: () => readdirSync(dir).sort() };
}

describe("wipePools keeping skills", () => {
  it("sets each pool aside with its WAL files, whatever order the folder lists them in", () => {
    const h = home(["general.db-wal", "general.db", "general.db-shm", "private.db", "user.db"]);
    h.wipe(true);
    expect(h.files()).toEqual(["general.keep.db", "general.keep.db-shm", "general.keep.db-wal", "private.keep.db", "user.db"]);
  });

  it("leaves a pool already set aside as it is, and a wipe without keeping deletes it", () => {
    const h = home(["general.keep.db", "general.keep.db-wal", "general.db", "general.db-wal", "user.db"]);
    h.wipe(true);
    expect(h.files()).toEqual(["general.keep.db", "general.keep.db-wal", "user.db"]);
    h.wipe(false);
    expect(h.files()).toEqual(["user.db"]);
  });
});
