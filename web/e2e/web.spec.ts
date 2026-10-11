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
  const signedIn = page.getByText("Switch user");
  await expect(passphrase.or(login).or(signedIn)).toBeAttached();
  if (await passphrase.isVisible()) {
    await passphrase.fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(login.or(signedIn)).toBeAttached();
  }
  if (await login.isVisible()) {
    await login.fill("li");
    await page.getByLabel("Password").fill("pw");
    await page.getByRole("button", { name: "Log in" }).click();
  }
  await expect(page.getByText("Switch user")).toBeAttached();
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
    type Ep = { id: string; models: { id: string; modelId: string }[] };
    const add = async (name: string, kind: string, path: string, model: string) => {
      const ep = await api("POST", "/endpoints", { name, kind, baseUrl: `${models}/${path}/v1` }) as Ep;
      const found = await api("POST", `/endpoints/${ep.id}/discover`) as Ep;
      return { offeringId: found.models.find((m) => m.modelId === model)!.id };
    };
    await api("PUT", "/profiles/local/chat", { model: await add("gpu", "local", "local", "local-model") });
    await api("PUT", "/profiles/cloud/chat", { model: await add("router", "cloud", "cloud", "cloud-model") });
    // The same fake speech server as a local and as a cloud endpoint: whisper transcribes, kokoro speaks English and Mandarin.
    for (const [name, kind] of [["speech", "local"], ["openai", "cloud"]] as const) {
      const ep = await api("POST", "/endpoints", { name, kind, baseUrl: `${models}/speech/v1` }) as Ep;
      const found = await api("POST", `/endpoints/${ep.id}/discover`) as Ep;
      const whisper = found.models.find((m) => m.modelId === "whisper")!.id;
      const kokoro = found.models.find((m) => m.modelId === "kokoro")!.id;
      await api("PATCH", `/offerings/${whisper}`, { transcribe: true });
      await api("PATCH", `/offerings/${kokoro}`, { speak: { voices: [{ id: "af_heart", language: "en" }, { id: "zf_xiaobei", language: "zh" }] } });
      await api("PUT", `/profiles/${kind}/speech.transcribe`, { model: { offeringId: whisper } });
      await api("PUT", `/profiles/${kind}/speech.speak`, { model: { offeringId: kokoro } });
    }
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
  const drawer = page.getByRole("complementary", { name: "Thread settings" });
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return drawer;
}

/** Flips the Private checkbox in the sidebar's Sort menu (the sidebar is open already on a phone). */
async function togglePrivate(page: Page) {
  const sorting = page.locator(".showing");
  if (!(await sorting.evaluate((el) => (el as HTMLDetailsElement).open))) await sorting.locator("summary").click();
  const box = sorting.getByRole("checkbox", { name: "Private" });
  const was = await box.isChecked();
  await box.click();
  await expect(box).toBeChecked({ checked: !was });
  await sorting.locator("summary").click();
}

/** Body is overflow: hidden, so check the containers that scroll, and that nothing pokes past the viewport. */
async function noHorizontalScroll(page: Page) {
  const found = await page.evaluate(() => {
    const wide = [...document.querySelectorAll<HTMLElement>(".scroll, .head, .drawer-body, .memory-search, .memory-detail, .side")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
    const past = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.offsetParent && el.closest("pre, table, .side, .menu, .subnav") === null && el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => `${el.tagName}.${el.className}`);
    return { wide, past };
  });
  expect(found.wide).toEqual([]);
  expect(found.past).toEqual([]);
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

test("a message's menu regenerates, edits, deletes with Undo, and branches", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "first question");
  await expect(page.getByText("You said: first question")).toBeVisible();
  await send(page, "second question");
  await expect(page.getByText("You said: second question")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "Message actions" }).nth(i);

  // Regenerate with another model: her first reply and what followed are replaced, after the Undo delay.
  await menu(1).click();
  await page.getByRole("menuitem", { name: "Regenerate with…" }).click();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/message-menu-${page.viewportSize()!.width}.png` });
  await page.getByRole("menuitem", { name: /local-model/ }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByText("from the fake local-model")).toBeVisible();
  await expect(page.getByText("second question")).toHaveCount(0);

  // Edit the question: it is sent again, as edited.
  await menu(0).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Edit your message").fill("an edited question");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("You said: an edited question")).toBeVisible();
  await expect(page.locator(".msg.user")).toHaveCount(1);

  // Delete waits for Undo; undone, nothing changes.
  await menu(1).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByText("You said: an edited question")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("You said: an edited question")).toBeVisible();

  // Branch from her reply: the branch opens, with the conversation so far.
  await menu(1).click();
  await page.getByRole("menuitem", { name: "Branch from here" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /\(branch\)$/ })).toBeVisible();
  await expect(page.getByText("Branched from")).toBeVisible();
  await expect(page.getByText("You said: an edited question")).toBeVisible();
  // A branch has its own mode, and its picker changes it.
  await page.locator(".mode-picker > button").click();
  await page.keyboard.press("1");
  await expect(page.locator(".mode-picker > button")).toContainText("Ask");
  await noHorizontalScroll(page);
});

test("a pinned message shows in the header's Pinned popover, and unpinning removes it", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "the gate code is 4417");
  await expect(page.getByText("You said: the gate code is 4417")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "Message actions" }).nth(i);

  await menu(0).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.locator(".msg.user .who").getByText("pinned", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^1 pinned/ }).click();
  const popover = page.getByRole("dialog", { name: "Pinned" });
  await expect(popover.getByText("the gate code is 4417")).toBeVisible();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/pinned-${page.viewportSize()!.width}.png` });
  await popover.getByRole("button").first().click();
  await expect(popover).toHaveCount(0);

  await menu(0).click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(page.getByRole("button", { name: /pinned/ })).toHaveCount(0);
  await expect(page.locator(".msg.user .who").getByText("pinned", { exact: true })).toHaveCount(0);
});

