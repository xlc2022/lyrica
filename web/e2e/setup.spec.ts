// The setup page (docs/briefs/web-bootstrap.md) against a lyricad with no self.db
// (e2e/serve.ts … setup), then her name, Tailnet and Updates in Administration.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/** Where e2e/serve.ts copies the one-time code (its setupCodeFile). */
const setupCodeFile = (port: number) => join(tmpdir(), `lyrica-e2e-setup-code-${port}`);

test.describe.configure({ mode: "serial" });

test("the setup page takes the code, her name and the first administrator, skips Tailnet and Models, and lands signed in", async ({ page, baseURL }) => {
  const code = readFileSync(setupCodeFile(Number(new URL(baseURL!).port)), "utf8").trim();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Set up Lyrica" })).toBeVisible();
  // A wrong code is told as such, at the Create step; the passphrases must match first.
  await page.getByRole("textbox", { name: "Code" }).fill("AAAA-AAAA");
  await page.getByLabel("Passphrase", { exact: true }).fill("correct horse");
  const codeStep = page.getByRole("form", { name: "Code and passphrase" });
  await page.getByLabel("Repeat").fill("wrong horse");
  await codeStep.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("The passphrases don't match.")).toBeVisible();
  await page.getByLabel("Repeat").fill("correct horse");
  await codeStep.getByRole("button", { name: "Continue" }).click();
  // A done step keeps its button, secondary; the current step's is the primary.
  const nameStep = page.getByRole("form", { name: "Lyrica" });
  await nameStep.getByRole("textbox", { name: "Name", exact: true }).fill("Aria");
  await expect(codeStep.getByRole("button", { name: "Continue" })).not.toHaveClass(/primary/);
  await nameStep.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Login name").fill("li");
  await page.getByLabel("Password").fill("pw");
  await page.getByRole("form", { name: "Administrator" }).getByRole("textbox", { name: "Name", exact: true }).fill("Li");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("The code doesn't match.")).toBeVisible();
  await page.getByRole("textbox", { name: "Code" }).fill(code);
  await page.getByRole("button", { name: "Create" }).click();
  // Tailnet: Tailscale isn't installed here, so Skip; Models: Skip.
  const tailnet = page.getByRole("form", { name: "Tailnet" });
  await expect(tailnet).toContainText("Not installed");
  await tailnet.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("form", { name: "Models" }).getByRole("button", { name: "Skip" }).click();
  const done = page.getByRole("region", { name: "Done" });
  await expect(done).toContainText("Administratorli");
  await done.getByRole("button", { name: "Start a chat" }).click();
  await expect(page.getByText("Switch user")).toBeAttached();
  // Her name is on the page, and stays after a reload.
  await expect(page.locator(".brand")).toHaveText("Aria");
  await page.reload();
  await expect(page.locator(".brand")).toHaveText("Aria");
  await expect(page).toHaveTitle("Aria");
});

test("Administration: her name changes from Persona, Tailnet says what's missing, and Updates says there is no updater", async ({ page }) => {
  // A new browser: she is unlocked, so it goes straight to Log in.
  await page.goto("/");
  await page.getByLabel("Login name").fill("li");
  await page.getByLabel("Password").fill("pw");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Switch user")).toBeAttached();
  const userId = await page.evaluate(async () => ((await (await fetch("/api/state")).json()) as { users: { id: string }[] }).users[0]!.id);
  await page.goto(`/#/u/${userId}/admin/persona`);
  const name = page.getByRole("region", { name: "Persona" }).getByLabel("Name");
  await expect(name).toHaveValue("Aria");
  await name.fill("Lyra");
  await expect(page.getByText("Memories and threads written so far keep the name Aria.")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".brand")).toHaveText("Lyra");
  await page.goto(`/#/u/${userId}/admin/tailnet`);
  await expect(page.getByRole("region", { name: "Tailnet" })).toContainText("Not installed");
  await page.goto(`/#/u/${userId}/admin/updates`);
  await expect(page.getByRole("region", { name: "Updates" })).toContainText("No updater is installed");
});
