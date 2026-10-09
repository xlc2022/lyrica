import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthError, Forbidden, Keyring, Users, WrongPassword } from "../src/index.ts";
import { freshKeyring } from "./helpers.ts";

describe("users and keys", () => {
  it("refuses a wrong password and leaves the user locked", async () => {
    const users = new Users(await freshKeyring());
    await users.createUser("Xu", "right", { admin: true });
    await expect(users.authenticate("Xu", "wrong")).rejects.toBeInstanceOf(AuthError);
    await expect(users.authenticate("nobody", "right")).rejects.toBeInstanceOf(AuthError);
    expect(() => users.openUserDb(users.find("Xu")!.id)).toThrow(/locked/);
  });

  it("refuses a wrong self.db passphrase", async () => {
    const keyring = await freshKeyring();
    const again = new Keyring(keyring.home);
    await expect(again.unlockSelf("not it")).rejects.toBeInstanceOf(WrongPassword);
    await again.unlockSelf("passphrase");
  });

  it("keeps data readable after a password change", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const xu = await users.createUser("Xu", "old", { admin: true });
    await users.authenticate("Xu", "old");
    const db = users.openUserDb(xu.id);
    db.prepare("INSERT INTO settings (key, value) VALUES ('favourite', 'Satie')").run();
    db.close();
    keyring.lockUser(xu.id);

    await expect(users.changePassword(xu, "wrong", "new")).rejects.toBeInstanceOf(AuthError);
    await users.changePassword(xu, "old", "new");
    await expect(users.authenticate("Xu", "old")).rejects.toBeInstanceOf(AuthError);
    await users.authenticate("Xu", "new");
    const reopened = users.openUserDb(xu.id);
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'favourite'").get()).toEqual({ value: "Satie" });
    reopened.close();
  });

  it("never writes user data in plaintext", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const xu = await users.createUser("Xu-plaintext-marker", "pw", { admin: true });
    expect(readFileSync(join(users.userDir(xu.id), "user.db")).includes("Xu-plaintext-marker")).toBe(false);
    keyring.self().close();
    expect(readFileSync(keyring.selfPath).includes("Xu-plaintext-marker")).toBe(false);
  });

  it("requires the first user to be an administrator", async () => {
    const users = new Users(await freshKeyring());
    await expect(users.createUser("Mina", "pw", { admin: false })).rejects.toThrow(/first user/);
  });

  it("won't demote the last administrator", async () => {
    const users = new Users(await freshKeyring());
    const xu = await users.createUser("Xu", "pw", { admin: true });
    const mina = await users.createUser("Mina", "pw", { admin: false });

    expect(() => users.setAdmin(xu, xu, false)).toThrow(Forbidden);
    expect(() => users.setAdmin(mina, mina, true)).toThrow(Forbidden);

    users.setAdmin(xu, mina, true);
    users.setAdmin(users.find("Mina")!, xu, false);
    expect(() => users.setAdmin(users.find("Mina")!, mina, false)).toThrow(/last administrator/);
    expect(users.listUsers(xu)).toEqual([{ ...xu, admin: false }]);
    expect(users.listUsers(users.find("Mina")!).map((u) => u.name)).toEqual(["Xu", "Mina"]);
  });
});