test("removing turns that did things asks first, with what goes", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "the shed key is under the pot");
  await expect(page.getByText("You said: the shed key is under the pot")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "Message actions" }).nth(i);
  await menu(0).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.locator(".msg.user .who").getByText("Pinned")).toBeVisible();

  // Deleting the turn takes the pin, so it asks; Cancel keeps everything.
  await menu(1).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Remove messages" });
  await expect(confirm).toContainText("Remove 2 messages? 1 is pinned.");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/removal-${page.viewportSize()!.width}.png` });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText("the shed key is under the pot", { exact: true })).toBeVisible();

  await menu(1).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("the shed key is under the pot", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /pinned/ })).toHaveCount(0, { timeout: 15_000 });
});

test("a child thread nests under its parent, opens from its card, and goes with its parent when asked", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "start: Seed list");
  await expect(page.getByText("Started it.")).toBeVisible();
  const card = page.locator(".threads-card");
  await expect(card).toContainText("Child thread: Seed list");
  await card.getByRole("link", { name: "Open" }).click();
  // On a wide screen the child opens in the panel beside its parent; on a phone it is the page.
  const view = phone(page) ? page : page.getByRole("complementary", { name: "Seed list" });
  await expect(view.getByRole("heading", { level: 1, name: "Seed list" })).toBeVisible();
  await expect(view.getByText("Child thread of")).toBeVisible();
  await expect(view.locator(".msg.user .who").getByText("· from")).toBeVisible();
  await expect(view.getByText("Work on Seed list.", { exact: true })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/child-${page.viewportSize()!.width}.png` });
  await view.getByText("Child thread of").getByRole("link").click();
  if (!phone(page)) await expect(page.getByRole("complementary", { name: "Seed list" })).toHaveCount(0);

  const drawer = await openSettings(page);
  await drawer.getByRole("button", { name: "Forget this thread" }).click();
  await expect(drawer.getByLabel("Also forget its child thread")).toBeChecked();
  await drawer.getByRole("button", { name: "Forget it" }).click();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(page.locator(".side").getByText("Seed list")).toHaveCount(0);
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
  await expect(page.locator(".tfacts .k").first()).toHaveText(/private/i);
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
  // The mode picker beside the message box, with each mode's number key.
  await page.locator(".mode-picker").getByRole("button").click();
  await expect(page.getByRole("menu", { name: "Mode" }).getByRole("menuitemradio")).toHaveCount(4);
  await page.keyboard.press("2");
  await expect(page.locator(".mode-picker")).toContainText("Accept edits");
  const drawer = await openSettings(page);
  await expect(drawer.getByRole("combobox", { name: /^Mode/ })).toHaveValue("acceptEdits");
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

