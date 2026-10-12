// Changing the self.db passphrase (POST …/admin/passphrase/change, `lyrica admin passphrase`).
import { describe, expect, it } from "vitest";
import type { AdminStatus } from "../src/api.ts";
import { browser, daemon, login, runtime } from "./helpers.ts";

describe("changing the self.db passphrase", () => {
  it("is for administrators, refuses a wrong current passphrase and an empty new one, and takes effect at once", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const lu = `/api/u/${rt.ada.id}`;
    // Sam is logged in as herself, so she reaches the admin gate and fails it; posting into Ada's namespace would be a 401 first.
    expect((await sam.post(`/api/u/${rt.sam.id}/admin/passphrase/change`, { current: "passphrase", next: "fresh" })).status).toBe(403);
    const wrong = await ada.post<{ error: string }>(`${lu}/admin/passphrase/change`, { current: "not-it", next: "fresh" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("That isn't the current passphrase.");
    expect((await ada.post(`${lu}/admin/passphrase/change`, { current: "passphrase", next: "" })).status).toBe(400);
    // The change answers AdminStatus; her threads still answer on the open connection.
    const changed = await ada.post<AdminStatus>(`${lu}/admin/passphrase/change`, { current: "passphrase", next: "fresh" });
    expect(changed.status).toBe(200);
    expect(changed.body.savedPassphrase).toBe(false);
    expect((await ada.get(`/api/u/${rt.ada.id}/threads`)).status).toBe(200);
  });

  it("rekeys the file: after a restart only the new passphrase opens it, and a saved one is re-saved", async () => {
    const rt = await runtime();
    const { base, stop } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    expect((await ada.post(`/api/u/${rt.ada.id}/admin/passphrase/change`, { current: "passphrase", next: "fresh" })).status).toBe(200);
    await stop();
    const lockedAgain = await daemon(rt);
    const stopAgain = lockedAgain.stop;
    expect(lockedAgain.d.locked).toBe(true);
    expect((await browser(lockedAgain.base).post("/api/unlock", { passphrase: "passphrase" })).status).toBe(401);
    expect((await browser(lockedAgain.base).post("/api/unlock", { passphrase: "fresh" })).status).toBe(200);
    // A saved passphrase is re-saved with the new one, so she still starts unlocked.
    const ada2 = await login(lockedAgain.base, "ada", "pw");
    expect((await ada2.put(`/api/u/${rt.ada.id}/admin/passphrase`, { save: true, passphrase: "fresh" })).status).toBe(200);
    // Changing it again re-saves the saved copy with the newer passphrase.
    expect((await ada2.post(`/api/u/${rt.ada.id}/admin/passphrase/change`, { current: "fresh", next: "fresher" })).status).toBe(200);
    expect(rt.secrets.get("lyrica_self")?.toString()).toBe("fresher");
    await stopAgain();
    const restarted = await daemon(rt);
    expect(restarted.d.locked).toBe(false);
  });
});
