import { describe, expect, it } from "vitest";
import { Users } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

describe("subkeys", () => {
  it("derives a stable, separate key per user and purpose", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    const other = await users.createUser("other", "pw", profile("Other"), { admin: false });
    await users.authenticate("ada", "pw");
    await users.authenticate("other", "pw");

    const general = keyring.subkey(ada.id, "pool:general");
    expect(general).toHaveLength(32);
    expect(keyring.subkey(ada.id, "pool:general")).toEqual(general);
    expect(keyring.subkey(ada.id, "pool:private")).not.toEqual(general);
    expect(keyring.subkey(ada.id, "home")).not.toEqual(general);
    expect(keyring.subkey(other.id, "pool:general")).not.toEqual(general);
    expect(general).not.toEqual(keyring.userKey(ada.id));

    keyring.lockUser(ada.id);
    expect(() => keyring.subkey(ada.id, "pool:general")).toThrow(/locked/);
  });
});