test("Plan mode: Shift+Tab gets there, the plan shows as a card, and going ahead switches the mode", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const message = page.getByLabel("Message", { exact: true });
  await message.focus();
  // Auto, then Ask, Accept edits, Plan.
  await expect(page.locator(".mode-picker")).toContainText("Auto");
  for (let i = 0; i < 3; i++) await message.press("Shift+Tab");
  await expect(page.locator(".mode-picker")).toContainText("Plan");
  // With SCREENSHOTS set, light and dark copies for the UI review.
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  await page.locator(".mode-picker > button").click();
  await shot("mode-menu");
  await page.keyboard.press("Escape");

  for (const said of ["What's in the logs?", "And the config?"]) {
    await send(page, said);
    await expect(page.getByText(`You said: ${said}`)).toBeVisible();
  }
  await send(page, "plan: Check the logs, then fix the config");
  const card = page.getByRole("group", { name: "Lyrica's plan" });
  await expect(card).toContainText("Check the logs, then fix the config");
  await shot("plan-card");
  // Scrolled out of view, the plan is named in a bar at the top that jumps back to it.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 420 });
  const bar = page.getByRole("button", { name: "Plan waiting for your answer" });
  await page.locator(".scroll").first().evaluate((el) => { el.scrollTop = 0; });
  await expect(bar).toBeVisible();
  await shot("pending-bar");
  await bar.click();
  await expect(card).toBeInViewport();
  await expect(bar).toHaveCount(0);
  await page.setViewportSize(size);
  await card.getByRole("button", { name: /^Go ahead in/ }).click();
  await shot("go-ahead-menu");
  await card.getByRole("menu", { name: "Go ahead in" }).getByRole("menuitem", { name: /^Accept edits/ }).click();
  await expect(page.getByText("On it.")).toBeVisible();
  await expect(page.locator(".mode-picker")).toContainText("Accept edits");

  // The "+" menu's switches turn tools off for this thread.
  await page.getByRole("button", { name: "Attach or switch tools" }).click();
  const menu = page.getByRole("menu", { name: "Attach and tools" });
  await shot("tools-menu");
  await menu.getByLabel("Web search").click();
  await expect(menu.getByLabel("Web search")).not.toBeChecked();
  await page.keyboard.press("Escape");
  const drawer = await openSettings(page);
  await expect(drawer.getByLabel("Web search")).not.toBeChecked();
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
  // A thread mention in a memory shows as a link to that thread.
  await newThread(page, "General");
  const threadId = decodeURIComponent(page.url().split("/t/general/")[1]!);
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("button", { name: "Add a memory" }).click();
  await page.getByLabel("Text").fill(`The backup job on node 2 runs at night, see [t:${threadId}].`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const article = page.locator("article.memory-item");
  await expect(article).toContainText("runs at night");
  await expect(article.locator(".prose a").first()).toHaveAttribute("href", new RegExp(encodeURIComponent(threadId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await article.getByRole("button", { name: "Edit" }).click();
  await article.getByLabel("Text").fill("The backup job on node 2 runs at noon.");
  await article.getByRole("button", { name: "Save" }).click();
  await expect(article.locator(".prose").first()).toContainText("runs at noon");

  await article.locator(".history summary").first().click();
  await article.getByRole("button", { name: "Restore this version" }).first().click();
  await expect(article.locator(".prose").first()).toContainText("runs at night");
  await noHorizontalScroll(page);
});

test("turning Show private off hides an open private thread and private memory", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("button", { name: "Add a memory" }).click();
  await page.locator("form.add-memory").getByLabel("Pool").selectOption("private");
  await page.getByLabel("Text").fill("A private note about the garden.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("article.memory-item")).toContainText("about the garden");
  const memoryUrl = page.url();

  await newThread(page, "Private");
  await send(page, "A private hello");
  await expect(page.getByText("You said: A private hello")).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await togglePrivate(page);
  if (phone(page)) await page.locator(".scrim").first().click({ position: { x: 370, y: 400 } });
  await expect(page.getByRole("heading", { name: "Private is hidden" })).toBeVisible();
  await expect(page.getByText("A private hello")).toHaveCount(0);

  await page.goto(memoryUrl);
  await expect(page.getByText("Private is hidden.")).toBeVisible();
  await expect(page.getByText("about the garden")).toHaveCount(0);
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("searchbox", { name: "Search memory" }).fill("garden");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Nothing found.")).toBeVisible();

  // Leave the filters as the other tests expect them.
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await togglePrivate(page);
});

test("Machines lists none, and Add machine reaches a machine before anything is saved", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/settings/machines`);
  const section = page.getByRole("region", { name: "Machines", exact: true });
  await expect(section).toContainText("None yet.");
  await section.getByRole("link", { name: "Add machine" }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/settings/machines/new$`));
  await expect(page.getByRole("heading", { level: 2, name: "Add machine" })).toBeVisible();
  // Until the machine is reached, the Key, Test and Fingerprint steps don't show, and nothing is saved.
  await expect(page.getByRole("button", { name: "SSH" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Copy" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Name" }).fill("nowhere");
  await page.getByRole("textbox", { name: "Address" }).fill("lyrica@nowhere.invalid");
  await page.getByRole("textbox", { name: "Address" }).press("Enter");
  // The key and its setup commands come even when the host can't be resolved; Test says why.
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByText("/etc/ssh/authorized_keys")).toBeVisible();
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await noHorizontalScroll(page);
  await page.getByRole("link", { name: "Machines", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Machines", exact: true })).toContainText("None yet.");
});

test("an administrator sees how Lyrica is reached", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/admin/web`);
  const section = page.getByRole("region", { name: "Web access", exact: true });
  await expect(section.getByLabel("Only this machine")).toBeChecked();
  await expect(section.getByRole("region", { name: "Web access status" })).toContainText("Only on this machine");
  await section.getByLabel("Built-in Caddy").check();
  await expect(section.getByLabel("DNS provider")).toBeVisible();
  await section.getByLabel("A proxy elsewhere").check();
  await expect(section.getByLabel("Proxy addresses")).toBeVisible();
  await noHorizontalScroll(page);
});

test("linked users share a browser; logging in as anyone else signs this browser out first", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const admin = (path: string, data: unknown) => page.evaluate(async ([path, data]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    if (!r.ok && r.status !== 400) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }, [`/api/u/${userId}/admin/users`, data] as const);
  const pronouns = { subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself" };
  await admin("", { login: "lark", password: "pw-lark", displayName: "Lark", pronouns, admin: false });
  await admin("", { login: "sam", password: "pw-sam", displayName: "Sam", pronouns, admin: false });

  // Link Lark to Li from Settings.
  await page.goto(`/#/u/${userId}/settings/personas`);
  const links = page.getByRole("region", { name: "Your personas" });
  await links.getByLabel("Your password").fill("pw");
  await links.getByLabel("Its login name").fill("lark");
  await links.getByLabel("Its password").fill("pw-lark");
  await links.getByRole("button", { name: "Link separate persona" }).click();
  await expect(links.getByText("Lark", { exact: true })).toBeVisible();

  const logInAs = async (login: string, password: string) => {
    if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
    await page.getByRole("button", { name: /Switch user/ }).click();
    await page.getByRole("menuitem", { name: "Log in as another user…" }).click();
    await expect(page.getByRole("heading", { name: "Log in as another user" })).toBeVisible();
    await page.getByLabel("Login name", { exact: true }).fill(login);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByText("Switch user")).toBeAttached();
  };

  // A linked user joins Li on this browser.
  await logInAs("lark", "pw-lark");
  await expect(page.getByText("Signed out the previous user")).toHaveCount(0);
  expect((await page.evaluate(() => fetch("/api/state").then((r) => r.json())) as { users: unknown[] }).users).toHaveLength(2);

  // Anyone else replaces them both, without naming them.
  await logInAs("sam", "pw-sam");
  await expect(page.getByRole("status").filter({ hasText: "Signed out the previous user on this browser." })).toBeVisible();
  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json())) as { users: { login: string }[] };
  expect(state.users.map((x) => x.login)).toEqual(["sam"]);
});

