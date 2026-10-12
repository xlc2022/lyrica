import { chromium, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
const OUT = "/mnt/project-files/web-2/combined";
const b = await chromium.launch();
const variants = [["1280", "light"], ["1280", "dark"], ["390", "light"], ["390", "dark"]];
const ctxFor = (w, theme) => b.newContext({ ...(w === "390" ? { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 800 } }), colorScheme: theme });
const login = async (page, base) => {
  await page.goto(base + "/");
  const pass = page.getByLabel("Passphrase"), login = page.getByLabel("Login name"), signed = page.getByText("Switch user");
  await pass.or(login).or(signed).waitFor({ state: "attached" });
  if (await pass.isVisible()) { await pass.fill("correct horse"); await page.getByRole("button", { name: "Unlock" }).click(); }
  if (await login.isVisible()) { await login.fill("li"); await page.getByLabel("Password").fill("pw"); await page.getByRole("button", { name: "Log in" }).click(); }
  await signed.waitFor({ state: "attached" });
  return (await page.evaluate(() => fetch("/api/state").then((r) => r.json()))).users[0].id;
};
// The setup page, fresh, at every size; then the later steps at 1280 light.
for (const [w, theme] of variants) {
  const ctx = await ctxFor(w, theme); const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:7361/"); await page.getByRole("heading", { name: "Set up Lyrica" }).waitFor();
  await page.screenshot({ path: `${OUT}/setup-${w}-${theme}.png`, fullPage: true });
  await ctx.close();
}
{
  const ctx = await ctxFor("1280", "light"); const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:7361/"); await page.getByRole("heading", { name: "Set up Lyrica" }).waitFor();
  {
    const code = readFileSync("/tmp/lyrica-e2e-setup-code-7361", "utf8").trim();
    await page.getByRole("textbox", { name: "Code" }).fill(code);
    await page.getByLabel("Passphrase", { exact: true }).fill("correct horse"); await page.getByLabel("Repeat").fill("correct horse");
    await page.getByRole("form", { name: "Code and passphrase" }).getByRole("button", { name: "Continue" }).click();
    await page.getByRole("form", { name: "Lyrica" }).getByRole("textbox", { name: "Name", exact: true }).fill("Aria");
    await page.getByRole("form", { name: "Lyrica" }).getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Login name").fill("li"); await page.getByLabel("Password").fill("pw");
    await page.getByRole("form", { name: "Administrator" }).getByRole("textbox", { name: "Name", exact: true }).fill("Li");
    await page.screenshot({ path: `${OUT}/setup-filled-1280-light.png`, fullPage: true });
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("form", { name: "Tailnet" }).waitFor(); await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/setup-tailnet-1280-light.png`, fullPage: true });
    await page.getByRole("form", { name: "Tailnet" }).getByRole("button", { name: "Skip" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/setup-models-1280-light.png`, fullPage: true });
    await page.getByRole("form", { name: "Models" }).getByRole("button", { name: "Skip" }).click();
    await page.getByRole("region", { name: "Done" }).waitFor(); await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/setup-done-1280-light.png`, fullPage: true });
  }
  await ctx.close();
}
// Administration sections and reactions on the set-up lyricad.
for (const [w, theme] of variants) {
  const ctx = await ctxFor(w, theme); const page = await ctx.newPage();
  const base = "http://127.0.0.1:7345"; const id = await login(page, base);
  const shot = async (section, name) => { await page.goto(`${base}/#/u/${id}/admin/${section}`); await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, fullPage: true }); };
  await shot("persona", "admin-persona"); await shot("tailnet", "admin-tailnet"); await shot("updates", "admin-updates");
  await page.goto(`${base}/#/u/${id}/admin/web`); await page.waitForTimeout(500);
  await page.getByLabel("Direct").check(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/admin-web-direct-${w}-${theme}.png`, fullPage: true });
  await page.goto(`${base}/#/u/${id}/admin/users`); await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Change password…" }).first().click(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/admin-users-password-${w}-${theme}.png`, fullPage: true });
  // A thread with a reaction.
  await page.goto(`${base}/#/u/${id}`); await page.waitForTimeout(300);
  const box = page.getByPlaceholder(/Start a new thread/);
  await box.fill("Hello there, what do you think of reactions?"); await box.press("Enter");
  await page.getByText(/You said:/).waitFor(); await page.waitForTimeout(1500);
  const msg = page.locator(".msg.her").first();
  await msg.hover();
  await page.getByRole("button", { name: "React" }).first().click(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/reactions-quick-${w}-${theme}.png` });
  await page.getByRole("button", { name: "React with tada" }).click(); await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/reactions-chip-${w}-${theme}.png` });
  if (w === "1280") {
    await page.getByRole("button", { name: "React" }).first().hover(); await page.getByRole("button", { name: "React" }).first().click();
    await page.getByRole("button", { name: "More emoji" }).click(); await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/reactions-picker-${w}-${theme}.png` });
  }
  await ctx.close();
}
await b.close();
