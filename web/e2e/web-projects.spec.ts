// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// Speech, the home page, the sidebar, projects, the split view, files, sharing and sleep.
// Tests run in order on this file's own lyricad per size.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { phone, enter, newThread, send, openSettings, openProjectSettings, togglePrivate, location_of, threadIdOf, sendTo, hitHeight, noHorizontalScroll } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("with Read aloud while agent writes on, a reply can be read aloud as it streams, and her stored copy takes the reading over", async ({ page, baseURL }) => {
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
  // The reply being written is the one turn with no stored time yet.
  await expect(page.locator(".turn").filter({ hasNot: page.locator(".who time") }).getByRole("button", { name: "Read aloud" })).toHaveCount(0);
  await expect(page.getByText("in a few pieces.")).toBeVisible({ timeout: 15_000 });

  // The setting is under Speech in Settings, Appearance.
  await page.goto(`/#/u/${encodeURIComponent(userId)}/settings/appearance`);
  const live = page.getByLabel("Read aloud while agent writes");
  await expect(live).not.toBeChecked();
  await live.click();
  await expect(live).toBeChecked();
  await shot("read-aloud-live-setting");
  await page.reload();
  await expect(page.getByLabel("Read aloud while agent writes")).toBeChecked();

  // On: Read aloud appears on the reply she is writing and follows it; her stored copy then owns the reading.
  await page.goBack();
  await page.goBack();
  await expect(message).toBeVisible();
  await message.fill("Say this slowly too");
  await page.getByRole("button", { name: "Send" }).click();
  const writing = page.locator(".turn").filter({ hasNot: page.locator(".who time") });
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
  const userId = await enter(page, baseURL!);
  // The test before may have left Read aloud while agent writes on for this user.
  await page.evaluate((u) => fetch(`/api/u/${encodeURIComponent(u)}/presets`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ readAloudLive: false }) }), userId);
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
  // Without a pick in the thread, Dictation is the local profile's model, even in a cloud-profile thread.
  const mic = page.getByRole("button", { name: "Dictate" });
  await expect(mic).toBeEnabled();
  // Dictation and Read aloud selects in the drawer's Models, offering only models that transcribe or speak; a cloud pick is this thread's.
  let drawer = await openSettings(page);
  const dictation = drawer.getByRole("combobox", { name: "Dictation" });
  await expect(dictation.locator("option")).toHaveText(["Preset (local · whisper · speech)", "cloud · whisper · openai", "local · whisper · speech"]);
  await expect(drawer.getByLabel("Voice to cloud")).toHaveCount(0);
  // A cloud pick asks first: Cancel (or Escape) keeps the profile's, and the drawer stays open.
  const ask = page.getByRole("dialog", { name: "Send your voice to the cloud?" });
  await dictation.selectOption({ label: "cloud · whisper · openai" });
  await expect(ask).toContainText("whisper on openai");
  await shot("dictation-cloud-confirm");
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(dictation.locator("option:checked")).toHaveText("Preset (local · whisper · speech)");
  await dictation.selectOption({ label: "cloud · whisper · openai" });
  await ask.getByRole("button", { name: "Use cloud dictation" }).click();
  await expect(dictation.locator("option:checked")).toHaveText("cloud · whisper · openai");
  await shot("dictation-select");
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
  // Her stored copy, once she has finished (its time appears when it is stored): the one Read aloud on the page.
  await expect(page.locator(".turn .who time")).toBeVisible({ timeout: 15_000 });
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
    const picked = drawer.getByRole("combobox", { name: "Dictation" });
    await expect(picked.locator("option:checked")).toHaveText("cloud · whisper · openai");
    await picked.selectOption({ index: 0 });
    await expect(picked.locator("option:checked")).toHaveText("Preset (local · whisper · speech)");
  } finally {
    await request.post(`${models}/speech/up`);
  }
});

test("a speaking model's Settings drawer sets its voice and clamps its speed; only the Private column has Dictation", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${encodeURIComponent(userId)}/models/tasks`);
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  // Dictation is only in the Private threads column; a cloud model hears a voice only when a thread picks it.
  await expect(page.locator('tr[data-task="speech.transcribe"] [data-col="General threads"]')).toHaveCount(0);
  await expect(page.locator('tr[data-task="speech.transcribe"] [data-col="Private threads"]')).toContainText("whisper");
  await expect(page.locator('tr[data-task="speech.speak"] [data-col="Private threads"]')).toContainText("kokoro");
  await expect(page.locator('tr[data-task="speech.speak"] [data-col="General threads"]')).toContainText("kokoro");
  // Read aloud's picker offers only models that speak: kokoro on speech is already in the list, so nothing else is left.
  await page.locator('tr[data-task="speech.speak"] [data-col="Private threads"]').click();
  const tasks = page.getByRole("complementary", { name: "Edit Read aloud" });
  await tasks.getByRole("button", { name: "Add…" }).click();
  await expect(tasks.getByText("No models match.")).toBeVisible();
  await tasks.getByRole("button", { name: "Close" }).click();

  // The speech endpoint's models, under Models → Hosts and endpoints.
  await page.goto(`/#/u/${encodeURIComponent(userId)}/models/hosts`);
  await page.locator("li.ep-row").filter({ hasText: /^speech/ }).getByRole("button", { name: /models$/ }).click();
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

test("the thread drawer's Read aloud has a Settings link opening the voice drawer of the column's model, or of the thread's pick; Escape closes that drawer first", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  // The dictation test leaves the speech server marked down for a while, so nothing answers Read aloud: reading its models again says it is up.
  await page.evaluate(async (base) => {
    const eps = await (await fetch(`${base}/endpoints`)).json() as { id: string; name: string }[];
    for (const ep of eps.filter((e) => e.name === "speech" || e.name === "openai")) await fetch(`${base}/endpoints/${ep.id}/discover`, { method: "POST", headers: { "content-type": "application/json" } });
  }, `/api/u/${encodeURIComponent(userId)}`);
  await newThread(page, "General");
  const drawer = await openSettings(page);
  const read = drawer.getByRole("combobox", { name: "Read aloud", exact: true });
  const valueOf = (label: string) => read.evaluate((el: HTMLSelectElement, label) => [...el.options].find((o) => o.text === label)?.value, label);
  const cloud = await valueOf("cloud · kokoro · openai");
  const local = await valueOf("local · kokoro · speech");
  expect(cloud && local && cloud !== local).toBeTruthy();
  const link = drawer.getByRole("button", { name: "kokoro settings" });
  const voice = page.getByRole("complementary", { name: "kokoro settings" });
  const opened = () => page.waitForRequest((r) => /\/offerings\/[^/]+\/settings$/.test(r.url())).then((r) => decodeURIComponent(r.url().split("/offerings/")[1]!.split("/")[0]!));

  // Nothing picked: the General column's model, kokoro on the cloud endpoint.
  await expect(read).toHaveValue("");
  let asked = opened();
  await link.click();
  expect(await asked).toBe(cloud);
  await voice.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await expect(voice.getByLabel("English")).toBeVisible();
  await noHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(voice).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(link).toBeFocused();

  // The thread's own pick: the link follows it.
  await read.selectOption(local!);
  await expect(read).toHaveValue(local!);
  asked = opened();
  await link.click();
  expect(await asked).toBe(local);
  await voice.getByRole("button", { name: "Close" }).click();
  await expect(voice).toHaveCount(0);
  await read.selectOption("");
  await expect(read).toHaveValue("");
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);
});

test("the header greets the user and names the version and build, and the home box starts a thread", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Good (night|morning|afternoon|evening), .+\.$/ })).toBeVisible();
  await expect(page.locator(".head .ver")).toHaveAttribute("title", /^Version \S+, build \S+$/);
  await page.getByLabel("Message", { exact: true }).fill("From the home box");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.user").getByText("From the home box")).toBeVisible();
  await expect(page.getByText("You said: From the home box")).toBeVisible();
});

// The app's own fetch, so the request carries the signed-in session as the page's requests do.
async function apiGet<T>(page: Page, path: string): Promise<T> {
  const r = await page.evaluate(async (p) => { const res = await fetch(p, { credentials: "same-origin" }); return { ok: res.ok, status: res.status, body: await res.json() }; }, path);
  expect(r.status).toBe(200);
  return r.body as T;
}

