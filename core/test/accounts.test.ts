import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthError, Forbidden, Keyring, PRONOUN_PRESETS, Users, WrongPassword } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

describe("users and keys", () => {
  it("refuses a wrong password and leaves the user locked", async () => {
    const users = new Users(await freshKeyring());
    await users.createUser("li", "right", profile("Ada"), { admin: true });
    await expect(users.authenticate("li", "wrong")).rejects.toBeInstanceOf(AuthError);
    await expect(users.authenticate("nobody", "right")).rejects.toBeInstanceOf(AuthError);
    expect(() => users.openUserDb(users.find("li")!.id)).toThrow(/locked/);
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
    const li = await users.createUser("li", "old", profile("Ada"), { admin: true });
    await users.authenticate("li", "old");
    const db = users.openUserDb(li.id);
    db.prepare("INSERT INTO settings (key, value) VALUES ('favourite', 'Satie')").run();
    db.close();
    keyring.lockUser(li.id);

    await expect(users.changePassword(li, "wrong", "new")).rejects.toBeInstanceOf(AuthError);
    await users.changePassword(li, "old", "new");
    await expect(users.authenticate("li", "old")).rejects.toBeInstanceOf(AuthError);
    await users.authenticate("li", "new");
    const reopened = users.openUserDb(li.id);
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'favourite'").get()).toEqual({ value: "Satie" });
    reopened.close();
  });

  it("never writes user data in plaintext", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const li = await users.createUser("plaintextmarker", "pw", profile("PlaintextMarker"), { admin: true });
    expect(readFileSync(join(users.userDir(li.id), "user.db")).includes("PlaintextMarker")).toBe(false);
    keyring.self().close();
    expect(readFileSync(keyring.selfPath).includes("PlaintextMarker")).toBe(false);
  });

  it("requires the first user to be an administrator", async () => {
    const users = new Users(await freshKeyring());
    await expect(users.createUser("Mina", "pw", profile("Mina"), { admin: false })).rejects.toThrow(/first user/);
  });

  it("won't demote the last administrator", async () => {
    const users = new Users(await freshKeyring());
    const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
    const mina = await users.createUser("Mina", "pw", profile("Mina"), { admin: false });

    expect(() => users.setAdmin(li, li, false)).toThrow(Forbidden);
    expect(() => users.setAdmin(mina, mina, true)).toThrow(Forbidden);

    users.setAdmin(li, mina, true);
    users.setAdmin(users.find("Mina")!, li, false);
    expect(() => users.setAdmin(users.find("Mina")!, mina, false)).toThrow(/last administrator/);
    expect(users.listUsers(users.find("li")!)).toEqual([{ ...li, admin: false }]);
    expect(users.listUsers(users.find("Mina")!).map((u) => u.login)).toEqual(["li", "Mina"]);
  });
});

describe("profiles", () => {
  it("keeps the login separate and records renames with a date", async () => {
    const users = new Users(await freshKeyring());
    const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
    const p = users.updateProfile(li, li, { displayName: "Lin", pronouns: PRONOUN_PRESETS.they });
    expect(p.displayName).toBe("Lin");
    expect(p.pronouns.obj).toBe("them");
    expect(p.previousNames).toEqual([{ name: "Ada", until: new Date().toISOString().slice(0, 10) }]);
    expect(users.find("li")!.profile).toEqual(p);
    await users.authenticate("li", "pw");

    users.updateProfile(li, li, { pronouns: PRONOUN_PRESETS.she }); // no rename, no new entry
    expect(users.get(li.id)!.profile.previousNames).toHaveLength(1);
  });

  it("lets only the user or an administrator change a profile", async () => {
    const users = new Users(await freshKeyring());
    const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
    const mina = await users.createUser("mina", "pw", profile("Mina"), { admin: false });
    expect(() => users.updateProfile(mina, li, { displayName: "X" })).toThrow(Forbidden);
    users.updateProfile(mina, mina, { displayName: "Mina R." });
    users.updateProfile(li, mina, { displayName: "Mina" }); // while Mina is locked
    expect(users.get(mina.id)!.profile.previousNames.map((n) => n.name)).toEqual(["Mina", "Mina R."]);
    expect(() => users.updateProfile(li, li, { displayName: " " })).toThrow(/empty/);
  });
});
