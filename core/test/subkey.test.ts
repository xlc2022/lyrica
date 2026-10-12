import { describe, expect, it } from "vitest";
import { Users } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

describe("subkeys", () => {
  it("derives a stable, separate key per user and purpose", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
    const other = await users.createUser("other", "pw", profile("Other"), { admin: false });
    await users.authenticate("li", "pw");
    await users.authenticate("other", "pw");

    const general = keyring.subkey(li.id, "pool:general");
    expect(general).toHaveLength(32);
    expect(keyring.subkey(li.id, "pool:general")).toEqual(general);
    expect(keyring.subkey(li.id, "pool:private")).not.toEqual(general);
    expect(keyring.subkey(li.id, "home")).not.toEqual(general);
    expect(keyring.subkey(other.id, "pool:general")).not.toEqual(general);
    expect(general).not.toEqual(keyring.userKey(li.id));

    keyring.lockUser(li.id);
    expect(() => keyring.subkey(li.id, "pool:general")).toThrow(/locked/);
  });
});
