import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthError, Forbidden, Keyring, PRONOUN_PRESETS, Users, WrongPassword } from "../src/index.ts";
import { ARGON2, freshKeyring, KDF_ITER, profile } from "./helpers.ts";

describe("users and keys", () => {
  it("refuses a wrong password and leaves the user locked", async () => {
    const users = new Users(await freshKeyring());
    await users.createUser("ada", "right", profile("Ada"), { admin: true });
    await expect(users.authenticate("ada", "wrong")).rejects.toBeInstanceOf(AuthError);
    await expect(users.authenticate("nobody", "right")).rejects.toBeInstanceOf(AuthError);
    expect(() => users.openUserDb(users.find("ada")!.id)).toThrow(/locked/);
  });

  it("refuses a wrong self.db passphrase", async () => {
    const keyring = await freshKeyring();
    const again = new Keyring(keyring.home, ARGON2, KDF_ITER);
    await expect(again.unlockSelf("not it")).rejects.toBeInstanceOf(WrongPassword);
    await again.unlockSelf("passphrase");
  });

  it("keeps data readable after a password change", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "old", profile("Ada"), { admin: true });
    await users.authenticate("ada", "old");
    const db = users.openUserDb(ada.id);
    db.prepare("INSERT INTO settings (key, value) VALUES ('favourite', 'Satie')").run();
    db.close();
    keyring.lockUser(ada.id);

    await expect(users.changePassword(ada, "wrong", "new")).rejects.toBeInstanceOf(AuthError);
    await users.changePassword(ada, "old", "new");
    await expect(users.authenticate("ada", "old")).rejects.toBeInstanceOf(AuthError);
    await users.authenticate("ada", "new");
    const reopened = users.openUserDb(ada.id);
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'favourite'").get()).toEqual({ value: "Satie" });
    reopened.close();
  });

  it("never writes user data in plaintext", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("plaintextmarker", "pw", profile("PlaintextMarker"), { admin: true });
    expect(readFileSync(join(users.userDir(ada.id), "user.db")).includes("PlaintextMarker")).toBe(false);
    keyring.self().close();
    expect(readFileSync(keyring.selfPath).includes("PlaintextMarker")).toBe(false);
  });

  it("requires the first user to be an administrator", async () => {
    const users = new Users(await freshKeyring());
    await expect(users.createUser("Mina", "pw", profile("Mina"), { admin: false })).rejects.toThrow(/first user/);
  });

  it("won't demote the last administrator", async () => {
    const users = new Users(await freshKeyring());
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    const mina = await users.createUser("Mina", "pw", profile("Mina"), { admin: false });

    expect(() => users.setAdmin(ada, ada, false)).toThrow(Forbidden);
    expect(() => users.setAdmin(mina, mina, true)).toThrow(Forbidden);

    users.setAdmin(ada, mina, true);
    users.setAdmin(users.find("Mina")!, ada, false);
    expect(() => users.setAdmin(users.find("Mina")!, mina, false)).toThrow(/last administrator/);
    expect(users.listUsers(users.find("ada")!)).toEqual([{ ...ada, admin: false }]);
    expect(users.listUsers(users.find("Mina")!).map((u) => u.login)).toEqual(["ada", "Mina"]);
  });
});

describe("profiles", () => {
  it("keeps the login separate and records renames with a date", async () => {
    const users = new Users(await freshKeyring());
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    const p = users.updateProfile(ada, ada, { displayName: "Lin", pronouns: PRONOUN_PRESETS.they });
    expect(p.displayName).toBe("Lin");
    expect(p.pronouns.obj).toBe("them");
    expect(p.previousNames).toEqual([{ name: "Ada", until: new Date().toISOString().slice(0, 10) }]);
    expect(users.find("ada")!.profile).toEqual(p);
    await users.authenticate("ada", "pw");

    users.updateProfile(ada, ada, { pronouns: PRONOUN_PRESETS.she }); // no rename, no new entry
    expect(users.get(ada.id)!.profile.previousNames).toHaveLength(1);

    // A time zone is an IANA name this server knows; null goes back to the server's.
    expect(users.updateProfile(ada, ada, { timeZone: "Europe/Vienna" }).timeZone).toBe("Europe/Vienna");
    expect(users.updateProfile(ada, ada, { displayName: "Lin" }).timeZone).toBe("Europe/Vienna");
    expect(() => users.updateProfile(ada, ada, { timeZone: "Mars/Olympus" })).toThrow(/isn't a time zone/);
    expect(users.updateProfile(ada, ada, { timeZone: null }).timeZone).toBeUndefined();
  });

  it("lets only the user or an administrator change a profile", async () => {
    const users = new Users(await freshKeyring());
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    const mina = await users.createUser("mina", "pw", profile("Mina"), { admin: false });
    expect(() => users.updateProfile(mina, ada, { displayName: "X" })).toThrow(Forbidden);
    users.updateProfile(mina, mina, { displayName: "Mina R." });
    users.updateProfile(ada, mina, { displayName: "Mina" }); // while Mina is locked
    expect(users.get(mina.id)!.profile.previousNames.map((n) => n.name)).toEqual(["Mina", "Mina R."]);
    expect(() => users.updateProfile(ada, ada, { displayName: " " })).toThrow(/empty/);
  });
});