test("opening and closing home tools creates no thread", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}`);
  const threads = async () => (await apiGet<{ id: string; createdAt: string }[]>(page, `/api/u/${userId}/threads`)).map((t) => t.id).sort();
  // The shared lyricad may still be finishing an earlier test's threads: start from a list that has settled.
  const box = page.locator(".home-box");
  await expect(box).toBeVisible();
  let before = await threads();
  await expect.poll(async () => { const now = await threads(); const same = JSON.stringify(now) === JSON.stringify(before); before = now; return same; }, { intervals: [500] }).toBe(true);
  await box.getByRole("button", { name: "Attach or switch tools" }).click();
  await expect(box.getByRole("checkbox", { name: "Images", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box.getByRole("menu", { name: "Attach and tools" })).toHaveCount(0);
  expect(await threads()).toEqual(before);
});

test("home attachments and tool switches stay local until send and follow the selected pool", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}`);
  const threads = () => apiGet<{ id: string; pool: string }[]>(page, `/api/u/${userId}/threads`);
  const before = await threads();
  const uploads: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/uploads?")) uploads.push(r.url()); });
  const box = page.locator(".home-box");
  await expect(box.getByRole("button", { name: "Dictate", exact: true })).toBeVisible();
  await box.getByRole("button", { name: "Attach or switch tools" }).click();
  const menu = box.getByRole("menu", { name: "Attach and tools" });
  const images = menu.getByRole("checkbox", { name: "Images", exact: true });
  await expect(images).toBeChecked();
  await images.uncheck();
  await expect(images).not.toBeChecked();
  await box.locator('input[type="file"]').setInputFiles({ name: "general.txt", mimeType: "text/plain", buffer: Buffer.from("A made-up general attachment") });
  await expect(box.getByLabel("Message", { exact: true })).toHaveValue(/general.txt/);
  await page.keyboard.press("Escape");
  await box.getByRole("button", { name: "Private", exact: true }).click();
  await expect(box.getByLabel("Message", { exact: true })).toHaveValue("");
  await box.locator('input[type="file"]').setInputFiles({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("A made-up private attachment") });
  await expect(box.getByLabel("Message", { exact: true })).toHaveValue(/private.txt/);
  await box.getByRole("button", { name: "General", exact: true }).click();
  await expect(box.getByLabel("Message", { exact: true })).toHaveValue(/general.txt/);
  await expect(box.getByLabel("Message", { exact: true })).not.toHaveValue(/private.txt/);
  await box.getByRole("button", { name: "Attach or switch tools" }).click();
  await expect(box.getByRole("checkbox", { name: "Images", exact: true })).not.toBeChecked();
  await page.keyboard.press("Escape");
  expect(await threads()).toEqual(before);
  expect(uploads).toEqual([]);
  await expect(box.getByRole("menu", { name: "Mode", exact: true })).toHaveCount(0);
  await noHorizontalScroll(page);
  await box.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg.user")).toContainText("general.txt");
  await expect(page.locator(".msg.user")).not.toContainText("private.txt");
  const made = (await threads()).find((t) => !before.some((b) => b.id === t.id));
  expect(made?.pool).toBe("general");
  expect(await apiGet(page, `/api/u/${userId}/threads/general/${encodeURIComponent(made!.id)}/settings`)).toMatchObject({ images: false });
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain("/threads/general/");
  expect(uploads[0]).toContain("name=general.txt");
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