test("with Read aloud while she writes on, a reply can be read aloud as it streams, and her stored copy takes the reading over", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  // Off by default: a reply being written has no Read aloud.
  await newThread(page, "General");
  const message = page.getByLabel("Message", { exact: true });
  await message.fill("Say this slowly");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("You said: Say this slowly")).toBeVisible();
  await expect(page.locator(".turn").filter({ has: page.locator(".caret-blink") }).getByRole("button", { name: "Read aloud" })).toHaveCount(0);
  await expect(page.getByText("in a few pieces.")).toBeVisible({ timeout: 15_000 });

  // The setting is under Speech in Settings, Appearance.
  await page.goto(`/#/u/${encodeURIComponent(userId)}/settings/appearance`);
  const live = page.getByLabel("Read aloud while she writes");
  await expect(live).not.toBeChecked();
  await live.click();
  await expect(live).toBeChecked();
  await shot("read-aloud-live-setting");
  await page.reload();
  await expect(page.getByLabel("Read aloud while she writes")).toBeChecked();

  // On: Read aloud appears on the reply she is writing and follows it; her stored copy then owns the reading.
  await page.goBack();
  await page.goBack();
  await expect(message).toBeVisible();
  await message.fill("Say this slowly too");
  await page.getByRole("button", { name: "Send" }).click();
  const writing = page.locator(".turn").filter({ has: page.locator(".caret-blink") });
  await expect(writing.getByRole("button", { name: "Read aloud" })).toBeEnabled();
  await writing.getByRole("button", { name: "Read aloud" }).click();
  await expect(writing.getByRole("button", { name: "Stop reading" })).toBeVisible();
  await shot("read-aloud-live");
  await expect(page.getByText("You said: Say this slowly too. This reply comes from the fake cloud-model, in a few pieces.")).toBeVisible({ timeout: 20_000 });
  const stored = page.locator(".turn").last();
  await expect(stored).not.toContainText("Lyrica is thinking");
  // The reading goes on past the end of the text; the stored copy's button is the one to stop it.
  const button = stored.getByRole("button", { name: /Stop reading|Read aloud/ });
  await expect(button).toBeVisible();
  if ((await button.getAttribute("aria-label")) === "Stop reading") {
    await button.click();
    await expect(stored.getByRole("button", { name: "Read aloud" })).toBeVisible();
  }
  await expect(page.locator(".turn").getByRole("button", { name: "Stop reading" })).toHaveCount(0, { timeout: 15_000 });
  await noHorizontalScroll(page);
});

