// The web UI against a real lyricad (e2e/serve.ts) and a fake model server,
// at phone and desktop sizes. Tests run in order on one lyricad per size.
import { expect, test, type Page } from "@playwright/test";

const PASSPHRASE = "correct horse";
test.describe.configure({ mode: "serial" });

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 760;

/** Unlocks and logs in as needed, and makes sure li has a cloud and a local endpoint. Returns li's user ID. */
async function enter(page: Page, baseURL: string): Promise<string> {
  await page.goto("/");
  const passphrase = page.getByLabel("Passphrase");
  const login = page.getByLabel("Login name");
  const persona = page.getByText("Switch persona");
  await expect(passphrase.or(login).or(persona)).toBeAttached();
  if (await passphrase.isVisible()) {
    await passphrase.fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(login.or(persona)).toBeAttached();
  }
  if (await login.isVisible()) {
    await login.fill("li");
    await page.getByLabel("Password").fill("pw");
    await page.getByRole("button", { name: "Log in" }).click();
  }
  await expect(page.getByText("Switch persona")).toBeAttached();
  // Requests go through the page, which holds the session cookie.
  let userId = "";
  const api = (method: string, path: string, data?: unknown) => page.evaluate(async ([method, path, data]) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) as unknown : undefined;
  }, [method, path.startsWith("/api") ? path : `/api/u/${userId}${path}`, data] as const);
  const state = await api("GET", "/api/state") as { users: { id: string }[] };
  userId = state.users[0]!.id;
  const endpoints = await api("GET", "/endpoints") as unknown[];
  if (!endpoints.length) {
    const models = `http://127.0.0.1:${Number(new URL(baseURL).port) + 10}`;
    await api("POST", "/endpoints", { name: "gpu", kind: "local", baseUrl: `${models}/local/v1` });
    await api("POST", "/endpoints", { name: "router", kind: "cloud", baseUrl: `${models}/cloud/v1` });
    await api("POST", "/endpoints/gpu/discover");
    await api("POST", "/endpoints/router/discover");
    await api("PUT", "/profiles/cloud/chat", { model: { endpointId: "router", modelId: "cloud-model" } });
    await api("PUT", "/profiles/local/chat", { model: { endpointId: "gpu", modelId: "local-model" } });
  }
  return userId;
}

async function newThread(page: Page, pool: "General" | "Private") {
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await page.getByRole("button", { name: "New thread" }).click();
  await page.getByRole("group", { name: "New thread in" }).getByRole("button", { name: pool }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Thread settings" }).click();
  return page.getByRole("complementary", { name: "Thread settings" });
}

async function noHorizontalScroll(page: Page) {
  const widths = await page.evaluate(() => {
    const over = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "auto" && el.closest("pre, table") === null)
      .map((el) => el.className);
    return { doc: document.documentElement.scrollWidth, view: innerWidth, over };
  });
  expect(widths.doc).toBeLessThanOrEqual(widths.view);
  expect(widths.over).toEqual([]);
}

test("unlock, log in, start a thread, and see a streamed reply that survives a reload", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unlock Lyrica" })).toBeVisible();
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Hello there");
  await expect(page.locator(".msg.user").getByText("Hello there")).toBeVisible();
  await expect(page.getByText("You said: Hello there")).toBeVisible();
  await expect(page.getByText("in a few pieces.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("in a few pieces.")).toBeVisible();
  await expect(page.locator(".msg.user").getByText("Hello there")).toBeVisible();
  await noHorizontalScroll(page);
});

test("the model badge shows the current model, and a change takes effect", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const badge = page.getByRole("button", { name: /^Model:/ });
  await expect(badge).toContainText("cloud-model");
  await expect(badge).toContainText(/cloud/i);
  await badge.click();
  await page.getByRole("dialog").getByRole("button", { name: "local-model" }).click();
  await expect(badge).toContainText("local-model");
  await expect(badge).toContainText("gpu");
  await send(page, "Which model?");
  await expect(page.getByText("from the fake local-model")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Model:/ })).toContainText("local-model");
});

test("private and local-only threads offer only local models", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "Private");
  await expect(page.locator(".head .badge").first()).toContainText(/private/i);
  await page.getByRole("button", { name: /^Model:/ }).click();
  let picker = page.getByRole("dialog");
  await expect(picker.getByRole("button", { name: "local-model" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "cloud-model" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await newThread(page, "General");
  const drawer = await openSettings(page);
  await drawer.getByLabel("Local-only").click();
  await expect(drawer.getByLabel("Local-only")).toBeChecked();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: /^Model:/ })).toContainText("local-model");
  await page.getByRole("button", { name: /^Model:/ }).click();
  picker = page.getByRole("dialog");
  await expect(picker.getByRole("button", { name: "local-model" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "cloud-model" })).toHaveCount(0);
});

test("in an ask mode, a command can be allowed, and denying it stops the tool", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const drawer = await openSettings(page);
  await drawer.getByLabel("Permission mode").selectOption("ask-commands");
  await expect(drawer.getByLabel("Permission mode")).toHaveValue("ask-commands");
  await drawer.getByRole("button", { name: "Close" }).click();

  await send(page, "run: echo allowed");
  const prompt = page.getByRole("group", { name: "Allow bash?" });
  await expect(prompt).toContainText("echo allowed");
  await prompt.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("The command finished.")).toBeVisible();
  await page.locator(".marker", { hasText: "echo allowed" }).getByRole("button").click();
  await expect(page.locator(".marker", { hasText: "echo allowed" })).not.toContainText("Not approved");

  await send(page, "run: echo denied");
  await page.getByRole("group", { name: "Allow bash?" }).getByRole("button", { name: "Deny" }).click();
  const marker = page.locator(".marker", { hasText: "echo denied" });
  await expect(marker).toContainText("failed");
  await marker.getByRole("button").click();
  await expect(marker).toContainText("Not approved");
});

test("an uploaded file's path goes into the message", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello file") });
  const box = page.getByLabel("Message", { exact: true });
  await expect(box).toHaveValue(/notes\.txt/);
  const path = (await box.inputValue()).trim();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.user").getByText(path)).toBeVisible();
});

test("a memory can be added, edited and restored", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("button", { name: "Add a memory" }).click();
  await page.getByLabel("Text").fill("The backup job on node 2 runs at night.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const article = page.locator("article.memory-item");
  await expect(article).toContainText("runs at night");

  await article.getByRole("button", { name: "Edit" }).click();
  await article.getByLabel("Text").fill("The backup job on node 2 runs at noon.");
  await article.getByRole("button", { name: "Save" }).click();
  await expect(article.locator(".prose").first()).toContainText("runs at noon");

  await article.locator(".history summary").first().click();
  await article.getByRole("button", { name: "Restore this version" }).first().click();
  await expect(article.locator(".prose").first()).toContainText("runs at night");
  await noHorizontalScroll(page);
});

test("no horizontal scrolling and big enough tap targets on a phone", async ({ page, baseURL }) => {
  test.skip(!phone(page), "phone only");
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await noHorizontalScroll(page);
  for (const name of ["Show threads", "Thread settings", "Attach a file", "Send"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box!.height, name).toBeGreaterThanOrEqual(44);
  }
  await openSettings(page);
  await noHorizontalScroll(page);
  for (const hash of ["memory", "panel"]) {
    await page.goto(`/#/u/${userId}/${hash}`);
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page);
  }
});