test("the thread header's ⋯ opens the thread's menu: Pin puts the thread under Pinned with a toast, and Unpin takes it out", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "A thread to pin");
  await expect(page.getByText("You said: A thread to pin")).toBeVisible();
  const more = page.getByRole("button", { name: "Thread actions" });
  const pinnedRows = page.locator(".threads .group-rows").filter({ has: page.locator(".eyebrow", { hasText: "Pinned" }) });
  const row = page.locator(".threads").getByRole("link", { name: /A thread to pin/ });

  await more.click();
  // The sidebar's own menu, its letter shortcuts with it.
  await page.getByRole("menuitem", { name: "Pin P", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pinned to the top" })).toBeVisible();
  await expect(more).toBeFocused();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(pinnedRows.getByRole("link", { name: /A thread to pin/ })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Hide threads" }).click();

  // Pressing ⋯ again closes the menu; Escape does too.
  await more.click();
  const unpin = page.getByRole("menuitem", { name: "Unpin" });
  await expect(unpin).toBeVisible();
  await noHorizontalScroll(page);
  await more.click();
  await expect(unpin).toHaveCount(0);
  await more.click();
  await page.keyboard.press("Escape");
  await expect(unpin).toHaveCount(0);
  await more.click();
  await unpin.click();
  await expect(page.getByRole("status").filter({ hasText: "Unpinned" })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(row).toBeVisible();
  await expect(pinnedRows.getByRole("link", { name: /A thread to pin/ })).toHaveCount(0);
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
  // On a failure the message lists the start requests the page made and what each got back (seen once in CI:
  // Beta never started after Start all, with no error shown, and Start then Start all never fails locally).
  const starts: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/suggestions/")) starts.push(`${r.status()} ${r.request().postData()}${r.ok() ? "" : ` ${await r.text().catch(() => "")}`}`);
  });
  await card.getByRole("button", { name: "Start" }).first().click();
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard").first()).toContainText("Alpha");
  // Also what the Start all tap landed on (seen once more in CI: no request at all, the button still enabled).
  await page.evaluate(() => {
    const w = window as unknown as { taps: string[] };
    w.taps = [];
    for (const type of ["pointerdown", "pointerup", "click"]) document.addEventListener(type, (e) => {
      const t = e.target as HTMLElement, all = document.querySelector<HTMLElement>(".suggested .primary");
      w.taps.push(`${type} ${t.tagName}.${t.className} "${(t.textContent ?? "").trim().slice(0, 24)}" at ${Math.round((e as PointerEvent).clientX)},${Math.round((e as PointerEvent).clientY)}; Start all ${all ? `${all.isConnected ? "" : "detached "}${JSON.stringify(all.getBoundingClientRect().toJSON())}` : "gone"}`);
    }, true);
  });
  // The new card fills in after it appears and the chat keeps to its bottom, so Start all slides up about 22 px a
  // moment later; a tap aimed before that lands on the card's prose (seen in CI). Wait until it holds still.
  await expect.poll(() => page.evaluate(async () => {
    const top = () => document.querySelector(".suggested .primary")?.getBoundingClientRect().top;
    const before = top();
    await new Promise((r) => setTimeout(r, 300));
    return before !== undefined && top() === before;
  })).toBe(true);
  await card.getByRole("button", { name: "Start all" }).click();
  await expect(page.locator(".tcard")).toHaveCount(2).catch(async (err: Error) => {
    const taps = await page.evaluate(() => (window as unknown as { taps: string[] }).taps);
    throw new Error(`${err.message}\nStart requests: ${starts.join("; ") || "none"}\nTaps: ${taps.join("; ") || "none"}`);
  });
  await expect(card.getByRole("link", { name: "Open" })).toHaveCount(2);
  const fact = page.getByRole("button", { name: /^Threads/ });
  await expect(fact).toContainText("2");
  await fact.click();
  // From 1180 px up the fact toggles the panel's threads list (pressed while it shows); below, the popover.
  const split = page.viewportSize()!.width >= 1180;
  const pop = split ? page.locator("aside.panel") : page.getByRole("dialog", { name: "The project's threads" });
  await expect(pop.getByRole("link", { name: /Alpha/ })).toBeVisible();
  await expect(pop.getByRole("link", { name: /Beta/ })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-threads-${page.viewportSize()!.width}.png` });
  if (split) { await expect(fact).toHaveAttribute("aria-pressed", "true"); await fact.click(); await expect(pop).toHaveCount(0); } else await page.keyboard.press("Escape");

  // Start a thread from a message's menu; the sidebar nests the project's threads with their state.
  await page.locator(".msg.user").first().getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Start a thread" }).click();
  await expect(page.locator(".tcard")).toHaveCount(3);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(page.locator(".side .children .thread")).toHaveCount(3);
  await expect(page.locator(".side .children .thread").first()).toContainText("Alpha");
  if (phone(page)) await page.getByRole("button", { name: "Hide threads" }).click();

  // Pin from a card: that thread sits first among the project's threads in the sidebar, and Unpin puts it back.
  const beta = page.locator(".tcard").filter({ has: page.getByRole("link", { name: "Beta", exact: true }) });
  await beta.getByRole("button", { name: "Actions for Beta" }).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pinned to the top" })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(page.locator(".side .children .thread").first()).toContainText("Beta");
  if (phone(page)) await page.getByRole("button", { name: "Hide threads" }).click();
  await beta.getByRole("button", { name: "Actions for Beta" }).click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unpinned" })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(page.locator(".side .children .thread").first()).toContainText("Alpha");
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
  // With the project chat open, the row opens Alpha beside it from 1180 px, and as the page below (docs/ux.md §6).
  const alphaView = phone(page) ? page : page.getByRole("complementary");
  await expect(alphaView.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
  await expect(alphaView.getByLabel("Message", { exact: true })).toHaveCount(0);
  // Resolved, the header's Resolve stays, pressed.
  const resolveBtn = alphaView.getByRole("button", { name: "Resolve", exact: true });
  await expect(resolveBtn).toHaveAttribute("aria-pressed", "true");
  await alphaView.getByRole("button", { name: "Reopen" }).click();
  await expect(alphaView.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(resolveBtn).toHaveAttribute("aria-pressed", "false");
  // Open again, its header's Resolve toggles: one press resolves it, a second press reopens it.
  await resolveBtn.click();
  await expect(alphaView.getByLabel("Message", { exact: true })).toHaveCount(0);
  await expect(resolveBtn).toHaveAttribute("aria-pressed", "true");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/resolve-toggle-${page.viewportSize()!.width}.png` });
  await resolveBtn.click();
  await expect(alphaView.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(resolveBtn).toHaveAttribute("aria-pressed", "false");

  // The project settings page: Goal and Paused save together; Memory keeps the instructions.
  if (phone(page)) await page.getByText("Child thread of").getByRole("link").click();
  await openProjectSettings(page);
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
  // Folders and Machines are the drawer's own two controls, under Workspace.
  await expect(page.getByRole("group", { name: "Folders" })).toContainText("An administrator hasn't allowed any folders for this pool.");
  const machinesRow = page.getByRole("group", { name: "Machines" });
  await expect(machinesRow).toContainText("sandbox");
  // A machine is added from + and its search, and taken off with its ✕.
  await page.evaluate(async () => {
    const userId = ((await (await fetch("/api/state")).json()) as { users: { id: string }[] }).users[0]!.id;
    const call = async (path: string, body: unknown) => (await fetch(`/api/u/${userId}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ draft: unknown }>;
    const probe = await call("/machines/probe", { name: "garden-pi", address: "pi@127.0.0.1:1" });
    await call("/machines", { name: "garden-pi", address: "pi@127.0.0.1:1", pool: "general", draft: probe.draft, hostKey: `SHA256:${"A".repeat(43)}` });
  });
  await page.reload();
  await machinesRow.getByRole("button", { name: "Add machine" }).click();
  await page.getByRole("searchbox", { name: "Search machines" }).fill("garden");
  await page.getByRole("dialog", { name: "Add machine" }).getByRole("button", { name: /garden-pi/ }).click();
  await expect(machinesRow.getByRole("button", { name: "Remove garden-pi" })).toBeVisible();
  await expect(machinesRow.getByRole("button", { name: "Add machine" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await machinesRow.getByRole("button", { name: "Remove garden-pi" }).click();
  await expect(machinesRow.getByRole("button", { name: "Add machine" })).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  // Both tooltips name the coordinator outright: this page opens on its own, with no chat in view.
  await expect(page.getByRole("heading", { name: "Workspace", exact: true })).toHaveAttribute("title", "The coordinator's. Every thread it starts gets these or fewer.");
  await expect(page.getByRole("link", { name: "Thread settings" })).toHaveAttribute("title", "The coordinator's models, network and local-only, in its drawer.");
  // The chat keeps its own drawer for network and local-only: the page links to it open.
  await page.getByRole("link", { name: "Thread settings" }).click();
  const chatDrawer = page.getByRole("complementary", { name: "Thread settings" });
  await expect(chatDrawer).toBeVisible();
  await chatDrawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await noHorizontalScroll(page);
});

test("hovering New project opens its flyout beside the item, and it flips at the right edge", async ({ page, baseURL }) => {
  test.skip(phone(page), "flyouts are for devices that can hover");
  await enter(page, baseURL!);
  const list = page.locator(".threads");
  // A right-click on the list itself, at the foot of the sidebar. Earlier tests fill the list, and a real
  // click at a point can land on a row if the list reloads in between (live sync reloads it on any change).
  // Playwright's dispatchEvent drops the point for a contextmenu event, so the event is made here.
  await list.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.bottom - 6 }));
  });
  const menu = page.getByRole("menu", { name: "Thread list menu" });
  const item = menu.getByRole("menuitem", { name: "New project" });
  await expect(item).toBeVisible();
  await item.hover();
  const fly = page.locator(".ctx-menu.flyout");
  await expect(fly.getByRole("menuitem", { name: "General" })).toBeVisible();
  // The menu itself stays as it was, and the item keeps its highlight while its flyout is open.
  await expect(menu.getByRole("menuitem", { name: "New group…" })).toBeVisible();
  await expect(item).toHaveAttribute("aria-expanded", "true");
  const f = (await fly.boundingBox())!, i = (await item.boundingBox())!;
  const first = (await fly.getByRole("menuitem", { name: "General" }).boundingBox())!;
  expect(Math.abs(first.y - i.y)).toBeLessThan(2); // its first row lines up with the item
  expect(f.x).toBeGreaterThanOrEqual(i.x + i.width - 2); // and it opens to the right
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/flyout-${page.viewportSize()!.width}.png` });

  // From the keyboard: → moves into the flyout, ← closes it and puts focus back on its item.
  await item.focus();
  await page.keyboard.press("ArrowRight");
  await expect(fly.getByRole("menuitem", { name: "General" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(fly).toHaveCount(0);
  await expect(item).toBeFocused();

  // Resting on a sibling item closes it (the pointer is still on the item, so a click reopens the flyout first).
  await item.click();
  await expect(fly).toBeVisible();
  await menu.getByRole("menuitem", { name: "New group…" }).hover();
  await expect(fly).toHaveCount(0);

  // Near the right edge there is no room on the right, so it opens to the left instead.
  // The thread header's ⋯ puts its menu's right edge under the button, at the viewport's edge.
  await newThread(page, "General");
  const more = page.getByRole("button", { name: "Thread actions" });
  await more.click();
  const shareItem = page.getByRole("menuitem", { name: "Share with" });
  await expect(shareItem).toBeVisible();
  await shareItem.hover();
  await expect(fly).toBeVisible();
  const f2 = (await fly.boundingBox())!, i2 = (await shareItem.boundingBox())!;
  expect(f2.x + f2.width).toBeLessThanOrEqual(i2.x + 1); // it opens to the left of its item
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/flyout-flip-${page.viewportSize()!.width}.png` });
});

test("a menu that grows under a resting pointer keeps the flyout that pointer opened", async ({ page, baseURL }) => {
  test.skip(phone(page), "flyouts are for devices that can hover");
  const userId = await enter(page, baseURL!);
  // A project, so the thread menu adds Move to project once its projects arrive; they are held back until Share with is open.
  await page.evaluate(async (uid) => {
    for (const body of [{ pool: "general", project: true, title: "Late project" }, { pool: "general", title: "Late items" }]) {
      const r = await fetch(`/api/u/${uid}/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`threads: ${r.status}`);
    }
  }, userId);
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route(/\/threads\?all=1$/, async (route) => { await held; await route.continue(); });
  // Opened at the foot of the window, the menu is kept on screen, so the late item pushes its rows up under the pointer.
  const row = page.getByRole("link", { name: "Late items" }).first();
  await expect(row).toBeVisible();
  await row.evaluate((el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: innerHeight - 4 })));
  const menu = page.getByRole("menu", { name: "Late items menu" });
  const share = menu.getByRole("menuitem", { name: "Share with" });
  await share.click();
  await expect(share).toHaveAttribute("aria-expanded", "true");
  release();
  await expect(menu.getByRole("menuitem", { name: "Move to project" })).toBeVisible();
  // Move to group now sits where Share with was; resting there longer than the hover delay doesn't open it.
  await page.waitForTimeout(600);
  await expect(share).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem", { name: "Move to group" })).toHaveAttribute("aria-expanded", "false");
  await page.unroute(/\/threads\?all=1$/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("tapping New project on a phone replaces the menu in place with its choices", async ({ page, baseURL }) => {
  test.skip(!phone(page), "devices that can hover get the flyout instead");
  await enter(page, baseURL!);
  await page.getByRole("button", { name: "Show threads" }).click();
  const list = page.locator(".threads");
  // Scrolled and measured again on each try: earlier tests may fill the list, and the status panel below it can
  // still be growing, which shortens the list and leaves a row, not the strip under the last one, at its foot.
  // A click there opens the row's menu instead; close that and try again until the list's own menu opens.
  const listMenu = page.getByRole("menu", { name: "Thread list menu" });
  await expect(async () => {
    if (await page.getByRole("menu").count()) await page.keyboard.press("Escape");
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const box = (await list.boundingBox())!;
    await list.click({ button: "right", position: { x: box.width / 2, y: box.height - 6 }, timeout: 2000 });
    await expect(listMenu).toBeVisible({ timeout: 1000 });
  }).toPass();
  await listMenu.getByRole("menuitem", { name: "New project" }).click();
  // Without hover the menu is replaced in place by a ‹ Back row, as today.
  await expect(page.locator(".ctx-menu .back")).toBeVisible();
  await expect(page.locator(".flyout")).toHaveCount(0);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/submenu-in-place-390.png` });
});

test("New project in the sidebar creates a pinned project and opens it", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const side = page.locator(".side");
  // One row style each, and opening one choice closes the other.
  await side.getByRole("button", { name: "New thread" }).click();
  await expect(side.getByRole("group", { name: "New thread in" })).toBeVisible();
  // Clicking the row again closes its choice; the row stays put, collapsed.
  await side.getByRole("button", { name: "New thread" }).click();
  await expect(side.getByRole("group", { name: "New thread in" })).toHaveCount(0);
  await expect(side.getByRole("button", { name: "New thread" })).toHaveAttribute("aria-expanded", "false");
  await side.getByRole("button", { name: "New thread" }).click();
  await expect(side.getByRole("group", { name: "New thread in" })).toBeVisible();
  await side.getByRole("button", { name: "New project" }).click();
  await expect(side.getByRole("group", { name: "New thread in" })).toHaveCount(0);
  const choice = side.getByRole("group", { name: "New project in" });
  await expect(choice).toBeVisible();
  // The row stays in place above its choice, so the choice reads as its own.
  await expect(side.getByRole("button", { name: "New project" })).toHaveAttribute("aria-expanded", "true");
  await expect(side.getByRole("button", { name: "New thread" })).toHaveAttribute("aria-expanded", "false");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/sidebar-new-${page.viewportSize()!.width}.png` });
  // Escape closes the choice too, and focus goes back to its row.
  await page.keyboard.press("Escape");
  await expect(choice).toHaveCount(0);
  await expect(side.getByRole("button", { name: "New project" })).toHaveAttribute("aria-expanded", "false");
  await expect(side.getByRole("button", { name: "New project" })).toBeFocused();
  // Going to another page folds the choice back under its row.
  await side.getByRole("button", { name: "New project" }).click();
  await expect(choice).toBeVisible();
  await side.getByRole("link", { name: "Memory" }).click();
  await expect(page).toHaveURL(/memory/);
  await expect(choice).toHaveCount(0);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(side.getByRole("button", { name: "New project" })).toHaveAttribute("aria-expanded", "false");
  // Search's field and a New choice close each other.
  await side.getByRole("button", { name: "New thread" }).click();
  await side.getByText("Search", { exact: true }).click();
  const field = side.getByRole("searchbox", { name: "Search titles and messages" });
  await expect(field).toBeVisible();
  await expect(side.getByRole("group", { name: "New thread in" })).toHaveCount(0);
  await field.fill("zz");
  await side.getByRole("button", { name: "New project" }).click();
  await expect(field).toBeHidden();
  await side.getByText("Search", { exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(choice).toHaveCount(0);
  await side.getByRole("button", { name: "New project" }).click();
  await choice.getByRole("button", { name: "General" }).click();
  // A new project is created pinned and opened at once, same as the list menu's item does.
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  // Earlier tests share this user, so look for the project just opened: it is the current row, under Pinned.
  await expect(side.locator('.thread.project[aria-current="page"]')).toHaveCount(1);
  await expect(side.locator(".eyebrow").first()).toContainText("Pinned");
});

test("Project settings → Files and images: the project folder one folder at a time, with Upload, New folder, Open, Rename, Move to, Delete and the Images tab", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const side = page.locator(".side");
  await side.getByRole("button", { name: "New project" }).click();
  await side.getByRole("group", { name: "New project in" }).getByRole("button", { name: "General" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  const threadId = decodeURIComponent(location_of(page).split("/t/general/")[1]!.split("/")[0]!);
  const upload = (name: string, b64: string) => page.evaluate(async ([path, b64]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return ((await r.json()) as { path: string }).path;
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/uploads?name=${encodeURIComponent(name)}`, b64] as const);
  await upload("plan.md", Buffer.from("# The plan\n\nWater the trays.\n").toString("base64"));
  await upload("tray.png", "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBNJjFAAAiOQZ3YJ5p9QAAAABJRU5ErkJggg==");

  await page.goto(`/#/u/${encodeURIComponent(userId)}/p/general/${encodeURIComponent(threadId)}/files`);
  const section = page.getByRole("region", { name: "Files and images" });
  await expect(section.getByRole("button", { name: "Files", exact: true })).toHaveAttribute("aria-pressed", "true");
  const rows = section.locator(".pfile-row");
  const row = (name: string) => rows.filter({ has: page.getByText(name, { exact: true }) });
  // The project chat's uploads land in shared/, where its threads read them at /shared.
  await expect(row("shared")).toContainText("Folder");
  // New folder names its row in place.
  await section.getByRole("button", { name: "New folder" }).click();
  await section.getByLabel("Folder name").fill("notes");
  await section.getByLabel("Folder name").press("Enter");
  await expect(row("notes")).toBeVisible();
  // Open goes into a folder; the crumbs come back out.
  await row("shared").getByRole("button", { name: "Open" }).click();
  await row("uploads").getByRole("button", { name: "Open" }).click();
  await expect(section.getByRole("navigation", { name: "Folder" })).toHaveText("Project folder/shared/uploads");
  await expect(row("plan.md")).toContainText("B");
  // A file opens in the viewer, the project chat beside it from 1180 px up.
  await row("plan.md").getByRole("button", { name: "Open" }).click();
  const viewer = page.getByRole("dialog", { name: "plan.md" });
  await expect(viewer.locator(".viewer-head .fname")).toHaveText("shared/uploads/plan.md");
  await expect(viewer.locator(".viewer-prose")).toBeVisible();
  if (!phone(page)) await expect(viewer.locator(".viewer-thread h1")).toBeVisible();
  else await expect(viewer.getByRole("button", { name: "Thread", exact: true })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/viewer-project-${page.viewportSize()!.width}.png` });
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  // Upload puts files in the folder shown.
  await section.locator('input[type="file"]').setInputFiles({ name: "seeds.txt", mimeType: "text/plain", buffer: Buffer.from("Basil, chard") });
  await expect(row("seeds.txt")).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-files-${page.viewportSize()!.width}.png` });
  // Rename edits the name in place.
  await row("seeds.txt").getByRole("button", { name: "Actions for seeds.txt" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await section.getByLabel("New name").fill("sowing.txt");
  await section.getByLabel("New name").press("Enter");
  await expect(row("sowing.txt")).toBeVisible();
  // Move to… opens a drawer with every other folder.
  await row("plan.md").getByRole("button", { name: "Actions for plan.md" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const drawer = page.getByRole("complementary", { name: "Move plan.md" });
  await expect(drawer.getByLabel("Folder").locator("option")).toHaveText(["Project folder", "notes", "shared"]);
  await drawer.getByLabel("Folder").selectOption({ label: "notes" });
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-files-move-${page.viewportSize()!.width}.png` });
  await drawer.getByRole("button", { name: "Move" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(row("plan.md")).toHaveCount(0);
  await section.getByRole("navigation", { name: "Folder" }).getByRole("button", { name: "Project folder" }).click();
  await row("notes").getByRole("button", { name: "Open" }).click();
  await expect(row("plan.md")).toBeVisible();
  // Delete… is confirmed by a dialog named after the file.
  await row("plan.md").getByRole("button", { name: "Actions for plan.md" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete plan.md?" });
  await expect(dialog).toContainText("for every thread of the project");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(section.getByText("Empty")).toBeVisible();
  // Images: the folder's images as a grid, each opening large.
  await section.getByRole("button", { name: "Images", exact: true }).click();
  await expect(section.locator(".pfiles-grid img")).toHaveCount(1);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/project-images-${page.viewportSize()!.width}.png` });
  await section.getByRole("button", { name: /^Open .*\.png$/ }).click();
  await expect(page.locator("dialog.viewer .viewer-media img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.viewer")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("the split view: a thread from its card opens in the panel, links inside it grow the breadcrumb, Open as a page, Open in panel and Close panel; Open beside, View thread and the Threads list open beside at 1180 px up, and below it they navigate", async ({ page, baseURL }) => {
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
  // Open as a page and Close panel follow the thread's own buttons at the same spacing, as one row.
  const gaps = await panel.locator(".thread-head").evaluate((head) => {
    const buttons = [...head.querySelectorAll(".head-actions > *, .panel-actions > *")].map((el) => el.getBoundingClientRect());
    return buttons.slice(1).map((b, i) => Math.round(b.left - buttons[i]!.right));
  });
  expect(new Set(gaps).size, JSON.stringify(gaps)).toBe(1);
  if (process.env.SCREENSHOTS) await panel.locator(".thread-head").screenshot({ path: `${process.env.SCREENSHOTS}/panel-head-${page.viewportSize()!.width}.png` });
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
  // From the chat's header, Project opens the project's overview beside the chat, pressed while it shows; Project settings inside it opens one crumb deeper; Open as a page is the page on its own.
  const projectButton = page.locator(".head-actions").getByRole("button", { name: "Project", exact: true });
  await expect(projectButton).toHaveAttribute("aria-pressed", "false");
  await projectButton.click();
  await expect(page.getByRole("complementary", { name: "Threads" }).getByRole("heading", { level: 1, name: "Threads" })).toBeFocused();
  await expect(projectButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("complementary", { name: "Threads" }).getByRole("link", { name: "Project settings" }).click();
  const settings = page.getByRole("complementary", { name: /Project settings$/ }); // its trail starts afresh after a reload
  await expect(projectButton).toHaveAttribute("aria-pressed", "false");
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
  // Dragging it changes the column itself, not just its number: --panel-w has to reach .app's grid.
  const dbox = (await divider.boundingBox())!;
  await page.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dbox.x + dbox.width / 2 - 70, dbox.y + dbox.height / 2);
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "530");
  const dragged = (await settings.boundingBox())!;
  expect(Math.round(dragged.width)).toBe(530);
  // Dragged far left it stops where the conversation keeps its 48ch, and far right at 280 px.
  const wbox = (await divider.boundingBox())!;
  await page.mouse.move(wbox.x + wbox.width / 2, wbox.y + wbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(wbox.x - 600, wbox.y + wbox.height / 2);
  await page.mouse.up();
  const conversation = (await page.getByRole("main").boundingBox())!;
  expect(conversation.width).toBeGreaterThan(360);
  expect((await settings.boundingBox())!.width).toBeGreaterThan(600);
  await divider.focus();
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "280");
  expect(Math.round((await settings.boundingBox())!.width)).toBe(280);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
  await settings.getByRole("link", { name: "Open as a page" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  expect(page.url()).toContain("/p/general/");
  // The page opened that way goes back beside the chat with Open in panel in the same place, or with Esc.
  await page.getByRole("link", { name: "Open in panel" }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("link", { name: "Open as a page" }).click();
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in panel" })).toHaveCount(0);
  // Below 1180 px the same address shows the panel's page on its own.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1000, height: size.height });
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  await page.setViewportSize(size);
  await expect(settings).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(settings).toHaveCount(0);
  // The Threads fact in the chat's facts line toggles the project's threads list in the panel, pressed while it shows.
  const fact = page.locator(".tfacts").getByRole("button", { name: /^Threads/ });
  await expect(fact).toHaveAttribute("aria-pressed", "false");
  await fact.click();
  const threadList = page.locator("aside.panel");
  await expect(threadList.getByRole("heading", { level: 1, name: "Threads" })).toBeFocused();
  await expect(fact).toHaveAttribute("aria-pressed", "true");
  expect(page.url()).toMatch(/\/panel\/.*\/threads$/);
  // The popover's groups and rows (§5): state as a word, time in mono. A row swaps that thread into the panel; the breadcrumb grows.
  await expect(threadList.locator(".picker-ep").first()).toBeVisible();
  await expect(threadList.getByRole("link", { name: /Alpha/ })).toBeVisible();
  await expect(threadList.getByRole("link", { name: /Beta/ })).toBeVisible();
  await threadList.getByRole("link", { name: /^Alpha/ }).click();
  const alphaTrail = page.getByRole("complementary", { name: "Threads › Alpha" });
  await expect(alphaTrail.getByRole("heading", { level: 1, name: "Alpha" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fact).toHaveAttribute("aria-pressed", "false");
  // Open beside: a child row's menu item, and Shift+click on the row itself, open it in the panel beside the chat in a fresh trail.
  const betaRow = page.locator('.side li:has(> .trow a[aria-current="page"]) .children a.thread, .side li:has(> .children a[aria-current="page"]) .children a.thread').filter({ has: page.locator(".title", { hasText: /^Beta$/ }) });
  await betaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "Beta menu" }).getByRole("menuitem", { name: "Open beside" }).click();
  const betaBeside = page.getByRole("complementary", { name: "Beta" });
  await expect(betaBeside.getByRole("heading", { level: 1, name: "Beta" })).toBeFocused();
  const alphaRow = page.locator(".side li:has(> .trow a[aria-current=\"page\"]) .children a.thread").filter({ has: page.locator(".title", { hasText: /^Alpha$/ }) });
  await alphaRow.click({ modifiers: ["Shift"] });
  const alphaBeside = page.getByRole("complementary", { name: "Alpha" });
  await expect(alphaBeside.getByRole("heading", { level: 1, name: "Alpha" })).toBeFocused();
  // With the parent open, a plain click on a child row opens it beside too, replacing what the panel shows; the chat stays.
  const chatTitle = (await page.locator("main h1").innerText()).trim();
  await betaRow.click();
  await expect(page.getByRole("complementary", { name: "Beta" }).getByRole("heading", { level: 1, name: "Beta" })).toBeFocused();
  await expect(page.locator("main h1")).toHaveText(chatTitle);
  await alphaRow.click();
  await expect(alphaBeside.getByRole("heading", { level: 1, name: "Alpha" })).toBeFocused();
  // The row of the thread in the panel is outlined, and only that one.
  await expect(alphaRow).toHaveAttribute("data-beside", "true");
  await expect(betaRow).not.toHaveAttribute("data-beside");
  await expect(page.locator(".side a.thread[data-beside]")).toHaveCount(1);
  // A double-click on a row's title renames it in place; so does one on the chat's title.
  await betaRow.locator(".title").dblclick();
  const rowField = page.locator(".side .children a.thread").getByRole("textbox", { name: "Title" });
  await rowField.fill("Beta two");
  await rowField.press("Enter");
  await expect(page.locator(".side .children a.thread .title", { hasText: /^Beta two$/ })).toBeVisible();
  await page.locator("main h1").dblclick();
  const titleField = page.locator("main h1").getByRole("textbox", { name: "Title" });
  await titleField.fill("Split project");
  await titleField.press("Enter");
  await expect(page.locator("main").getByRole("heading", { level: 1, name: "Split project" })).toBeVisible();
  await expect(page.locator(".side a.thread.project .title", { hasText: /^Split project$/ })).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  // View thread at a card's foot opens the thread beside the chat; so does a double-click on the card's empty space.
  const alphaCard = page.locator(".tcard").filter({ has: page.getByRole("link", { name: "Alpha", exact: true }) });
  await alphaCard.getByRole("link", { name: "View thread" }).click();
  const viewed = page.getByRole("complementary", { name: "Alpha" });
  await expect(viewed.getByRole("heading", { level: 1, name: "Alpha" })).toBeFocused();
  await page.keyboard.press("Escape");
  await alphaCard.dblclick({ position: { x: 4, y: 4 } });
  await expect(viewed).toBeVisible();
  expect(page.url()).toContain("/panel/");
  await page.keyboard.press("Escape");
  // Below 1180 px they navigate: Threads is the popover again, View thread goes to the page, Shift+click on a row opens it as the page, and its menu has no Open beside.
  await page.setViewportSize({ width: 1000, height: size.height });
  await fact.click();
  const pop = page.getByRole("dialog", { name: "The project's threads" });
  await expect(pop).toBeVisible();
  expect(page.url()).not.toContain("/panel/");
  await page.keyboard.press("Escape");
  await alphaCard.getByRole("link", { name: "View thread" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
  expect(page.url()).not.toContain("/panel/");
  const betaTwo = page.locator(".side li:has(> .children a[aria-current=\"page\"]) .children a.thread").filter({ has: page.locator(".title", { hasText: /^Beta two$/ }) });
  await betaTwo.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Beta two menu" }).getByRole("menuitem", { name: "Open beside" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await betaTwo.click({ modifiers: ["Shift"] });
  await expect(page.getByRole("heading", { level: 1, name: "Beta two" })).toBeVisible();
  expect(page.url()).not.toContain("/panel/");
  await page.setViewportSize(size);
  await noHorizontalScroll(page);
});

test("watching threads: writing in a project's thread leads to a look, shown as a marker that names the other thread she told; the switch turns it off", async ({ page, baseURL }) => {
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
  await send(page, "start: Beta");
  await expect(page.getByText("Started it.")).toHaveCount(2);
  // Write in Alpha (beside the chat on a wide screen, as the page on a phone); the look comes to the project chat.
  // Its anchor can be a non-displayed entry before the user message. It must stay there,
  // rather than moving under each new reply or child update (and putting Beta first).
  const alphaCard = page.locator(".msg.user").filter({ has: page.getByText("start: Alpha", { exact: true }) }).locator("+ .tcard");
  await expect(alphaCard.getByRole("link", { name: "Alpha", exact: true })).toBeVisible();
  await expect(page.locator(".tcard-title")).toHaveText(["Alpha", "Beta"]);
  await page.locator(".tcard").first().getByRole("link", { name: "Alpha" }).click();
  const alpha = phone(page) ? page : page.getByRole("complementary", { name: "Alpha" });
  // On a phone the page is still the project chat for a moment after the click; its composer has the same label.
  await expect(alpha.getByRole("heading", { level: 1, name: "Alpha", exact: true })).toBeVisible();
  await alpha.getByLabel("Message", { exact: true }).fill("use the raised beds");
  await alpha.getByRole("button", { name: "Send" }).click();
  await expect(alpha.getByText(/You said: use the raised beds/)).toBeVisible();
  if (phone(page)) await page.goto(projectUrl);
  const look = page.locator("main .marker[data-type='watching']");
  await expect(look.getByRole("button")).toContainText("Checked the other threads", { timeout: 20_000 });
  await expect(look.getByRole("button")).toContainText("told 1", { timeout: 20_000 });
  await look.getByRole("button").click();
  await expect(look.getByText("Heads up: the plan changed.")).toBeVisible();
  // Looked at Alpha, told Beta.
  await expect(look.getByRole("link", { name: "Alpha" })).toHaveCount(1);
  await expect(look.getByRole("link", { name: "Beta" })).toHaveCount(1);
  await expect(page.locator("main .threads-card")).toHaveCount(0);
  await expect(page.locator("main .msg.user").filter({ hasText: "[Watching threads]" })).toHaveCount(0);
  // The switch, on by default, saves off.
  await openProjectSettings(page);
  const watch = page.getByRole("checkbox", { name: "Watching threads" });
  await expect(watch).toBeChecked();
  await watch.uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Watching threads" })).not.toBeChecked();
  await noHorizontalScroll(page);
});

test("a project's thread cards: the checklist's count after the state word opens its popover, and the current step is the first line until all are done or the thread is resolved", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const list = page.locator(".threads");
  const box = (await list.boundingBox())!;
  await list.dispatchEvent("contextmenu", { clientX: box.x + box.width / 2, clientY: box.y + box.height - 6 });
  await page.getByRole("menu", { name: "Thread list menu" }).getByRole("menuitem", { name: "New project" }).click();
  await page.getByRole("menuitem", { name: "General" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
  // No looks: one could message Gamma after it is resolved, and a message reopens it.
  await page.evaluate(async (path) => {
    const r = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ watchThreads: false }) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }, `/api/u/${userId}/threads/general/${encodeURIComponent(threadIdOf(page.url()))}`);
  await send(page, "suggest: Gamma, Delta");
  await expect(page.getByText("Suggested.")).toBeVisible();
  await page.getByRole("group", { name: "Suggested threads" }).getByRole("button", { name: "Start all" }).click();
  await expect(page.locator(".tcard")).toHaveCount(2);
  const cardOf = (name: string) => page.locator(".tcard").filter({ has: page.getByRole("link", { name, exact: true }) });
  const [gamma, delta] = [cardOf("Gamma"), cardOf("Delta")];
  const idOf = async (card: Locator) => threadIdOf((await card.locator(".tcard-title").getAttribute("href"))!);
  await expect(gamma.locator(".tcard-count, .tcard-step")).toHaveCount(0);

  // One mid-way, one all done.
  await sendTo(page, userId, await idOf(gamma), "steps: done Sow the beds; doing Water the rows; todo Weed the paths");
  await sendTo(page, userId, await idOf(delta), "steps: done Sow the beds; done Water the rows; done Weed the paths");
  const count = gamma.getByRole("button", { name: "Checklist, 1 of 3 steps done" });
  await expect(count).toHaveAttribute("title", "Checklist");
  // Only the numbers are mono.
  await expect(count).toHaveText("1 of 3");
  await expect(count.locator(".num")).toHaveText(["1", "3"]);
  await expect(count.locator(".num").first()).toHaveCSS("font-family", /Plex Mono|monospace/);
  await expect(count).not.toHaveCSS("font-family", /Plex Mono|monospace/);
  await expect(gamma.locator(".tstate + .tcard-count")).toHaveCount(1);
  const step = gamma.locator(".tcard-step");
  await expect(step).toContainText("Water the rows");
  await expect(step.locator(".step-mark")).toHaveText("✱");
  await expect(step).toHaveCSS("white-space", "nowrap");
  await expect(step).toHaveCSS("text-overflow", "ellipsis");
  await expect(delta.getByRole("button", { name: "Checklist, 3 of 3 steps done" })).toBeVisible();
  await expect(delta.locator(".tcard-step")).toHaveCount(0);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/checklist-cards-${page.viewportSize()!.width}.png` });
  if (phone(page)) expect(await hitHeight(count)).toBeGreaterThanOrEqual(44);

  await count.click();
  const pop = page.getByRole("dialog", { name: "Checklist" });
  await expect(pop.getByRole("listitem").locator(".step-mark")).toHaveText(["✓", "✱", "○"]);
  if (phone(page)) {
    // On a phone it opens in flow under the card's head, inside the card, with no shadow.
    const [p, c, h] = await Promise.all([pop.boundingBox(), gamma.boundingBox(), gamma.locator(".tcard-head").boundingBox()]);
    expect(p!.x).toBeGreaterThanOrEqual(c!.x);
    expect(p!.x + p!.width).toBeLessThanOrEqual(c!.x + c!.width + 1);
    expect(p!.y).toBeGreaterThanOrEqual(h!.y + 20);
    expect(p!.y + p!.height).toBeLessThanOrEqual(c!.y + c!.height + 1);
    await expect(pop).toHaveCSS("box-shadow", "none");
  }
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/checklist-card-popover-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);

  // Resolved: the count stays, the step line goes.
  await gamma.getByRole("button", { name: "Actions for Gamma" }).click();
  await page.getByRole("menuitem", { name: "Resolve" }).click();
  await expect(gamma).toContainText("Resolved");
  await expect(gamma.locator(".tcard-step")).toHaveCount(0);
  await expect(count).toBeVisible();
  await noHorizontalScroll(page);
});

test("the Files panel: a tree one folder at a time, a file shown, search, the Images tab, and the menu's attach, new folder, rename and delete", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "hello files");
  await expect(page.getByText("You said: hello files")).toBeVisible();
  const threadId = decodeURIComponent(location_of(page).split("/t/general/")[1]!.split("/")[0]!);
  // Two uploads through the message box's route: a note and a tiny image.
  const upload = (name: string, b64: string) => page.evaluate(async ([path, b64]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return ((await r.json()) as { path: string }).path;
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/uploads?name=${encodeURIComponent(name)}`, b64] as const);
  await upload("plan.md", Buffer.from("# The plan\n\nWater the trays.\n").toString("base64"));
  // An uploaded image gets a random name with its extension (docs/workspace.md), so the test reads the name back.
  const trayPath = await upload("tray.png", "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBNJjFAAAiOQZ3YJ5p9QAAAABJRU5ErkJggg==");
  expect(trayPath).toMatch(/^\/workspace\/uploads\/[0-9a-f]{12}\.png$/);
  const tray = trayPath.slice("/workspace/uploads/".length);

  await page.getByRole("link", { name: "Files and images" }).click();
  // Beside the conversation from 1180 px; the page on its own on a phone.
  const panel = phone(page) ? page.locator(".files-page") : page.getByRole("complementary");
  await expect(panel.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("button", { name: "uploads", exact: true }).click();
  await panel.getByRole("button", { name: "plan.md", exact: true }).click();
  // A file opens in the viewer: Markdown rendered, its Source a segment away, the thread beside it from 1180 px up.
  const viewer = page.getByRole("dialog", { name: "plan.md" });
  await expect(viewer.locator(".viewer-prose h1")).toHaveText("The plan");
  await expect(viewer.locator(".viewer-facts")).toContainText("Markdown");
  await viewer.getByRole("button", { name: "Source" }).click();
  await expect(viewer.locator(".viewer-text")).toContainText("# The plan");
  const beside = viewer.getByRole("region", { name: "hello files" });
  if (phone(page)) {
    await expect(beside).toHaveCount(0);
    await viewer.getByRole("button", { name: "Thread", exact: true }).click();
    await expect(beside.getByRole("heading", { level: 1, name: "hello files" })).toBeVisible();
    await expect(viewer.locator(".viewer-file")).toHaveCount(0);
    await beside.getByRole("button", { name: "Close panel" }).click();
    await expect(viewer.locator(".viewer-file")).toBeVisible();
  } else {
    await expect(beside.getByRole("heading", { level: 1, name: "hello files" })).toBeVisible();
    await expect(beside.getByText("You said: hello files")).toBeVisible();
  }
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/viewer-markdown-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await panel.getByLabel("Search files").fill(tray.slice(0, 6));
  await expect(panel.getByRole("button", { name: `uploads/${tray}`, exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /plan\.md/ })).toHaveCount(0);
  await panel.getByLabel("Search files").fill("");

  // The menu on a file: Attach puts its path in the message box.
  const open = async (name: string) => {
    // Back on the Files page (a phone), the tree starts afresh with uploads folded.
    const uploads = panel.getByRole("button", { name: "uploads", exact: true });
    await expect(uploads).toBeVisible();
    if ((await uploads.getAttribute("aria-expanded")) === "false") await uploads.click();
    if (phone(page)) { await panel.getByRole("button", { name, exact: true }).click(); await page.getByRole("dialog", { name }).getByRole("button", { name: "File actions" }).click(); }
    else await panel.getByRole("button", { name, exact: true }).click({ button: "right" });
    return page.getByRole("menu", { name: "File actions" });
  };
  let menu = await open("plan.md");
  await menu.getByRole("menuitem", { name: "Attach to message" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/\/workspace\/uploads\/plan\.md/);
  // Sent, the message names the file, and Show in thread goes to it.
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("You said: /workspace/uploads/plan.md")).toBeVisible();
  // Once the turn ends, the stored message (with its number) replaces the live one.
  await expect(page.locator(".msg.user", { hasText: "/workspace/uploads/plan.md" })).toHaveAttribute("id", /^m-/);
  if (phone(page)) await page.getByRole("link", { name: "Files and images" }).click();
  menu = await open("plan.md");
  await menu.getByRole("menuitem", { name: "Show in thread" }).click();
  await expect(page.locator(".msg.user.flash")).toContainText("/workspace/uploads/plan.md");
  // The path in her reply is a link that shows the file; the person's message links it too.
  await expect(page.locator(".msg.user a.fpath", { hasText: "/workspace/uploads/plan.md" })).toBeVisible();
  await page.locator(".prose a.fpath", { hasText: "/workspace/uploads/plan.md" }).first().click();
  const linked = page.getByRole("dialog", { name: "plan.md" });
  await expect(linked.locator(".viewer-head .fname")).toHaveText("uploads/plan.md");
  await expect(linked.locator(".viewer-prose")).toContainText("Water the trays.");
  await linked.getByRole("button", { name: "Close", exact: true }).click();
  await expect(linked).toHaveCount(0);
  if (phone(page)) { await page.goBack(); await page.getByRole("heading", { level: 1, name: "hello files" }).waitFor(); }
  // An image she writes from the thread folder shows in the message and opens large.
  await page.getByLabel("Message", { exact: true }).fill(`![the tray](${trayPath})`);
  // An image named in the draft shows above the box with its ✕, a 44 px target on a phone (docs/ux.md §6, The message box).
  const remove = page.getByRole("list", { name: "Attached images" }).getByRole("button", { name: `Remove ${tray}` });
  await expect(remove).toBeVisible();
  if (phone(page)) expect(await hitHeight(remove)).toBeGreaterThanOrEqual(44);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/attachments-${page.viewportSize()!.width}.png` });
  await page.getByRole("button", { name: "Send" }).click();
  const thumb = page.getByRole("button", { name: "the tray, open large" });
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(page.locator("dialog.lightbox img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.lightbox")).toBeHidden();
  if (phone(page)) await page.getByRole("link", { name: "Files and images" }).click();
  // A new folder under uploads, renamed, then deleted with the note.
  await expect(panel.getByRole("button", { name: "uploads", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "uploads", exact: true }).click({ button: "right" });
  menu = page.getByRole("menu", { name: "File actions" });
  await menu.getByRole("menuitem", { name: "New folder…" }).click();
  await menu.getByLabel("Folder name").fill("drafts");
  await menu.getByRole("button", { name: "Add" }).click();
  await expect(panel.getByRole("button", { name: "drafts", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "drafts", exact: true }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Rename…" }).click();
  await menu.getByLabel("New name").fill("sketches");
  await menu.getByRole("button", { name: "Rename" }).click();
  await expect(panel.getByRole("button", { name: "sketches", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "sketches", exact: true }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.getByRole("dialog")).toContainText("deleted for good");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(panel.getByRole("button", { name: "sketches", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "plan.md", exact: true })).toBeVisible();
  // Rename and Delete at the right of a row in a writable folder: shown on hover (always on a phone), the name edited in place.
  await panel.getByRole("button", { name: "plan.md", exact: true }).hover();
  await panel.getByRole("button", { name: "Rename plan.md" }).click();
  const newName = panel.getByRole("textbox", { name: "New name" });
  await expect(newName).toHaveValue("plan.md");
  await newName.fill("notes.md");
  await newName.press("Enter");
  await expect(panel.getByRole("button", { name: "notes.md", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "notes.md", exact: true }).hover();
  await panel.getByRole("button", { name: "Delete notes.md" }).click();
  await expect(page.getByRole("dialog")).toContainText("notes.md is deleted for good");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(panel.getByRole("button", { name: "notes.md", exact: true })).toHaveCount(0);
  // Beside the thread, the tree follows what she writes: a command's file shows once the call ends, with nothing reopened.
  if (!phone(page)) {
    await send(page, "run: echo made > /workspace/uploads/made.txt");
    const allow = page.getByRole("group", { name: "Allow bash?" });
    if (await allow.isVisible({ timeout: 3000 }).catch(() => false)) await allow.getByRole("button", { name: "Allow" }).click();
    await expect(page.getByText("The command finished.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "made.txt", exact: true })).toBeVisible();
  }

  await panel.getByRole("tab", { name: "Images" }).click();
  await expect(panel.locator(".igrid").getByRole("button", { name: tray, exact: true })).toBeVisible();
  await panel.getByRole("group", { name: "Show" }).getByRole("button", { name: "Made by Lyrica" }).click();
  await expect(panel.getByText("No images yet")).toBeVisible();
  await noHorizontalScroll(page);
});

test("the file viewer: an image steps to the previous or next image of its list with the buttons and Left and Right", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "hello images");
  await expect(page.getByText("You said: hello images")).toBeVisible();
  const threadId = decodeURIComponent(location_of(page).split("/t/general/")[1]!.split("/")[0]!);
  const upload = (name: string, b64: string) => page.evaluate(async ([path, b64]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return ((await r.json()) as { path: string }).path;
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/uploads?name=${encodeURIComponent(name)}`, b64] as const);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBNJjFAAAiOQZ3YJ5p9QAAAABJRU5ErkJggg==";
  // Two images and a note in one folder: the note is skipped.
  const names = [await upload("a.png", png), await upload("b.png", png)].map((p) => p.slice("/workspace/uploads/".length)).sort();
  await upload("plan.md", Buffer.from("# The plan\n").toString("base64"));

  await page.getByRole("link", { name: "Files and images" }).click();
  const panel = phone(page) ? page.locator(".files-page") : page.getByRole("complementary");
  await panel.getByRole("button", { name: "uploads", exact: true }).click();
  await panel.getByRole("button", { name: names[0], exact: true }).click();
  let viewer = page.getByRole("dialog", { name: names[0] });
  await expect(viewer.locator(".viewer-facts")).toContainText("Image 1 of 2");
  await expect(viewer.getByRole("button", { name: "Previous image" })).toBeDisabled();
  if (phone(page)) expect(await hitHeight(viewer.getByRole("button", { name: "Next image" }))).toBeGreaterThanOrEqual(44);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/viewer-steps-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("ArrowRight");
  viewer = page.getByRole("dialog", { name: names[1] });
  await expect(viewer.locator(".viewer-facts")).toContainText("Image 2 of 2");
  await expect(viewer.getByRole("button", { name: "Next image" })).toBeDisabled();
  await viewer.getByRole("button", { name: "Previous image" }).click();
  await expect(page.getByRole("dialog", { name: names[0] })).toBeVisible();
  // The clicked button keeps the focus, so the keys go on working.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: names[1] })).toBeVisible();
  await page.keyboard.press("Escape");

  // A Markdown file has no steps.
  await panel.getByRole("button", { name: "plan.md", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "plan.md" }).getByRole("button", { name: "Next image" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the file viewer: an HTML page runs in a sandbox that can't reach Lyrica, its console beneath, the thread beside", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "make a page");
  await expect(page.getByText("You said: make a page")).toBeVisible();
  const threadId = decodeURIComponent(location_of(page).split("/t/general/")[1]!.split("/")[0]!);
  const html = `<!doctype html><html><body><h1>Garden</h1><script>
console.warn("old three.js");
let reached; try { reached = parent.document.title; } catch { reached = "blocked"; }
console.log("parent: " + reached);
let cookie; try { cookie = document.cookie; } catch { cookie = "blocked"; }
console.log("cookie: " + cookie);
fetch("/api/u/${userId}/me").then((r) => console.log("api: " + r.status), () => console.log("api: refused"));
</script></body></html>`;
  await page.evaluate(async ([path, body]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/octet-stream" }, body });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/uploads?name=garden.html`, html] as const);
  const pdf = minimalPdf();
  await page.evaluate(async ([path, body]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/octet-stream" }, body });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/uploads?name=paper.pdf`, pdf] as const);

  await page.getByRole("link", { name: "Files and images" }).click();
  const panel = phone(page) ? page.locator(".files-page") : page.getByRole("complementary");
  await panel.getByRole("button", { name: "uploads", exact: true }).click();
  await panel.getByRole("button", { name: "garden.html", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "garden.html" });
  await expect(viewer.frameLocator("iframe.viewer-frame").getByRole("heading", { name: "Garden" })).toBeVisible();
  const lines = viewer.getByRole("region", { name: "Console" }).locator("li");
  await expect(lines).toHaveText(["old three.js", "parent: blocked", "cookie: blocked", "api: refused"], { timeout: 15_000 });
  await expect(lines.first()).toHaveClass(/c-warn/);
  if (!phone(page)) {
    // Beside the file the thread has no Close panel of its own (the Thread toggle hides it): the viewer's Close ends its header, at the far right.
    const beside = viewer.getByRole("region", { name: "make a page" });
    await expect(beside.getByText("You said: make a page")).toBeVisible();
    await expect(beside.getByRole("button", { name: "Close panel" })).toHaveCount(0);
    await expect(beside.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(viewer.locator(".viewer-head").getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await viewer.getByRole("button", { name: "Thread", exact: true }).click();
    await expect(viewer.locator(".viewer-head").getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Thread", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "Thread", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/viewer-html-${page.viewportSize()!.width}.png` });
  // Source shows the page as text; Preview runs it again.
  await viewer.getByRole("button", { name: "Source" }).click();
  await expect(viewer.locator(".viewer-text")).toContainText("<h1>Garden</h1>");
  await viewer.getByRole("button", { name: "Preview" }).click();
  await expect(viewer.frameLocator("iframe.viewer-frame").getByRole("heading", { name: "Garden" })).toBeVisible();
  await noHorizontalScroll(page);
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(viewer).toHaveCount(0);

  // A real PDF loads in the frame as one (the headless browser here has no PDF viewer to show it with).
  const pdfAnswer = page.waitForResponse((r) => r.url().includes("/files/view?path=") && r.url().includes("paper.pdf"));
  await panel.getByRole("button", { name: "paper.pdf", exact: true }).click();
  const pdfViewer = page.getByRole("dialog", { name: "paper.pdf" });
  await expect(pdfViewer.locator(".viewer-facts")).toContainText("PDF");
  const answered = await pdfAnswer;
  expect(answered.status()).toBe(200);
  expect(answered.headers()["content-type"]).toBe("application/pdf");
  await page.keyboard.press("Escape");
  await expect(pdfViewer).toHaveCount(0);

  // With the thread's internet off the page runs nothing, and the viewer says so.
  await page.evaluate(async (path) => {
    const r = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ internet: false }) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
  }, `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/settings`);
  await panel.getByRole("button", { name: "garden.html", exact: true }).click();
  await expect(viewer.getByText("Scripts don't run here: this thread's internet is off.")).toBeVisible();
  await expect(viewer.frameLocator("iframe.viewer-frame").getByRole("heading", { name: "Garden" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(viewer.getByRole("region", { name: "Console" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

/** A one-page PDF with a valid cross-reference table. */
function minimalPdf(): string {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("Share with sends a copy; the recipient sees it in Notifications and adds it to Private", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const pronouns = { subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themself" };
  await page.evaluate(async ([path, data]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    if (!r.ok && r.status !== 400) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }, [`/api/u/${userId}/admin/users`, { login: "sam", password: "pw-sam", displayName: "Sam", pronouns, admin: false }] as const);
  // Ada's thread with one exchange.
  const t = await page.evaluate(async ([uid]) => {
    const r = await fetch(`/api/u/${uid}/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: "general", title: "Seed order" }) });
    const th = (await r.json()) as { id: string };
    await fetch(`/api/u/${uid}/threads/general/${encodeURIComponent(th.id)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "beans and squash" }) });
    return th.id;
  }, [userId] as const);
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(t)}`);
  await expect(page.getByText("You said: beans and squash").last()).toBeVisible({ timeout: 15_000 });
  // On a phone the sidebar is an overlay: open it when its user button isn't showing.
  const openSide = async () => { if (phone(page) && !(await page.getByRole("button", { name: /Switch user/ }).isVisible())) await page.getByRole("button", { name: "Show threads" }).click(); };
  // Share with › Sam, confirm.
  await openSide();
  await page.getByRole("link", { name: "Seed order" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share with" }).click();
  await page.getByRole("menuitem", { name: "Sam" }).click();
  await expect(page.getByRole("heading", { name: "Send a copy to Sam?" })).toBeVisible();
  await page.getByRole("button", { name: "Send a copy" }).click();
  await expect(page.getByRole("heading", { name: "Send a copy to Sam?" })).toBeHidden();
  // Sam logs in: the sidebar counts one, the page shows the share, Add to Private opens the copy.
  await openSide();
  await page.getByRole("button", { name: /Switch user/ }).click();
  await page.getByRole("menuitem", { name: "Log in as another user…" }).click();
  await page.getByLabel("Login name", { exact: true }).fill("sam");
  await page.getByLabel("Password", { exact: true }).fill("pw-sam");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Switch user")).toBeAttached();
  await openSide();
  const link = page.getByRole("link", { name: /^Notifications/ });
  await expect(link.locator(".count")).toHaveText("1");
  await link.click();
  const row = page.locator(".nrow", { hasText: "Ada shared “Seed order” with you" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add to Private" }).click();
  await expect(page.getByText("You said: beans and squash").last()).toBeVisible();
  await expect(page).toHaveURL(/\/t\/private\//);
  await openSide();
  await expect(page.getByRole("link", { name: /^Notifications/ }).locator(".count")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("Sleep History and Came from: the sidebar link opens it empty, the mode is set in Settings, Sleep now asks and then runs, and the administrator sets the time", async ({ page, baseURL, request }, testInfo) => {
  const userId = await enter(page, baseURL!);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await page.locator('a[data-nav="sleep"]').click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/sleep$`));
  await expect(page.getByRole("heading", { level: 1, name: "Sleep" })).toBeVisible();
  await expect(page.getByText("Nothing to raise.")).toBeVisible();
  await expect(page.getByText("No sleep yet.")).toBeVisible();
  if (phone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await noHorizontalScroll(page);

  // Settings → Sleep: Only when I ask, saved at once; the Sleep page says so.
  await page.goto(`/#/u/${userId}/settings/sleep`);
  const mode = page.getByRole("combobox", { name: "Sleep", exact: true });
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/sleep/mode"));
  await mode.selectOption({ label: "Only when I ask" });
  expect((await saved).ok()).toBe(true);
  await expect(mode).toHaveValue("manual");
  await page.goto(`/#/u/${userId}/sleep`);
  await expect(page.getByText("Manual: only when you ask")).toBeVisible();

  // Something has to have happened since the last sleep, or Sleep now is refused ("nothing is new").
  await newThread(page, "General");
  await send(page, "Pelicans eat fish");
  await expect(page.getByText("You said: Pelicans eat fish")).toBeVisible();
  await page.goto(`/#/u/${userId}/sleep`);

  // Sleep now → General asks first; confirming runs it. The fake model never calls her sleep tools; in manual mode a fresh thread opens when it ends.
  await page.getByRole("button", { name: "Sleep now" }).click();
  await page.getByRole("menu", { name: "Sleep now" }).getByRole("menuitem", { name: "General" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Sleep now" }).click();
  await expect(page).toHaveURL(/\/t\/general\//);
  await page.goto(`/#/u/${userId}/sleep`);
  const row = page.locator(".sleep-run[data-pool=general]");
  // The fake model only echoes and never calls her sleep tools, so the phases end unwritten: the run is partial.
  await expect(row).toHaveAttribute("data-status", "partial");
  await expect(row).toContainText("Stopped early");
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByText("No sleep yet.")).toHaveCount(0);
  await row.locator("summary.sleep-sum").click();
  await expect(row.locator(".sleep-detail")).toBeVisible();
  await expect(row.locator(".sleep-detail")).not.toContainText("Loading…");
  if (phone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await noHorizontalScroll(page);
  // Items need her to call tools, which the fake model doesn't: Start a chat and Dismiss are covered by daemon tests.
  await expect(page.locator("ul.sleep-items")).toHaveCount(0);

  // More nights: one preview, a heading link, then server-side paging and search.
  const fixture = await request.post(`http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}/history-fixture`, { data: { userId } });
  expect(fixture.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(".sleep-run")).toHaveCount(1);
  const historyHead = page.locator(".section-head", { has: page.getByRole("heading", { name: "History", exact: true }) });
  const all = historyHead.getByRole("link", { name: "Show all" });
  const headingBox = await historyHead.getByRole("heading").boundingBox();
  const linkBox = await all.boundingBox();
  expect(Math.abs(headingBox!.y - linkBox!.y)).toBeLessThan(12);
  expect(linkBox!.x).toBeGreaterThan(headingBox!.x + headingBox!.width);
  const headBox = await historyHead.boundingBox();
  expect(headBox!.x + headBox!.width - (linkBox!.x + linkBox!.width)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("sleep-preview.png") });
  await all.click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/history/sleep$`));
  await expect(page.getByRole("heading", { level: 1, name: "Sleep history" })).toBeVisible();
  await expect(page.locator(".sleep-run")).toHaveCount(20);
  await page.screenshot({ path: testInfo.outputPath("sleep-history.png") });
  const firstIds = await page.locator(".sleep-run").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-run")));
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page.locator(".sleep-run")).toHaveCount(5);
  const secondIds = await page.locator(".sleep-run").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-run")));
  expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  // The page number rides in the address; the current button stays focusable, marked as such.
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/history/sleep\\?page=2$`));
  const pager = page.getByRole("navigation", { name: "Pages", exact: true });
  const currentPage = pager.getByRole("button", { name: "Page 2", exact: true });
  await expect(currentPage).toHaveAttribute("aria-current", "page");
  await expect(currentPage).toBeEnabled();
  // Only the digits are mono, never the whole phrase.
  await expect(pager.locator("> span.num")).toHaveCount(0);
  await page.getByLabel("Search", { exact: true }).fill("endpoint-down");
  await expect(page.locator(".sleep-run")).toHaveCount(1);
  await expect(page.locator(".sleep-run")).toContainText("Skipped: the endpoint was down");
  await expect(page.locator("main").getByRole("navigation", { name: "Pages", exact: true })).toContainText("Page 1 of 1");
  // The search text rides in the address too, so Back leaves this page for good and returns to it with the same search.
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/history/sleep\\?q=endpoint-down$`));
  await page.goto(`/#/u/${userId}/sleep`);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/history/sleep\\?q=endpoint-down$`));
  await expect(page.locator(".sleep-run")).toHaveCount(1);
  await noHorizontalScroll(page);
  await page.getByLabel("Search", { exact: true }).fill("absent-night");
  await expect(page.getByText("Nothing matches.")).toBeVisible();

  // Lineage expands in place, keeping the memory and earlier sections visible.
  await page.goto(`/#/u/${userId}/memory/general/p:lineage-fixture`);
  const cameFrom = page.getByRole("region", { name: "Came from", exact: true });
  const usedIn = page.getByRole("region", { name: "Used in", exact: true });
  const memoryText = page.locator(".mem-item > .prose");
  await expect(cameFrom.locator(".lk")).toHaveCount(4);
  await expect(usedIn.locator(".lk")).toHaveCount(4);
  const memoryURL = page.url();
  for (const section of [cameFrom, usedIn]) {
    const heading = await section.getByRole("heading").boundingBox();
    const link = await section.getByRole("link", { name: "Show all", exact: true }).boundingBox();
    const row = await section.locator(".section-head").boundingBox();
    expect(Math.abs(heading!.y - link!.y)).toBeLessThan(12);
    expect(link!.x).toBeGreaterThan(heading!.x + heading!.width);
    expect(row!.x + row!.width - link!.x - link!.width).toBeLessThan(2);
  }
  for (const section of [usedIn, cameFrom]) {
    await section.getByRole("link", { name: "Show all", exact: true }).click();
    await expect(page).toHaveURL(memoryURL);
    await expect(section.locator(".lk")).toHaveCount(8);
    await expect(section.getByRole("link", { name: "Show less", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(memoryText).toBeVisible();
    await expect(page.locator(".history")).toHaveCount(0);
    if (section === usedIn) await expect(cameFrom).toBeVisible();
    else await expect(usedIn).toHaveCount(0);
    const list = section.locator(".links");
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto")).toBe(true);
    expect(await list.locator(".lk").evaluateAll((cards) => cards.every((card) => card.scrollHeight <= card.clientHeight + 1))).toBe(true);
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await noHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(section === usedIn ? "used-in-expanded.png" : "came-from-expanded.png") });
    await section.getByRole("link", { name: "Show less", exact: true }).click();
    await expect(section.locator(".lk")).toHaveCount(4);
    await expect(page.locator(".history")).toBeVisible();
    await expect(usedIn).toBeVisible();
  }
  // A short list needs no expansion link; navigating also resets expansion.
  await cameFrom.getByRole("link", { name: "Show all", exact: true }).click();
  await page.goto(`/#/u/${userId}/memory/general/p:lineage-use-1`);
  await expect(cameFrom.locator(".lk")).toHaveCount(1);
  await expect(cameFrom.getByRole("link", { name: "Show all", exact: true })).toHaveCount(0);
  // A memory written once has no earlier version, so it shows no History section at all.
  await expect(page.locator(".history")).toHaveCount(0);

  // WAKE's sleep versions use the same preview and page, retaining Restore; the preview holds the newest earlier version.
  await page.goto(`/#/u/${userId}/memory/general/wake`);
  await expect(page.locator(".hist details")).toHaveCount(1);
  await expect(page.locator(".hist ins")).toHaveText("23");
  await expect(page.locator(".history").getByRole("button", { name: "Restore" })).toBeVisible();
  await page.locator(".history").getByRole("link", { name: "Show all" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Memory history" })).toBeVisible();
  await expect(page.locator(".hist details")).toHaveCount(20);
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page.locator(".hist details")).toHaveCount(4);
  await expect(page.locator(".hist .n").first()).toHaveText("4 of 24");
  await expect(page.locator(".hist .n").last()).toHaveText("1 of 24");
  await page.getByLabel("Search", { exact: true }).fill("Fixture dream 1");
  await expect(page.locator(".hist details")).toHaveCount(11);
  await expect(page.locator(".hist details").first().getByRole("button", { name: "Restore" })).toBeVisible();
  await noHorizontalScroll(page);
  await page.goto(`/#/u/${userId}/sleep`);

  // Journal entries themselves also have a one-entry preview and a shared history page.
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("group", { name: "Layer", exact: true }).getByRole("button", { name: "Journal", exact: true }).click();
  const journal = page.getByRole("region", { name: "Browse memory", exact: true });
  await expect(journal.locator(".mem-list > a")).toHaveCount(1);
  await journal.getByRole("link", { name: "Show all", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Journal history" })).toBeVisible();
  await expect(page.locator("main .list > li")).toHaveCount(20);
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page.locator("main .list > li")).toHaveCount(4);
  await page.getByLabel("Search", { exact: true }).fill("Fixture journal 1");
  await expect(page.locator("main .list > li")).toHaveCount(11);
  await noHorizontalScroll(page);
  await page.goto(`/#/u/${userId}/sleep`);

  // Private hidden in the Sort menu: its line shows and Sleep now no longer offers it. Then back on.
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await togglePrivate(page);
  if (phone(page)) await page.locator(".scrim").first().click({ position: { x: 370, y: 400 } });
  await expect(page.getByText("Private is hidden.")).toBeVisible();
  await page.getByRole("button", { name: "Sleep now" }).click();
  const poolMenu = page.getByRole("menu", { name: "Sleep now" });
  await expect(poolMenu.getByRole("menuitem", { name: "General" })).toBeVisible();
  await expect(poolMenu.getByRole("menuitem", { name: "Private" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await togglePrivate(page);
  if (phone(page)) await page.locator(".scrim").first().click({ position: { x: 370, y: 400 } });
  await expect(page.getByText("Private is hidden.")).toHaveCount(0);

  // Administration → Sleep: the time saves, then Save is off again.
  await page.goto(`/#/u/${userId}/admin/sleep`);
  const time = page.getByLabel("Sleep time");
  const save = page.getByRole("button", { name: "Save" });
  await expect(time).not.toHaveValue("");
  await expect(save).toBeDisabled();
  // Another time half a day away, as serve.ts sets it, so later tests in this run don't reach it either.
  const later = new Date(Date.now() + 13 * 3600_000).toISOString().slice(11, 16);
  const next = await time.inputValue() === later ? new Date(Date.now() + 14 * 3600_000).toISOString().slice(11, 16) : later;
  await time.fill(next);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Sleep time")).toHaveValue(next);
});