test("dictation goes in at the caret, Read aloud plays her reply, and a speech server that is down disables both", async ({ page, baseURL, request }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  const message = page.getByLabel("Message", { exact: true });
  // A general thread's Dictation model is a cloud one, so the mic is off until Voice to cloud is on.
  const mic = page.getByRole("button", { name: "Dictate" });
  await expect(mic).toBeDisabled();
  await expect(mic).toHaveAttribute("title", /is a cloud model, and Voice to cloud is off/);
  await shot("mic-off");
  // Voice to cloud: a switch among the thread's privacy and network switches, following the default until changed.
  let drawer = await openSettings(page);
  const voiceCloud = drawer.getByLabel("Voice to cloud");
  await expect(voiceCloud).not.toBeChecked();
  await voiceCloud.click();
  await expect(voiceCloud).toBeChecked();
  await shot("voice-to-cloud");
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(mic).toBeEnabled();

  // Recording: the placeholder says so, and the time runs beside the mic. Escape throws the clip away.
  await mic.click();
  await expect(message).toHaveAttribute("placeholder", "Listening…");
  await expect(page.locator(".mic .elapsed")).toHaveText(/0:0[1-9]/);
  await shot("recording");
  await message.press("Escape");
  await expect(mic).toBeEnabled();
  await expect(message).toHaveValue("");
  // Enter in the box stops and transcribes; the text lands at the caret.
  await message.fill("Please note:");
  await mic.click();
  await expect(message).toHaveAttribute("placeholder", "Listening…");
  await page.waitForTimeout(500);
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Transcribing" })).toBeDisabled();
  await shot("transcribing");
  await expect(message).toHaveValue("Please note: hello from the fake", { timeout: 15_000 });
  await expect(mic).toBeEnabled();

  // Read aloud on her reply is Stop reading while it plays, then comes back.
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("in a few pieces.")).toBeVisible();
  await page.getByRole("button", { name: "Read aloud" }).click();
  const stop = page.getByRole("button", { name: "Stop reading" });
  await expect(stop).toBeVisible();
  await shot("read-aloud");
  await expect(page.getByRole("button", { name: "Read aloud" })).toBeVisible({ timeout: 15_000 });
  await noHorizontalScroll(page);

  // With the speech server down, a clip's failure shows in the error line, and the mic and Read aloud are then disabled with the reason.
  const models = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  await request.post(`${models}/speech/down`);
  try {
    await page.getByRole("button", { name: "Dictate" }).click();
    await expect(message).toHaveAttribute("placeholder", "Listening…");
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Stop and transcribe" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /be reached now/ })).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(mic).toBeDisabled();
    await expect(mic).toHaveAttribute("title", /be reached now/);
    await expect(page.getByRole("button", { name: "Read aloud" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Read aloud" })).toHaveAttribute("title", /be reached now/);
    await shot("speech-down");
    await noHorizontalScroll(page);
    // The thread's own choice held.
    drawer = await openSettings(page);
    await expect(drawer.getByLabel("Voice to cloud")).toBeChecked();
    await drawer.getByRole("button", { name: "Use default" }).last().click();
    await expect(drawer.getByLabel("Voice to cloud")).not.toBeChecked();
  } finally {
    await request.post(`${models}/speech/up`);
  }
});

test("a speaking model's Settings drawer sets its voice and clamps its speed; Voice to cloud has its default beside the network defaults", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${encodeURIComponent(userId)}/settings/network`);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Voice to cloud")).not.toBeChecked();
  await page.goto(`/#/u/${encodeURIComponent(userId)}/settings/profiles`);
  // Dictation and Read aloud rows offer only models that transcribe or speak.
  const local = page.getByRole("group", { name: "Local profile" });
  await expect(local.getByLabel("Dictation").locator("option")).toHaveText(["Not set", "whisper"]);
  await expect(local.getByLabel("Read aloud").locator("option")).toHaveText(["Not set", "kokoro"]);

  await page.goto(`/#/u/${encodeURIComponent(userId)}/settings/endpoints`);
  await page.getByRole("button", { name: "kokoro settings" }).first().click();
  const drawer = page.getByRole("complementary", { name: "kokoro settings" });
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const english = drawer.getByLabel("English");
  await expect(english).toHaveValue("");
  await english.selectOption("af_heart");
  await expect(drawer.getByRole("group", { name: /^Voice/ })).toContainText("yours");
  const speed = drawer.getByRole("spinbutton");
  await speed.fill("9");
  await speed.press("Enter");
  await expect(speed).toHaveValue("4");
  await expect(drawer.getByRole("group", { name: /^Speed/ })).toContainText("yours");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/voice-drawer-${page.viewportSize()!.width}.png` });
  // Reset takes each section back to the shared or default value.
  await drawer.getByRole("group", { name: /^Speed/ }).getByRole("button", { name: "Reset" }).click();
  await expect(speed).toHaveValue("");
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);
});

test("the header names the version and build, and the home box starts a thread", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Lyrica \S+ · \S+$/ })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("From the home box");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.user").getByText("From the home box")).toBeVisible();
  await expect(page.getByText("You said: From the home box")).toBeVisible();
});

test("the thread menu renames, marks unread, groups, hides and deletes; the Sort menu sorts by group", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "A thread to manage");
  await expect(page.getByText("You said: A thread to manage")).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const row = page.locator(".threads").getByRole("link", { name: /A thread to manage/ }).first();
  const open = () => row.click({ button: "right" });

  await open();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Managed thread");
  await page.getByRole("button", { name: "Rename" }).click();
  const renamed = page.locator(".threads").getByRole("link", { name: /^Managed thread/ });
  await expect(renamed).toBeVisible();

  // From the keyboard: Shift+F10 opens the menu under the row, the arrows move, Escape closes.
  await renamed.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: /Managed thread/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Rename…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: /Managed thread/ })).toHaveCount(0);

  await renamed.click({ button: "right" });
  await page.keyboard.press("u");
  await expect(page.locator(".threads a.unread")).toHaveCount(1);
  await renamed.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Mark as read" })).toBeVisible();
  await page.keyboard.press("Escape");

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to group" }).click();
  await page.getByRole("menuitem", { name: "New group…" }).click();
  await page.getByLabel("Group name").fill("Chores");
  await page.getByRole("button", { name: "Add" }).click();
  const sorting = page.locator(".showing");
  await sorting.locator("summary").click();
  await sorting.getByRole("radio", { name: "My groups" }).click();
  await expect(sorting.getByRole("radio", { name: "My groups" })).toBeChecked();
  await sorting.locator("summary").click();
  await expect(page.locator(".threads .eyebrow", { hasText: "Chores" })).toBeVisible();
  await sorting.locator("summary").click();
  await sorting.getByRole("radio", { name: "By date" }).click();
  await expect(sorting.getByRole("radio", { name: "By date" })).toBeChecked();
  await sorting.locator("summary").click();

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide" }).click();
  await expect(renamed).toHaveCount(0);
  await sorting.locator("summary").click();
  await sorting.getByRole("checkbox", { name: "Hidden" }).click();
  await expect(sorting.getByRole("checkbox", { name: "Hidden" })).toBeChecked();
  await sorting.locator("summary").click();
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this thread?" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(renamed).toHaveCount(0);
  // Deleting the open thread goes home, which closes the sidebar on a phone.
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await sorting.locator("summary").click();
  await sorting.getByRole("checkbox", { name: "Hidden" }).click();
  await expect(sorting.getByRole("checkbox", { name: "Hidden" })).not.toBeChecked();
  await sorting.locator("summary").click();
  await noHorizontalScroll(page);
});

test("a project: New project, suggested threads start into cards, the Threads popover, Start a thread, Resolve, and its settings page", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  // New project lives in the thread list's own menu, on its empty space.
  const list = page.locator(".threads");
  const box = (await list.boundingBox())!;
  await list.dispatchEvent("contextmenu", { clientX: box.x + box.width / 2, clientY: box.y + box.height - 6 });
  await page.getByRole("menu", { name: "Thread list menu" }).getByRole("menuitem", { name: "New project" }).click();
  await page.getByRole("menuitem", { name: "General" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Threads/ })).toContainText("0");
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const row = page.locator(".side .thread.project");
  await expect(row).toHaveCount(1);
  await expect(page.locator(".side .eyebrow").first()).toContainText("Pinned");
  if (phone(page)) await page.getByRole("button", { name: "Hide threads" }).click();

  // Suggested threads: Start one, then Start all; each becomes a card under the message.
  await send(page, "suggest: Alpha, Beta");
  await expect(page.getByText("Suggested.")).toBeVisible();
  const card = page.getByRole("group", { name: "Suggested threads" });
  await expect(card.getByRole("listitem")).toHaveCount(2);
  await card.getByRole("button", { name: "Start" }).first().click();
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard").first()).toContainText("Alpha");
  await card.getByRole("button", { name: "Start all" }).click();
  await expect(page.locator(".tcard")).toHaveCount(2);
  await expect(card.getByRole("link", { name: "Open" })).toHaveCount(2);
  const fact = page.getByRole("button", { name: /^Threads/ });
  await expect(fact).toContainText("2");
  await fact.click();
  const pop = page.getByRole("dialog", { name: "The project's threads" });
  await expect(pop.getByRole("link", { name: /Alpha/ })).toBeVisible();
  await expect(pop.getByRole("link", { name: /Beta/ })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-threads-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");

  // Start a thread from a message's menu; the sidebar nests the project's threads with their state.
  await page.locator(".msg.user").first().getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Start a thread" }).click();
  await expect(page.locator(".tcard")).toHaveCount(3);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(page.locator(".side .children .thread")).toHaveCount(3);
  if (phone(page)) await page.getByRole("button", { name: "Hide threads" }).click();

  // Resolve from the card's menu: the sidebar folds it under Resolved, and its own message box is one Reopen link.
  const alpha = page.locator(".tcard").filter({ has: page.getByRole("link", { name: "Alpha", exact: true }) });
  await alpha.getByRole("button", { name: "Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Resolve" }).click();
  await expect(alpha).toContainText("Resolved");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-chat-${page.viewportSize()!.width}.png` });
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const resolvedRow = page.locator(".side .resolved-row");
  await expect(resolvedRow).toContainText("1");
  await resolvedRow.click();
  await page.locator(".side .resolved-row + ul .thread").click();
  await expect(page.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  // The project settings page: Goal and Paused save together; Memory keeps the instructions.
  await page.getByText("Child thread of").getByRole("link").click();
  await page.getByRole("link", { name: "Project settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  await page.getByLabel("Goal").fill("Ship the garden plan.");
  await page.getByRole("checkbox", { name: "Paused" }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-settings-${page.viewportSize()!.width}.png` });
  const sections = page.getByRole("navigation", { name: "Project settings sections" });
  await sections.getByRole("link", { name: "Memory" }).click();
  await page.getByLabel("Instructions").fill("Keep answers short.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Instructions")).toHaveValue("Keep answers short.");
  await sections.getByRole("link", { name: "General" }).click();
  await expect(page.getByLabel("Goal")).toHaveValue("Ship the garden plan.");
  await expect(page.getByRole("checkbox", { name: "Paused" })).toBeChecked();
  // The chat keeps its own drawer for folders, network and local-only: the page links to it open.
  await page.getByRole("link", { name: "Thread settings" }).click();
  const chatDrawer = page.getByRole("complementary", { name: "Thread settings" });
  await expect(chatDrawer).toBeVisible();
  await chatDrawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await noHorizontalScroll(page);
});

test("the split view: a thread from its card opens in the panel, links inside it grow the breadcrumb, Open as a page and Close panel, and below 1180 px the address is the page", async ({ page, baseURL }) => {
  test.skip(phone(page), "the panel starts at 1180 px");
  await enter(page, baseURL!);
  const list = page.locator(".threads");
  const box = (await list.boundingBox())!;
  await list.dispatchEvent("contextmenu", { clientX: box.x + box.width / 2, clientY: box.y + box.height - 6 });
  await page.getByRole("menu", { name: "Thread list menu" }).getByRole("menuitem", { name: "New project" }).click();
  await page.getByRole("menuitem", { name: "General" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  await send(page, "start: Alpha");
  const card = page.locator(".tcard").first();
  await expect(card).toContainText("Alpha");
  // The card's title opens the thread beside the chat; focus lands on its heading, Esc closes it.
  await card.getByRole("link", { name: "Alpha" }).click();
  const panel = page.getByRole("complementary", { name: "Alpha" });
  await expect(panel.getByRole("heading", { level: 1, name: "Alpha" })).toBeFocused();
  await expect(panel.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(page.locator("main .tcard")).toHaveCount(1);
  expect(page.url()).toContain("/panel/t/general/");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(page.url()).not.toContain("/panel/");
  // A link inside the panel replaces what it shows and the breadcrumb grows: a mention of Beta, written in Alpha's box.
  await send(page, "start: Beta");
  const betaHref = (await page.locator(".side .children a.thread").filter({ has: page.locator(".title", { hasText: /^Beta$/ }) }).getAttribute("href"))!;
  const betaId = decodeURIComponent(betaHref.split("/t/general/")[1]!);
  await card.getByRole("link", { name: "Alpha" }).click();
  await expect(panel).toBeVisible();
  await panel.getByLabel("Message", { exact: true }).fill(`[t:${betaId}]`);
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.locator(".msg.her").last().getByRole("link", { name: "Beta" }).click();
  const beta = page.getByRole("complementary", { name: "Alpha › Beta" });
  await expect(beta.getByRole("heading", { level: 1, name: "Beta" })).toBeFocused();
  await expect(beta.getByRole("navigation", { name: "Opened from" })).toContainText("Alpha");
  await beta.getByRole("navigation", { name: "Opened from" }).getByRole("link", { name: "Alpha" }).click();
  await expect(page.getByRole("complementary", { name: "Alpha" })).toBeVisible();
  // From the chat's header, Project settings opens in the panel afresh; Open as a page is the page on its own.
  await page.getByRole("link", { name: "Project settings" }).click();
  const settings = page.getByRole("complementary", { name: "Project settings" });
  await expect(settings.getByLabel("Goal")).toBeVisible();
  await settings.getByLabel("Goal").fill("A split view.");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByText("Saved.")).toBeVisible();
  // The divider resizes the panel with the keyboard, and the width is remembered.
  const divider = page.getByRole("separator", { name: "Panel width" });
  await divider.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "460");
  await page.reload();
  await expect(page.getByRole("separator", { name: "Panel width" })).toHaveAttribute("aria-valuenow", "460");
  await page.getByRole("complementary", { name: "Project settings" }).getByRole("link", { name: "Open as a page" }).click();
  await expect(page.getByRole("complementary", { name: "Project settings" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  expect(page.url()).toContain("/p/general/");
  await page.goBack();
  await expect(page.getByRole("complementary", { name: "Project settings" })).toBeVisible();
  // Below 1180 px the same address shows the panel's page on its own.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1000, height: size.height });
  await expect(page.getByRole("complementary", { name: "Project settings" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  await page.setViewportSize(size);
  await expect(page.getByRole("complementary", { name: "Project settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.getByRole("complementary", { name: "Project settings" })).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("watching threads: writing in a project's thread leads to a look, shown as a marker that names the thread she told; the switch turns it off", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const list = page.locator(".threads");
  const box = (await list.boundingBox())!;
  await list.dispatchEvent("contextmenu", { clientX: box.x + box.width / 2, clientY: box.y + box.height - 6 });
  await page.getByRole("menu", { name: "Thread list menu" }).getByRole("menuitem", { name: "New project" }).click();
  await page.getByRole("menuitem", { name: "General" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  const projectUrl = page.url();
  await send(page, "start: Alpha");
  await expect(page.getByText("Started it.")).toBeVisible();
  // Write in Alpha (beside the chat on a wide screen, as the page on a phone); the look comes to the project chat.
  await page.locator(".tcard").first().getByRole("link", { name: "Alpha" }).click();
  const alpha = phone(page) ? page : page.getByRole("complementary", { name: "Alpha" });
  // On a phone the page is still the project chat for a moment after the click; its composer has the same label.
  await expect(alpha.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
  await alpha.getByLabel("Message", { exact: true }).fill("use the raised beds");
  await alpha.getByRole("button", { name: "Send" }).click();
  await expect(alpha.getByText(/You said: use the raised beds/)).toBeVisible();
  if (phone(page)) await page.goto(projectUrl);
  const look = page.locator("main .marker[data-type='watching']");
  await expect(look.getByRole("button")).toContainText("Checked the other threads", { timeout: 20_000 });
  await expect(look.getByRole("button")).toContainText("told 1", { timeout: 20_000 });
  await look.getByRole("button").click();
  await expect(look.getByText("Heads up: the plan changed.")).toBeVisible();
  await expect(look.getByRole("link", { name: "Alpha" })).toHaveCount(2);
  await expect(page.locator("main .threads-card")).toHaveCount(0);
  await expect(page.locator("main .msg.user").filter({ hasText: "[Watching threads]" })).toHaveCount(0);
  // The switch, on by default, saves off.
  await page.getByRole("link", { name: "Project settings" }).first().click();
  const watch = page.getByRole("checkbox", { name: "Watching threads" });
  await expect(watch).toBeChecked();
  await watch.uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Watching threads" })).not.toBeChecked();
  await noHorizontalScroll(page);
});

test("no horizontal scrolling and big enough tap targets on a phone", async ({ page, baseURL }) => {
  test.skip(!phone(page), "phone only");
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await noHorizontalScroll(page);
  for (const button of [
    page.getByRole("button", { name: "Show threads" }), page.getByRole("button", { name: "Thread settings" }),
    page.getByRole("button", { name: /^Model:/ }), page.getByRole("button", { name: "Attach or switch tools" }),
    page.getByRole("button", { name: "Send" }),
  ]) {
    const box = await button.boundingBox();
    expect(box!.height, await button.textContent() ?? "").toBeGreaterThanOrEqual(44);
  }
  await openSettings(page);
  await noHorizontalScroll(page);
  for (const hash of ["memory", "settings/network", "admin/users"]) {
    await page.goto(`/#/u/${userId}/${hash}`);
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page);
  }
});
