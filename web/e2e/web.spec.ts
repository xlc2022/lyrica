// The web UI against a real lyricad (e2e/serve.ts) and a fake model server,
// at phone and desktop sizes. Tests run in order on one lyricad per size.
import { expect, test, type Locator, type Page } from "@playwright/test";

const PASSPHRASE = "correct horse";
test.describe.configure({ mode: "serial" });

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 760;

/** Unlocks and logs in as needed, and makes sure ada has a cloud and a local endpoint. Returns ada's user ID. */
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
    await login.fill("ada");
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
    await api("PUT", "/columns/private/chat", { model: await add("gpu", "local", "local", "local-model") });
    await api("PUT", "/columns/general/chat", { model: await add("router", "cloud", "cloud", "cloud-model") });
    // The same fake speech server as a local and as a cloud endpoint: whisper transcribes, kokoro speaks English and Mandarin.
    for (const [name, kind] of [["speech", "local"], ["openai", "cloud"]] as const) {
      const ep = await api("POST", "/endpoints", { name, kind, baseUrl: `${models}/speech/v1` }) as Ep;
      const found = await api("POST", `/endpoints/${ep.id}/discover`) as Ep;
      const whisper = found.models.find((m) => m.modelId === "whisper")!.id;
      const kokoro = found.models.find((m) => m.modelId === "kokoro")!.id;
      await api("PATCH", `/offerings/${whisper}`, { transcribe: true });
      await api("PATCH", `/offerings/${kokoro}`, { speak: { voices: [{ id: "af_heart", language: "en" }, { id: "zf_xiaobei", language: "zh" }] } });
      const column = kind === "local" ? "private" : "general";
      await api("PUT", `/columns/${column}/speech.transcribe`, { model: { offeringId: whisper } });
      await api("PUT", `/columns/${column}/speech.speak`, { model: { offeringId: kokoro } });
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

/** From a project chat, opens its settings page: Project in the header shows the overview (the Threads page on a phone,
 *  the panel from 1180 px) with the Project settings link inside; from the panel, Open as a page (docs/ux.md §6). */
async function openProjectSettings(page: Page) {
  await page.locator(".head-actions").getByRole("button", { name: "Project", exact: true }).click();
  if (phone(page)) {
    await page.getByRole("link", { name: "Project settings" }).click();
  } else {
    await page.getByRole("complementary", { name: "Threads" }).getByRole("link", { name: "Project settings" }).click();
    await page.getByRole("complementary", { name: /Project settings$/ }).getByRole("link", { name: "Open as a page" }).click();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
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
const location_of = (page: Page) => page.url();

/** A general thread's ID, from a link to it. */
const threadIdOf = (href: string) => decodeURIComponent(href.split("/t/general/")[1]!.split("/")[0]!);

/** Sends a message to a general thread through the API, as another tab would: the page stays as it is, an open popover too. */
async function sendTo(page: Page, userId: string, threadId: string, text: string) {
  await page.evaluate(async ([path, text]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/messages`, text] as const);
}

/** On a touch screen, a facts-line link reaches 44 px through its ::after. */
const hitHeight = (button: Locator) => button.evaluate((el) => parseFloat(getComputedStyle(el, "::after").height) || el.getBoundingClientRect().height);

async function noHorizontalScroll(page: Page) {
  // A drawer slides in from 30 px past the edge for 180 ms; measure once every animation has finished.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity) // a pulsing dot or the writing dots never finish
    .map((a) => a.finished.catch(() => undefined))));
  const found = await page.evaluate(() => {
    const wide = [...document.querySelectorAll<HTMLElement>(".scroll, .head, .drawer-body, .mem-pane, .mem-read, .side")]
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

test("Portrait photos uploads, downloads, confirms deletion, and saves the cloud setting across reloads", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const base = `/api/u/${userId}/photos-of-me`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
  // Mounted homes need FUSE. Fake only portrait storage; the cloud setting uses real encrypted user.db.
  let photos: { path: string; size: number; type: string }[] = [];
  let uploads = 0;
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataBuffer()).toEqual(png);
      const path = `/photos-of-me/synthetic-${++uploads}.png`;
      photos.push({ path, size: png.length, type: "image/png" });
      await route.fulfill({ json: { path } });
    } else await route.fulfill({ json: photos });
  });
  await page.route(`**${base}/*`, async (route) => {
    const path = `/photos-of-me/${new URL(route.request().url()).pathname.split("/").at(-1)!}`;
    if (route.request().method() === "DELETE") {
      photos = photos.filter((p) => p.path !== path);
      await route.fulfill({ json: { ok: true } });
    } else await route.fulfill({ contentType: "image/png", body: png });
  });
  // Set the starting policy through the real API; the page loads and changes it itself.
  await page.evaluate((id) => fetch(`/api/u/${id}/photo-cloud`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: "ask" }) }), userId);
  await page.goto(`/#/u/${userId}/settings/portraits`);
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("link").last()).toHaveText("Portrait photos");
  await expect(page.getByText("No photos yet.", { exact: true })).toBeVisible();
  const policy = page.getByLabel("Sending them to a cloud image model");
  await expect(policy).toHaveValue("ask");
  await expect(policy).toHaveAttribute("title", "The first time a day one would go to a cloud model, she asks first. A yes lasts until the end of that day.");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add photos", exact: true }).click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles([
    { name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
    { name: "tiny.png", mimeType: "image/png", buffer: png },
    { name: "second.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.getByRole("alert")).toHaveText("too-large.png: Each photo must be at most 20 MB.");
  await expect(page.getByRole("region", { name: "Portrait photos" }).locator(".pill")).toHaveText("2 photos");
  expect(uploads).toBe(2);
  const image = page.getByRole("img", { name: "synthetic-1.png", exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Actions for synthetic-1.png", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe("synthetic-1.png");
  await page.getByRole("button", { name: "Actions for synthetic-1.png", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Delete synthetic-1.png?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(image).toBeVisible();
  for (const name of ["synthetic-1.png", "synthetic-2.png"]) {
    await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("img", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByText("No photos yet.", { exact: true })).toBeVisible();
  for (const value of ["never", "always", "ask"]) {
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/photo-cloud"));
    await policy.selectOption(value);
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(policy).toHaveValue(value);
  }
  await noHorizontalScroll(page);
});

test("the portrait permission card names the resolved model and offers only daily consent", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "An imaginary portrait");
  await expect(page.getByText("You said: An imaginary portrait")).toBeVisible();
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadIdOf(page.url()))}`;
  let pending = true;
  const answers: unknown[] = [];
  await page.route(`**${base}/events`, (route) => route.fulfill({ contentType: "text/event-stream", body: `event: hello\ndata: ${JSON.stringify({
    type: "hello", busy: false, queued: [], permissions: pending ? [{ requestId: "portrait-ask", toolCallId: "image-call", tool: "image",
      args: { question: "Send photos of you to cloud-images?", provider: "cloud-images", model: "cloud-images/gpt-image-1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString() }] : [],
  })}\n\n` }));
  await page.route(`**${base}/permissions/portrait-ask`, (route) => {
    answers.push(route.request().postDataJSON()); pending = false;
    return route.fulfill({ json: { ok: true } });
  });
  for (const label of ["Send today", "Not today"]) {
    pending = true;
    await page.reload();
    const card = page.getByRole("group", { name: "Send portrait photos?" });
    await expect(card).toContainText("Send your portrait photos to cloud-images/gpt-image-1 (cloud) for this image? A yes lasts until the end of the day.");
    await expect(card.getByRole("button")).toHaveCount(2);
    await expect(card.getByRole("button", { name: "Send today", exact: true })).toHaveClass("primary");
    await expect(card.getByRole("button", { name: "Allow in this thread" })).toHaveCount(0);
    await noHorizontalScroll(page);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/permissions/portrait-ask"));
    await card.getByRole("button", { name: label, exact: true }).click();
    await answered;
  }
  expect(answers).toEqual([{ allow: true }, { allow: false }]);
});

test("an image tool result shows inline, opens large, and starts an edit with Images enabled", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "An imaginary garden");
  await expect(page.getByText("You said: An imaginary garden")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const path = "/workspace/images/garden.png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: {
    messages: [{ id: `e:${threadId}#1`, n: 1, role: "assistant", createdAt: "2026-10-12T12:00:00Z", parts: [
      { type: "tool", toolCallId: "garden", name: "image", args: { action: "create", tier: "fast", prompt: "A garden" }, result: path, isError: false },
      { type: "image", paths: [path], model: "box/Z-Image", tier: "fast" },
      { type: "tool", toolCallId: "edit", name: "image", args: { action: "edit", image: path, instruction: "Add a pond" }, result: "The image host is offline.", isError: true },
      { type: "tool", toolCallId: "upscale", name: "image", args: { action: "upscale", image: path }, result: path, isError: false },
    ] }], hasMore: false,
  } }));
  await page.route(`**${base}/files/thumb?*`, (route) => route.fulfill({ status: 404 }));
  await page.route(`**${base}/file?*`, (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.evaluate(async (base) => {
    const r = await fetch(`${base}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ images: false }) });
    if (!r.ok) throw new Error(`Settings: ${r.status}`);
  }, base);
  await page.reload();
  const image = page.getByRole("button", { name: "garden.png", exact: true });
  await expect(image).toBeVisible();
  await expect(image.getByRole("img", { name: "garden.png" })).toHaveAttribute("src", `${base}/file?path=${encodeURIComponent(path)}`);
  await expect(page.getByText("Made with box/Z-Image · fast", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Making an image · fast\b/ })).toBeVisible();
  await page.getByRole("button", { name: "Editing an image" }).click();
  await expect(page.locator(".tool-error")).toHaveText("The image host is offline.");
  await expect(page.getByRole("button", { name: "Upscaling an image" })).toBeVisible();
  await image.click();
  const lightbox = page.getByRole("dialog", { name: "garden.png" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".fname")).toHaveText("garden.png");
  await expect(lightbox.getByRole("img")).toHaveAttribute("src", `${base}/file?path=${encodeURIComponent(path)}`);
  await lightbox.getByRole("button", { name: "Image actions", exact: true }).click();
  await expect(lightbox.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
  await expect(lightbox.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole("menu")).toBeHidden();
  await lightbox.getByRole("button", { name: "Close", exact: true }).click();
  await expect(lightbox).toBeHidden();
  await page.getByRole("button", { name: "Attach or switch tools" }).click();
  const tools = page.getByRole("menu", { name: "Attach and tools" });
  await expect(tools.getByRole("checkbox", { name: "Images", exact: true })).not.toBeChecked();
  await expect(tools.locator("label", { hasText: "Images" })).toHaveAttribute("title", "Lets the agent make and edit images in this thread.");
  await page.getByRole("button", { name: "Attach or switch tools" }).click();
  await page.getByRole("button", { name: "Image actions for garden.png" }).click();
  await expect(page.getByRole("menuitem", { name: "Show in Files" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(`Edit ${path}: `);
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Attach or switch tools" }).click();
  await expect(tools.getByRole("checkbox", { name: "Images", exact: true })).toBeChecked();
  await noHorizontalScroll(page);
});

test("a message's menu regenerates, edits, deletes with Undo, and branches", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "first question");
  await expect(page.getByText("You said: first question")).toBeVisible();
  await send(page, "second question");
  await expect(page.getByText("You said: second question")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "More actions" }).nth(i);

  // Regenerate with another model: her first reply and what followed are replaced, after the Undo delay.
  await menu(1).click();
  await page.getByRole("menuitem", { name: "Regenerate with…" }).click();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/message-menu-${page.viewportSize()!.width}.png` });
  await page.getByRole("menuitem", { name: /local-model/ }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByText("from the fake local-model")).toBeVisible();
  await expect(page.getByText("second question")).toHaveCount(0);

  // Edit the question (a button in its row): it is sent again, as edited.
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
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

  // Branch from her reply (a button in its row): the branch opens, with the conversation so far.
  await page.getByRole("button", { name: "Branch", exact: true }).nth(1).click();
  await expect(page.getByRole("heading", { level: 1, name: /\(branch\)$/ })).toBeVisible();
  await expect(page.getByText("Branched from")).toBeVisible();
  await expect(page.getByText("You said: an edited question")).toBeVisible();
  // A branch has its own mode, and its picker changes it.
  await page.locator(".mode-picker > button").click();
  await page.keyboard.press("1");
  await expect(page.locator(".mode-picker > button")).toContainText("Ask");
  await noHorizontalScroll(page);
});

test("a run of tool calls folds into one marker that opens to a scrolling box, and a message's actions sit under it", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "recall: 4");
  await expect(page.getByText("You said: recall: 4")).toBeVisible();
  const run = page.locator(".marker.tool-run");
  await expect(run).toHaveCount(1);
  await expect(run).toContainText("4 tool calls");
  await expect(run).not.toContainText("running");
  // The calls' own markers stay out of the conversation until the run opens; her reply keeps its name line, the run has none.
  await expect(page.locator(".marker", { hasText: "recall" })).toHaveCount(0);
  await expect(page.locator(".turn.quiet")).toHaveCount(0);
  await run.getByRole("button", { name: /tool calls/ }).click();
  const calls = run.locator(".run-body .marker");
  await expect(calls).toHaveCount(4);
  await expect(calls.first()).toContainText("recall");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/tool-run-${page.viewportSize()!.width}.png` });
  // The action rows: the person's (Copy, Edit, Branch, React, More actions) and hers (Copy, Regenerate, Branch, Read aloud, React, More actions).
  const rows = page.getByRole("group", { name: "Message actions" });
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByRole("button")).toHaveText(["", "", "", "", ""]);
  await expect(rows.first().getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(rows.last().getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
  await expect(rows.last().getByRole("button", { name: "Read aloud" })).toBeVisible();
  await rows.last().getByRole("button", { name: "Copy", exact: true }).hover();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/message-actions-${page.viewportSize()!.width}.png` });
});

test("a code block in her reply shows its language and Copy, which copies its text and reads Copied, then Copy failed where the clipboard refuses", async ({ page, baseURL, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await enter(page, baseURL!);
  await newThread(page, "General");
  // The fake model answers "reply: <markdown>" with the markdown as written; its echo would put the fence mid-line.
  const fence = "```";
  const code = `const wide = [${Array.from({ length: 24 }, (_, i) => `"item-${i}"`).join(", ")}];\nconsole.log(wide.length);`;
  await send(page, ["reply: Try this:", "", `${fence}ts`, code, fence, "", "Then `npm test` again."].join("\n"));
  // Her stored copy has replaced the live one once its menu is there.
  await expect(page.locator("section.turn").getByRole("button", { name: "More actions" })).toBeAttached();
  const block = page.locator(".code-block");
  await expect(block).toHaveCount(1);
  await expect(block.locator(".code-lang")).toHaveText("ts");
  // Inline code has no strip.
  await expect(page.locator(".turn :not(pre) > code", { hasText: "npm test" })).toBeVisible();

  const copy = block.getByRole("button", { name: "Copy code" });
  await expect(copy).toHaveText("Copy");
  if (phone(page)) {
    const box = (await copy.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  // A long line scrolls inside the block, never the page, and the strip stays where it is.
  const pre = block.locator("pre");
  expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const before = await copy.boundingBox();
  await pre.evaluate((el) => { el.scrollLeft = 200; });
  expect(await pre.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  expect(await copy.boundingBox()).toEqual(before);
  await noHorizontalScroll(page);
  await pre.evaluate((el) => { el.scrollLeft = 0; });

  // With SCREENSHOTS set, light and dark copies for the UI review.
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  await shot("code-block");

  await copy.click();
  const copied = block.getByRole("button", { name: "Copied" });
  await expect(copied).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await shot("code-block-copied");
  // No toast, and the label goes back.
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(copy).toHaveText("Copy");

  // Where the clipboard refuses, the label says so, and nothing else changes.
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("denied")) }); });
  await copy.click();
  await expect(block.getByRole("button", { name: "Copy failed" })).toHaveText("Copy failed");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await expect(copy).toHaveText("Copy");
});

test("a pinned message shows in the header's Pinned popover, and unpinning removes it", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "the gate code is 4417");
  await expect(page.getByText("You said: the gate code is 4417")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "More actions" }).nth(i);

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

test("a reaction from the quick row shows as a chip, the full picker opens, and pressing the chip takes it off", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "I got the job!");
  await expect(page.getByText("You said: I got the job!")).toBeVisible();

  // Her reply: the quick row, tada.
  await page.getByRole("button", { name: "React", exact: true }).nth(1).click();
  await page.getByRole("button", { name: "React with tada" }).click();
  const chip = page.locator(".turn .reaction");
  await expect(chip).toHaveText(/🎉\s*1/);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip).toHaveAttribute("title", "You reacted with 🎉");
  // Stored: still there after a reload.
  await page.reload();
  await expect(page.locator(".turn .reaction")).toHaveText(/🎉\s*1/);

  // The full picker, from More emoji, with its search box.
  await page.getByRole("button", { name: "React", exact: true }).first().click();
  await page.getByRole("button", { name: "More emoji" }).click();
  const picker = page.locator("emoji-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator("input[type=search]")).toBeVisible({ timeout: 15_000 });
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/reactions-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await page.locator(".turn .reaction").click();
  await expect(page.locator(".turn .reaction")).toHaveCount(0);
});

test("removing turns that did things asks first, with what goes", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "the shed key is under the pot");
  await expect(page.getByText("You said: the shed key is under the pot")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "More actions" }).nth(i);
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
  // What the parent sent is one line until tapped.
  await expect(view.getByText("Work on Seed list.", { exact: true })).toHaveCount(0);
  await view.getByRole("button", { name: /^Message received from/ }).click();
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

test("a long message from the parent shows its first lines and Show more", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "start long: Long plan");
  await expect(page.getByText("Started it.")).toBeVisible();
  await page.locator(".threads-card").getByRole("link", { name: "Open" }).click();
  const view = phone(page) ? page : page.getByRole("complementary", { name: "Long plan" });
  await expect(view.getByRole("heading", { level: 1, name: "Long plan" })).toBeVisible();
  await view.getByRole("button", { name: /^Message received from/ }).click();
  const block = view.locator(".from-thread .body"); // her reply echoes the task, so look in the block
  await expect(block.getByText("Step 1 of the plan for Long plan.")).toBeVisible();
  const last = block.getByText("Step 30 of the plan for Long plan.");
  await expect(last).not.toBeInViewport();
  await view.getByRole("button", { name: "Show more" }).click();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(view.getByRole("button", { name: "Show less" })).toBeVisible();
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

test("the composer's draft survives a reload, goes once sent, and stays with its thread", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const box = page.getByLabel("Message", { exact: true });
  const draftCall = (method: string) => page.waitForResponse((r) => r.url().endsWith("/draft") && r.request().method() === method);
  const saved = draftCall("PUT");
  await box.fill("Half a thought");
  await saved;
  let loaded = draftCall("GET");
  await page.reload();
  await loaded;
  await expect(box).toHaveValue("Half a thought");

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("You said: Half a thought")).toBeVisible();
  loaded = draftCall("GET");
  await page.reload();
  await loaded;
  await expect(page.locator(".msg.user").getByText("Half a thought")).toBeVisible();
  await expect(box).toHaveValue("");

  // Another thread's box starts empty, and the first thread's text isn't written into it.
  await box.fill("Only for the first thread");
  await draftCall("PUT");
  loaded = draftCall("GET");
  await newThread(page, "General");
  await loaded;
  await expect(box).toHaveValue("");
  loaded = draftCall("GET");
  await page.reload();
  await loaded;
  await expect(box).toHaveValue("");
});

test("after a reply the header's Context shows the percent, and its popover lists the parts", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const facts = page.locator(".thread-head .tfacts");
  await expect(facts.getByRole("button", { name: /^Context/ })).toHaveCount(0);
  await send(page, "How full is it");
  await expect(page.getByText("You said: How full is it")).toBeVisible();
  // From the stream's context event, without a reload.
  const meter = facts.getByRole("button", { name: /^Context \d+%$/ });
  await expect(meter).toBeVisible();
  await expect(meter.locator(".num")).toHaveCSS("font-family", /Plex Mono|monospace/);
  await meter.click();
  const popover = page.getByRole("dialog", { name: "Context" });
  for (const name of ["Conversation", "Free"]) {
    const row = popover.getByRole("listitem").filter({ hasText: new RegExp(`^${name}`) });
    await expect(row.locator(".num")).toHaveText(/^[\d,]+$/);
  }
  await expect(popover.getByText(/^Measured /)).toBeVisible();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/context-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("a thread's checklist: Checklist and its count after Context, a popover of the steps with their marks that a new list redraws in place, the child's card in its parent, and Checklists off in Appearance hides it", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "start: Seed tray");
  await expect(page.getByText("Started it.")).toBeVisible();
  const parentUrl = page.url();
  const card = page.locator(".threads-card");
  const childId = threadIdOf((await card.getByRole("link", { name: "Open" }).getAttribute("href"))!);
  const childUrl = `/#/u/${userId}/t/general/${encodeURIComponent(childId)}`;
  await expect(card.locator(".tcard-count")).toHaveCount(0);

  // In the child: her checklist arrives on the stream and shows after Context, its count in mono; her call is a marker, not a card.
  await page.goto(childUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Seed tray" })).toBeVisible();
  const facts = page.locator(".thread-head .tfacts");
  const fact = facts.getByRole("button", { name: /^Checklist/ });
  await expect(fact).toHaveCount(0);
  await send(page, "steps: done Fill the tray; doing Sow the seeds; todo Label the rows");
  await expect(page.getByText("Checklist set.")).toBeVisible();
  await expect(fact).toHaveText(/^Checklist 1 of 3/);
  await expect(fact.locator(".num")).toHaveText(["1", "3"]);
  await expect(fact.locator(".num").first()).toHaveCSS("font-family", /Plex Mono|monospace/);
  await expect(facts.getByRole("button", { name: /^Context/ })).toBeVisible();
  const words = await facts.evaluate((el) => [...el.querySelectorAll("button")].map((b) => b.textContent!.trim().split(" ")[0]));
  expect(words.indexOf("Checklist")).toBe(words.indexOf("Context") + 1);
  await expect(page.locator(".threads-card")).toHaveCount(0);
  if (phone(page)) expect(await hitHeight(fact)).toBeGreaterThanOrEqual(44);

  // The popover: the steps in order, each a mark in mono (hidden from screen readers, which read its word) and its text.
  await fact.click();
  const pop = page.getByRole("dialog", { name: "Checklist" });
  const items = pop.getByRole("listitem");
  const marks = items.locator(".step-mark");
  await expect(marks).toHaveText(["✓", "✱", "○"]);
  await expect(marks.first()).toHaveAttribute("aria-hidden", "true");
  await expect(marks.first()).toHaveCSS("font-family", /Plex Mono|monospace/);
  await expect(items.locator(".sr-only")).toHaveText(["Done", "Doing", "To do"]);
  await expect(items).toContainText(["Fill the tray", "Sow the seeds", "Label the rows"]);
  // Done muted, the doing mark in the accent, to do in the normal colour: three colours.
  expect(new Set(await marks.evaluateAll((els) => els.map((el) => getComputedStyle(el).color))).size).toBe(3);
  await expect(pop.getByRole("button")).toHaveCount(0);
  await expect(pop.getByRole("heading")).toHaveCount(0);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/checklist-facts-${page.viewportSize()!.width}.png` });

  // A new list (as from another tab) redraws the fact and the open popover in place.
  await sendTo(page, userId, childId, "steps: done Fill the tray; done Sow the seeds; doing Label the rows");
  await expect(marks).toHaveText(["✓", "✓", "✱"]);
  await expect(fact).toHaveText(/^Checklist 2 of 3/);
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await page.reload();
  await expect(fact).toHaveText(/^Checklist 2 of 3/);

  // The child's card in its parent: the count opens the same popover, and the step under way is its first line.
  await page.goto(parentUrl);
  const count = card.getByRole("button", { name: "Checklist, 2 of 3 steps done" });
  await expect(count).toHaveAttribute("title", "Checklist");
  await expect(count.locator(".num")).toHaveText(["2", "3"]);
  await expect(card.locator(".tcard-step")).toContainText("Label the rows");
  await expect(card.locator(".tcard-step .step-mark")).toHaveText("✱");
  if (phone(page)) expect(await hitHeight(count)).toBeGreaterThanOrEqual(44);
  await count.click();
  await expect(pop.getByRole("listitem")).toHaveCount(3);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/checklist-child-card-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");
  // The sidebar rows show nothing.
  await expect(page.locator(".side").getByText("2 of 3")).toHaveCount(0);

  // Checklists off in Appearance: no thread shows one. On again, the stored list is back.
  await page.goto(`/#/u/${userId}/settings/appearance`);
  const on = page.getByRole("checkbox", { name: "Checklists" });
  await expect(on).toBeChecked();
  await expect(page.locator("label.switch").filter({ has: on })).toHaveAttribute("title", "When off, no thread shows a checklist and the agent isn't offered one.");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/checklist-switch-${page.viewportSize()!.width}.png` });
  // It saves at once: the box follows the saved setting.
  await on.click();
  await expect(on).not.toBeChecked();
  await page.goto(parentUrl);
  await expect(page.getByText("Child thread: Seed tray")).toBeVisible();
  await expect(card.locator(".tcard-count, .tcard-step")).toHaveCount(0);
  await page.goto(childUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Seed tray" })).toBeVisible();
  await expect(fact).toHaveCount(0);
  await page.goto(`/#/u/${userId}/settings/appearance`);
  await on.click();
  await expect(on).toBeChecked();
  await page.goto(childUrl);
  await expect(fact).toHaveText(/^Checklist 2 of 3/);
});

test("each message shows when it was sent in mono after its name, her reply once it is stored, and on a phone the header line stays on one line", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  // "slowly" keeps her reply streaming for about 6 s, long enough to look at it.
  await send(page, "What time is it, slowly, and take your time over the answer, because there is no hurry today and the roast still needs an hour in the oven before anyone sits down");
  await expect(page.getByText("You said: What time")).toBeVisible();
  // While her reply streams it is the only turn and has no time yet (the writing dots show only after a non-text part); read in one go, so the turn can't end in between.
  expect(await page.evaluate(() => {
    const turns = [...document.querySelectorAll(".turn")];
    return turns.length > 0 && turns.every((t) => !t.querySelector(".who time"));
  })).toBe(true);

  const mine = page.locator(".msg.user .who");
  const hers = page.locator(".turn .who");
  // Stored: both header lines have a time after the name, hers after the model, in mono, with the whole date as its tooltip.
  for (const who of [mine, hers]) {
    const time = who.locator("time");
    await expect(time).toHaveText(/^\d\d:\d\d$/);
    await expect(time).toHaveClass(/\bnum\b/);
    await expect(time).toHaveCSS("font-family", /Plex Mono|monospace/);
    await expect(time).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
    await expect(time).toHaveAttribute("title", /\d{4}.*\d\d:\d\d$/);
  }
  await expect(mine).toHaveText(/^[^·]+ · \d\d:\d\d$/);
  await expect(hers).toHaveText(/^Lyrica · cloud-model · \d\d:\d\d$/);

  // Nothing wraps on a phone: the name and the time are on one row, today's time and another day's, the widest.
  const oneLine = async () => {
    if (!phone(page)) return;
    for (const who of [mine, hers]) {
      const [time, line] = await Promise.all([who.locator("time").boundingBox(), who.boundingBox()]);
      expect(Math.abs(time!.y - line!.y)).toBeLessThan(time!.height);
      expect(line!.height).toBeLessThan(time!.height * 2);
    }
  };
  await oneLine();
  await noHorizontalScroll(page);
  await page.clock.setFixedTime(new Date(Date.now() + 3 * 864e5));
  await page.reload();
  for (const who of [mine, hers]) await expect(who.locator("time")).toHaveText(/^(\d{1,2} [A-Z][a-z]{2}|[A-Z][a-z]{2} \d{1,2}) \d\d:\d\d$/);
  await oneLine();
  await noHorizontalScroll(page);
});

test("Search finds messages by a rare word, marks it, and a hit opens its thread at that message", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const word = `quillwort${Date.now() % 100_000}`;
  await send(page, `The ${word} key is under the blue pot.`);
  await expect(page.getByText(`You said: The ${word} key`)).toBeVisible();
  await send(page, `And the ${word} gate code is 4417.`);
  await expect(page.getByText(`You said: And the ${word} gate`)).toBeVisible();
  // Somewhere else, so the hit has a thread to open.
  await newThread(page, "General");

  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const side = page.getByRole("complementary", { name: "Threads" });
  await side.getByText("Search", { exact: true }).click();
  const box = side.getByRole("searchbox", { name: "Search titles and messages" });
  await expect(box).toHaveAttribute("placeholder", "Search titles and messages");
  await box.fill(word);
  // Her two replies and the user's two messages, newest first: three, then "1 more in this thread".
  const hits = side.locator(".hit");
  await expect(hits).toHaveCount(3);
  await expect(hits.first().locator("mark")).toHaveText(word);
  await expect(hits.first().locator(".when")).toHaveCSS("font-family", /Plex Mono|monospace/);
  await side.getByRole("button", { name: "1 more in this thread" }).click();
  await expect(hits).toHaveCount(4);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/search-${page.viewportSize()!.width}.png` });

  // Escape clears the query, and the list is back; a word nobody wrote matches nothing.
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(hits).toHaveCount(0);
  await box.fill(`${word}x nowhere`);
  await expect(side.getByText("Nothing matches.")).toBeVisible();
  await box.fill(word);
  await side.getByRole("button", { name: "1 more in this thread" }).click();

  // The user's first message opens its thread there, the message briefly marked.
  const first = hits.filter({ has: page.locator(".by", { hasText: /^you$/ }) }).filter({ hasText: "under the blue pot" });
  await expect(first).toHaveCount(1);
  await first.click();
  const landed = page.locator(".msg.user.flash");
  await expect(landed).toContainText(`The ${word} key is under the blue pot.`);
  await expect(landed).toBeInViewport();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  // The Sort menu's Hidden says what it leaves out.
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(side.locator(".showing label").filter({ hasText: "Hidden" })).toHaveAttribute("title", "Hidden threads are left out of the list and of search.");
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
  const article = page.locator("article.mem-item");
  await expect(article).toContainText("runs at night");
  await expect(article.locator(".prose a").first()).toHaveAttribute("href", new RegExp(encodeURIComponent(threadId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await article.getByRole("button", { name: "Edit" }).click();
  await article.getByLabel("Text").fill("The backup job on node 2 runs at noon.");
  await article.getByRole("button", { name: "Save" }).click();
  await expect(article.locator(".prose").first()).toContainText("runs at noon");

  // The older version opens to its word differences and a Restore button.
  await expect(article.locator(".hist details")).toHaveCount(1);
  await expect(article.locator(".hist details")).toHaveAttribute("open", "");
  await expect(article.locator(".hist .wdiff")).toContainText("night");
  await article.getByRole("button", { name: "Restore" }).first().click();
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
  await expect(page.locator("article.mem-item")).toContainText("about the garden");
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
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await noHorizontalScroll(page);
  await page.getByRole("link", { name: "Machines", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Machines", exact: true })).toContainText("None yet.");
});

test("Git accounts lists none, and Add account checks the token with the host before anything is saved", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/settings/git`);
  const section = page.getByRole("region", { name: "Git accounts", exact: true });
  await expect(section).toContainText("None yet.");
  await section.getByRole("button", { name: "Add account" }).click();
  const drawer = page.getByRole("complementary", { name: "Add account" });
  // A GitHub account is general only.
  await expect(drawer.getByLabel("Kind")).toHaveValue("github");
  await expect(drawer.getByLabel("Host")).toHaveValue("github.com");
  await expect(drawer.locator(".field-fact")).toHaveText(/^General/);
  await expect(drawer.locator(".field-fact")).toHaveAttribute("title", /A GitHub account is general/);
  await drawer.getByLabel("Kind").selectOption("gitea");
  await expect(drawer.getByLabel("Pool")).toBeEnabled();
  await expect(drawer.getByRole("button", { name: "Add account" })).toBeDisabled();
  await drawer.getByLabel("Name", { exact: true }).fill("forge");
  await drawer.getByLabel("Host").fill("127.0.0.1:9");
  await drawer.getByLabel("Account", { exact: true }).fill("lyrica");
  await drawer.getByLabel("Token").fill("not-a-real-token");
  await drawer.getByRole("button", { name: "Add account" }).click();
  await expect(drawer.getByRole("alert")).toContainText("didn't answer");
  await noHorizontalScroll(page);
  await drawer.getByRole("button", { name: "Cancel" }).click();
  await expect(section).toContainText("None yet.");
});

test("Git accounts show their state, and a thread's Repositories adds from what each account can see", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  await page.route("**/git-accounts", (r) => r.request().method() === "GET" ? r.fulfill({ json: [
    { name: "lyrica-bot", kind: "github", host: "github.com", account: "lyrica-bot", pool: "general", offNetwork: true, state: { kind: "signedIn", since } },
    { name: "Forge", kind: "forgejo", host: "git.lan", account: "lyrica", pool: "private", offNetwork: false, state: { kind: "unreachable", since } },
  ] }) : r.fallback());
  await page.route("**/git-accounts/*/repositories*", (r) => r.fulfill({ json: [{ name: "lyrica-bot/scratch", account: "lyrica-bot" }] }));
  await page.goto(`/#/u/${userId}/settings/git`);
  const section = page.getByRole("region", { name: "Git accounts", exact: true });
  await expect(section.locator(".machine-row").first()).toContainText("github.com · general · GitHub · lyrica-bot");
  await expect(section.locator(".machine-row").first()).toContainText("Signed in");
  await expect(section.locator(".machine-row").nth(1)).toContainText("Unreachable 3 h");
  await section.getByRole("button", { name: /^lyrica-bot/ }).click();
  const drawer = page.getByRole("complementary", { name: "lyrica-bot" });
  await drawer.getByRole("button", { name: "Actions for lyrica-bot" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove “lyrica-bot”?" });
  await expect(dialog).toContainText("leave every project and thread");
  await dialog.getByRole("button", { name: "Keep" }).click();
  await drawer.getByRole("button", { name: "Close" }).click();

  await newThread(page, "General");
  await send(page, "Hello");
  await expect(page.getByText("You said: Hello")).toBeVisible(); // the reply's end no longer moves the focus
  const settings = await openSettings(page);
  const repos = settings.getByRole("group", { name: "Repositories" });
  await repos.getByRole("button", { name: "Add repository" }).click();
  const pick = page.getByRole("dialog", { name: "Add repository" });
  await expect(pick.getByPlaceholder("Search, or paste a URL")).toBeFocused();
  await expect(pick.getByRole("group", { name: "lyrica-bot" })).toContainText("lyrica-bot/scratch");
  // A private account isn't offered in a general thread.
  await expect(pick.getByRole("group", { name: "Forge" })).toHaveCount(0);
  await pick.getByPlaceholder("Search, or paste a URL").fill("https://github.com/xlc2022/lyrica.git");
  await expect(pick.getByRole("button", { name: "xlc2022/lyrica" })).toBeVisible();
  await expect(pick.getByRole("link", { name: "Git accounts ›" })).toBeVisible();
  await noHorizontalScroll(page);
});

test("MCP servers: one is checked before it's saved, granted in a thread's drawer, and a call that writes asks on a card", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const url = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 30}/mcp`;
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  await page.goto(`/#/u/${userId}/settings/mcp`);
  const section = page.getByRole("region", { name: "MCP servers", exact: true });
  await expect(section).toContainText("None yet.");
  await section.getByRole("button", { name: "Add server" }).click();
  const adding = page.getByRole("complementary", { name: "Add server" });
  await adding.getByLabel("Name", { exact: true }).fill("house");
  await adding.getByLabel("URL").fill("http://127.0.0.1:9/mcp");
  await adding.getByRole("button", { name: "Add server" }).click();
  // Nothing answers there, so nothing is saved.
  await expect(adding.getByRole("alert")).toContainText("didn't answer");
  await adding.getByLabel("URL").fill(url);
  await adding.getByRole("button", { name: "Add server" }).click();
  const row = section.locator(".machine-row", { hasText: "house" });
  await expect(row).toContainText(`${new URL(url).host} · general · 2 tools`);
  await expect(row).toContainText("Online");
  await noHorizontalScroll(page);
  await shot("mcp-settings");
  await section.getByRole("button", { name: /^house/ }).click();
  const drawer = page.getByRole("complementary", { name: "house" });
  await expect(drawer.getByLabel("URL")).toHaveValue(url);
  await expect(drawer.getByLabel("Token")).toHaveCount(0);
  await shot("mcp-drawer");
  await drawer.getByRole("button", { name: "Close" }).click();

  await newThread(page, "General");
  await send(page, "Hello");
  await expect(page.getByText("You said: Hello")).toBeVisible();
  const settings = await openSettings(page);
  const servers = settings.getByRole("group", { name: "MCP servers" });
  await servers.getByRole("button", { name: "Add server" }).click();
  const pick = page.getByRole("dialog", { name: "Add server" });
  await expect(pick.getByRole("button", { name: /house/ })).toBeVisible();
  await expect(pick.getByRole("link", { name: "MCP servers ›" })).toBeVisible();
  await noHorizontalScroll(page);
  await shot("mcp-thread");
  await pick.getByRole("button", { name: /house/ }).click();
  await expect(servers.locator(".folder", { hasText: "house" })).toBeVisible();
  await expect(page.locator(".tfacts")).toContainText("house");
  await settings.getByRole("button", { name: "Close" }).click();

  await send(page, "mcp: turn_on");
  const card = page.getByRole("group", { name: "Allow house's turn_on?" });
  await expect(card).toContainText("light.kitchen");
  await noHorizontalScroll(page);
  await shot("mcp-approval");
  await card.getByRole("button", { name: "Allow in this thread" }).click();
  const marker = page.locator(".marker", { hasText: "turn_on" });
  await expect(marker).toContainText("house");
  await expect(marker).toContainText("done");
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

  // Link Lark to Ada from Settings.
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

  // A linked user joins Ada on this browser.
  await logInAs("lark", "pw-lark");
  await expect(page.getByText("Signed out the previous user")).toHaveCount(0);
  expect((await page.evaluate(() => fetch("/api/state").then((r) => r.json())) as { users: unknown[] }).users).toHaveLength(2);

  // Anyone else replaces them both, without naming them.
  await logInAs("sam", "pw-sam");
  await expect(page.getByRole("status").filter({ hasText: "Signed out the previous user on this browser." })).toBeVisible();
  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json())) as { users: { login: string }[] };
  expect(state.users.map((x) => x.login)).toEqual(["sam"]);
});

test("Fallback is on by default and turns off per thread, with Use default to follow the default again", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  const drawer = await openSettings(page);
  const fallback = drawer.getByLabel("Fallback", { exact: true });
  await expect(fallback).toBeChecked();
  await fallback.click();
  await expect(fallback).not.toBeChecked();
  const back = drawer.getByRole("button", { name: "Use default" });
  if (process.env.SCREENSHOTS) {
    await fallback.scrollIntoViewIfNeeded();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/fallback-off-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
  await back.first().click();
  await expect(fallback).toBeChecked();
});

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

test("the header names the version and build, and the home box starts a thread", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Version \S+ · \S+$/ })).toBeVisible();
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
  await card.getByRole("button", { name: "Start" }).first().click();
  await expect(page.locator(".tcard")).toHaveCount(1);
  await expect(page.locator(".tcard").first()).toContainText("Alpha");
  await card.getByRole("button", { name: "Start all" }).click();
  await expect(page.locator(".tcard")).toHaveCount(2);
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
  await alphaView.getByRole("button", { name: "Reopen" }).click();
  await expect(alphaView.getByLabel("Message", { exact: true })).toBeVisible();

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
  // Folders and Machines are the drawer's own two controls, under This chat.
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
  // Earlier tests may fill the list: scroll to its end so the strip under the last row is in view.
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const box = (await list.boundingBox())!;
  await list.click({ button: "right", position: { x: 40, y: box.height - 6 } });
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

test("tapping New project on a phone replaces the menu in place with its choices", async ({ page, baseURL }) => {
  test.skip(!phone(page), "devices that can hover get the flyout instead");
  await enter(page, baseURL!);
  await page.getByRole("button", { name: "Show threads" }).click();
  const list = page.locator(".threads");
  // Earlier tests may fill the list: scroll to its end so the strip under the last row is in view.
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const box = (await list.boundingBox())!;
  await list.click({ button: "right", position: { x: box.width / 2, y: box.height - 6 } });
  await page.getByRole("menu", { name: "Thread list menu" }).getByRole("menuitem", { name: "New project" }).click();
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
  await expect(row("uploads")).toContainText("Folder");
  // New folder names its row in place.
  await section.getByRole("button", { name: "New folder" }).click();
  await section.getByLabel("Folder name").fill("notes");
  await section.getByLabel("Folder name").press("Enter");
  await expect(row("notes")).toBeVisible();
  // Open goes into a folder; the crumbs come back out.
  await row("uploads").getByRole("button", { name: "Open" }).click();
  await expect(section.getByRole("navigation", { name: "Folder" })).toHaveText("Project folder/uploads");
  await expect(row("plan.md")).toContainText("B");
  await expect(row("plan.md").getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/files\/%2Fworkspace%2Fuploads%2Fplan\.md$/);
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
  await expect(drawer.getByLabel("Folder").locator("option")).toHaveText(["Project folder", "notes"]);
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
  await expect(page.locator("dialog.lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await noHorizontalScroll(page);
});

test("the split view: a thread from its card opens in the panel, links inside it grow the breadcrumb, Open as a page and Close panel; Open beside, View thread and the Threads list open beside at 1180 px up, and below it they navigate", async ({ page, baseURL }) => {
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
  await expect(divider).toHaveAttribute("aria-valuenow", "520");
  const dragged = (await settings.boundingBox())!;
  expect(Math.round(dragged.width)).toBe(520);
  await settings.getByRole("link", { name: "Open as a page" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  expect(page.url()).toContain("/p/general/");
  await page.goBack();
  await expect(settings).toBeVisible();
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
  await expect(panel.locator(".fview pre")).toContainText("Water the trays.");
  // The panel is narrow, so the file took the tree's place.
  await panel.locator(".fback").click();
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
    if (phone(page)) { await panel.getByRole("button", { name, exact: true }).click(); await panel.getByRole("button", { name: "File actions" }).click(); }
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
  await expect(page.locator(".fview .fname")).toHaveText("uploads/plan.md");
  await expect(page.locator(".fview pre")).toContainText("# The plan");
  if (phone(page)) { await page.goBack(); await page.getByRole("heading", { level: 1, name: "hello files" }).waitFor(); }
  else await page.locator(".fview .fback").click(); // the panel column is narrow, so the file took the tree's place
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
  await time.fill(await time.inputValue() === "04:30" ? "05:15" : "04:30");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Sleep time")).toHaveValue(/^(04:30|05:15)$/);
});

test("no horizontal scrolling and big enough tap targets on a phone", async ({ page, baseURL }) => {
  test.skip(!phone(page), "phone only");
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await noHorizontalScroll(page);
  for (const button of [
    page.getByRole("button", { name: "Show threads" }), page.getByRole("button", { name: "Thread settings" }), page.getByRole("button", { name: "Thread actions" }),
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

test("Models: the sidebar link opens Overview, Hosts and endpoints lists the endpoints and Edit renames one, Recent calls names the chat call, Clean up is empty, and Settings → Endpoints lands on the hosts tab", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/models-${name}-${page.viewportSize()!.width}.png`, fullPage: true }); };
  // A chat call for Recent calls.
  await newThread(page, "General");
  await send(page, "Which model answers");
  await expect(page.getByText("You said: Which model answers")).toBeVisible();
  const calls = await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/models/calls`) as { task: string; label: string; endpointName: string }[];
  const chat = calls.find((c) => c.task === "chat")!;
  expect(chat).toBeTruthy();
  const answered = `${chat.label.replace(/^(?:shared\.)?[^/]+\//, "")} · ${chat.endpointName}`;

  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await page.locator('a[data-nav="models"]').click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models$`));
  await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
  await expect(page.locator(".head .cap")).toHaveText("2 local and 2 cloud endpoints · 2 text models");
  // An earlier test may have taken the fake speech server down, and the daemon remembers a down endpoint for 30 s.
  await expect(page.locator('[data-tile="endpoints"]')).toContainText(/[34]\s*of 4 up/);
  await expect(page.locator('[data-tile="backend"]')).toContainText("cloud-model");
  await expect(page.locator('[data-tile="backend"]')).toContainText("local-model");
  await expect(page.locator('[data-tile="cleanup"]')).toHaveAttribute("title", "Nothing to clean up");
  const summary = page.getByRole("region", { name: "Hosts and endpoints" });
  for (const name of ["gpu", "router", "speech", "openai"]) await expect(summary.locator("li.hostrow").filter({ hasText: new RegExp(`^${name}`) })).toBeVisible();
  const recent = page.getByRole("region", { name: "History", exact: true });
  await expect(recent.locator("tbody tr")).toHaveCount(1);
  await noHorizontalScroll(page);
  await shot("overview");

  // Recent calls: the chat call, its thread a link.
  await recent.getByRole("link", { name: "Show all" }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/calls$`));
  await expect(page.getByRole("heading", { level: 1, name: "Call history" })).toBeVisible();
  const row = page.locator("tr[data-task=chat]").first();
  await expect(row).toContainText(answered);
  await expect(row.getByRole("link")).toBeVisible();
  await noHorizontalScroll(page);
  await shot("calls");

  // Hosts and endpoints: each endpoint is up; Edit renames one, and back.
  await page.getByRole("navigation", { name: "Models pages" }).getByRole("link", { name: "Hosts and endpoints" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Hosts and endpoints" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add model host" })).toBeInViewport();
  for (const name of ["gpu", "router"]) await expect(page.locator("li.ep-row").filter({ hasText: new RegExp(`^${name}`) })).toContainText("Up");
  for (const name of ["speech", "openai"]) await expect(page.locator("li.ep-row").filter({ hasText: new RegExp(`^${name}`) })).toContainText(/Up|Unreachable/);
  await noHorizontalScroll(page);
  await shot("hosts");
  const rename = async (from: string, to: string) => {
    await page.locator("li.ep-row").filter({ hasText: new RegExp(`^${from} `) }).getByRole("button", { name: "Edit" }).click();
    const drawer = page.getByRole("complementary", { name: `Edit ${from}` });
    await drawer.getByLabel("Name", { exact: true }).fill(to);
    await drawer.getByRole("button", { name: "Save" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator("li.ep-row .name").filter({ hasText: new RegExp(`^${to} local$`) })).toBeVisible();
  };
  await rename("gpu", "gpu-box");
  await rename("gpu-box", "gpu");

  // Add endpoint: the plain-HTTP warning for a local endpoint off this machine.
  await page.getByRole("button", { name: "Add endpoint" }).click();
  const add = page.getByRole("complementary", { name: "Add endpoint" });
  const local = add.getByRole("checkbox", { name: "Local" });
  const cloud = add.getByRole("checkbox", { name: "Cloud" });
  await expect(local).not.toBeChecked();
  await expect(cloud).not.toBeChecked();
  await add.getByLabel("Name").fill("lan-box");
  await add.getByLabel("Base URL").fill("http://192.168.1.50:1234/v1");
  await expect(add.getByRole("button", { name: "Save" })).toBeDisabled();
  await local.check();
  await expect(add.getByRole("note")).toContainText("Plain HTTP");
  await expect(add.getByRole("button", { name: "Save" })).toBeEnabled();
  await cloud.check();
  await expect(local).not.toBeChecked();
  await expect(add.getByRole("note")).toHaveCount(0);
  await local.check();
  await expect(cloud).not.toBeChecked();
  await shot("add-endpoint");
  await add.getByLabel("Base URL").fill("http://127.0.0.1:1234/v1");
  await expect(add.getByRole("note")).toHaveCount(0);
  if (phone(page)) await noHorizontalScroll(page);
  await add.getByRole("button", { name: "Close" }).click();

  // Clean up: nothing to do.
  await page.getByRole("navigation", { name: "Models pages" }).getByRole("link", { name: /^Clean up/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Clean up" })).toBeVisible();
  await expect(page.getByText("Nothing to clean up.")).toBeVisible();
  await noHorizontalScroll(page);
  await shot("cleanup");

  // The old Settings → Endpoints address lands on the hosts tab.
  await page.goto(`/#/u/${userId}/settings/endpoints`);
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/hosts$`));
  await expect(page.getByRole("heading", { level: 1, name: "Hosts and endpoints" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);
});

test("the sidebar's status panel shows the endpoints on any page, and a very long endpoint name is truncated without overflow", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  // The endpoints are seeded through the API after the app first loads; reload once so the shell's fetch sees them.
  await page.reload();
  // The shell polls the endpoints' status, so the panel shows on home too, not only in Models.
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const line = page.locator(".side .status-line");
  await expect(line).toBeVisible();
  // The two local endpoints share the top row; each cloud one has its own line, with when it was last checked in mono.
  for (const name of ["gpu", "speech"]) await expect(line.locator(".status-row .status-item").filter({ hasText: name })).toBeVisible();
  for (const name of ["router", "openai"]) {
    const item = line.locator(".status-item").filter({ hasText: name });
    await expect(item).toBeVisible();
    await expect(item.locator(".num")).toHaveText(/^\d+$/);
  }
  await noHorizontalScroll(page);

  // A very long name ellipsizes in place, with the whole of it in the tooltip, and never pushes the sidebar wide.
  const eps = await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/endpoints`) as { id: string; name: string }[];
  const gpuId = eps.find((e) => e.name === "gpu")!.id;
  const routerId = eps.find((e) => e.name === "router")!.id;
  const LONG = "gpu-with-a-name-long-enough-to-ellipsize"; // the longest a name may be (40 chars), and too wide for half the panel's top row
  const rename = (id: string, name: string) => page.evaluate(async ([path, name]) => {
    const r = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  }, [`/api/u/${userId}/endpoints/${id}`, name] as const);
  await rename(gpuId, LONG);
  await page.reload();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const renamed = line.locator(".status-item").filter({ hasText: LONG });
  await expect(renamed).toBeVisible();
  await expect(renamed).toHaveAttribute("title", LONG);
  const nameBox = renamed.locator(".status-name");
  await expect(nameBox).toBeVisible();
  expect(await nameBox.evaluate((el) => el.scrollWidth > el.clientWidth), `the long name should ellipsize at ${page.viewportSize()!.width} px`).toBe(true);
  await noHorizontalScroll(page);

  // A cloud row with a very long name: the name ellipsizes first and "checked N s ago" stays visible; the tooltip holds the whole line.
  const LONG_CLOUD = "router-with-a-name-long-enough-to-trim"; // within the 40-char name limit, and too wide for a cloud line beside its checked time
  await rename(routerId, LONG_CLOUD);
  await page.reload();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const cloudItem = line.locator(".status-item").filter({ hasText: LONG_CLOUD });
  await expect(cloudItem).toBeVisible();
  await noHorizontalScroll(page); // settle the drawer before measuring or shooting
  expect(await cloudItem.locator(".status-name").evaluate((el) => el.scrollWidth > el.clientWidth), `the long cloud name should ellipsize at ${page.viewportSize()!.width} px`).toBe(true);
  const checked = cloudItem.locator(".status-state", { hasText: "checked" });
  await expect(checked).toHaveText(/· checked \d+ (s|min) ago/);
  await expect(checked).toBeInViewport();
  // Nothing of it is clipped away: the checked time ends inside the item's own box.
  const [itemBox, checkedBox] = [await cloudItem.boundingBox(), await checked.boundingBox()];
  expect(checkedBox!.x + checkedBox!.width).toBeLessThanOrEqual(itemBox!.x + itemBox!.width + 1);
  await expect(cloudItem).toHaveAttribute("title", new RegExp(`^${LONG_CLOUD} · checked \\d+ (s|min) ago$`));
  if (page.viewportSize()?.width === 390) await page.screenshot({ path: "shots/status-390.png" });

  // Back as they were, for the tests that follow.
  await rename(gpuId, "gpu");
  await rename(routerId, "router");
});

test("Tasks: the table shows each column's models; a cell's drawer adds, reorders and removes, and Same as points a task at another; the Preset menu switches, saves and edits a preset; Settings → Model profiles lands here", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/tasks-${name}-${page.viewportSize()!.width}.png`, fullPage: true }); };
  // A second cloud chat model, added by hand on router, for a fallback.
  const api = (method: string, path: string, data?: unknown) => page.evaluate(async ([method, path, data]) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json() as unknown;
  }, [method, `/api/u/${userId}${path}`, data] as const);
  const endpoints = await api("GET", "/endpoints") as { id: string; name: string; models: { modelId: string }[] }[];
  const router = endpoints.find((e) => e.name === "router")!;
  if (!router.models.some((m) => m.modelId === "cloud-mini")) await api("POST", `/endpoints/${router.id}/models`, { modelId: "cloud-mini" });

  // The Backend tile leads to Tasks.
  await page.goto(`/#/u/${userId}/models`);
  await page.locator('[data-tile="backend"]').click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/tasks$`));
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  const local = page.locator('tr[data-task="chat"] [data-col="Private threads"]'), general = page.locator('tr[data-task="chat"] [data-col="General threads"]');
  await expect(local).toContainText("local-model");
  await expect(general).toContainText("cloud-model");
  await expect(general).toContainText("no fallback");
  // Titles follow cheap subagents: the default the first entry brings.
  await expect(page.locator('tr[data-task="title"] [data-col="General threads"]')).toContainText("= Cheap subagents");
  await noHorizontalScroll(page);
  await shot("table");

  // Chat for General threads: Add… offers the column's local and cloud text models, so cloud-mini and local-model, not the speech models.
  await general.click();
  await expect(general).toHaveAttribute("aria-pressed", "true");
  const drawer = page.getByRole("complementary", { name: "Edit Chat" });
  await expect(drawer.getByRole("heading", { level: 2, name: "Chat", exact: true })).toHaveAttribute("title", "General threads column · Custom");
  await drawer.getByRole("button", { name: "Add…" }).click();
  const picker = drawer.getByRole("region", { name: "Add to Chat" });
  await expect(picker.locator(".pick-row")).toHaveCount(2);
  await expect(picker).toContainText("local-model");
  await expect(picker).not.toContainText("whisper");
  await expect(picker).not.toContainText("kokoro");
  await drawer.getByLabel("Search models").fill("mini");
  if (phone(page)) await noHorizontalScroll(page);
  await shot("picker");
  const put = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/columns/general/chat"));
  let saved = put();
  await picker.locator(".pick-row").filter({ hasText: "cloud-mini" }).getByRole("button", { name: "Add" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(general).toContainText("+1 fallback");
  const entries = drawer.locator("li.oentry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0).getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(entries.nth(1).getByRole("button", { name: "Move down" })).toBeDisabled();
  await noHorizontalScroll(page);
  await shot("drawer");
  // ↑ puts cloud-mini first; × takes it out again.
  saved = put();
  await entries.nth(1).getByRole("button", { name: "Move up" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(entries.nth(0)).toContainText("cloud-mini");
  await expect(general.locator(".m")).toContainText("cloud-mini");
  saved = put();
  await entries.nth(0).getByRole("button", { name: "Remove" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(entries).toHaveCount(1);
  await expect(entries.nth(0).getByRole("button", { name: "Remove" })).toBeDisabled();
  await expect(general).toContainText("cloud-model");
  await expect(general).toContainText("no fallback");
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(general).toHaveAttribute("aria-pressed", "false");

  // Same as points Titles at Cheap subagents, which then can't follow another task itself; Compaction and Watching threads follow it too.
  const titles = page.locator('tr[data-task="title"] [data-col="General threads"]');
  await titles.click();
  const edit = page.getByRole("complementary", { name: "Edit Titles" });
  await expect(edit.getByRole("heading", { level: 2, name: "Titles", exact: true })).toHaveAttribute("title", "General threads column · Custom");
  await edit.getByLabel("Task to share with").selectOption({ label: "Cheap subagents" });
  await expect(titles).toContainText("= Cheap subagents");
  await edit.getByRole("button", { name: "Close" }).click();
  await page.locator('tr[data-task="subagent.cheap"] [data-col="General threads"]').click();
  const cheap = page.getByRole("complementary", { name: "Edit Cheap subagents" });
  await expect(cheap.getByRole("radio", { name: "Same as" })).toBeDisabled();
  await expect(cheap).toContainText("Compaction, Titles and Watching threads use this list.");
  await expect(cheap.getByRole("radio", { name: "Same as" })).toHaveAccessibleDescription("Compaction, Titles and Watching threads use this list.");
  await cheap.getByRole("button", { name: "Close" }).click();

  // The Preset menu: the built-ins, switching a column, editing a followed column into Custom, Save to, New preset and its edit and delete.
  const generalHead = page.locator(".ttable thead th").nth(2);
  const generalPreset = generalHead.locator("button.preset-button");
  const menu = () => page.getByRole("dialog", { name: "Preset" });
  const item = (name: string) => menu().getByRole("button", { name, exact: true });
  await expect(generalPreset).toContainText("Custom");
  await generalPreset.click();
  await expect(item("Cloud")).toBeVisible();
  await expect(item("Local")).toBeVisible();
  await expect(item("Save as preset…")).toBeVisible();
  await expect(item("New preset…")).toBeVisible();
  await item("Cloud").click();
  await expect(generalPreset).toContainText("Cloud");
  await expect(general).toContainText("No model");
  // Editing a followed column makes it Custom, and the menu offers to save it back to the preset it came from.
  await general.click();
  const edit2 = page.getByRole("complementary", { name: "Edit Chat" });
  await expect(edit2.getByRole("heading", { level: 2, name: "Chat", exact: true })).toHaveAttribute("title", "General threads column · Cloud");
  await edit2.getByRole("button", { name: "Add…" }).click();
  const picker2 = edit2.getByRole("region", { name: "Add to Chat" });
  await picker2.getByLabel("Search models").fill("cloud-model");
  await picker2.locator(".pick-row").filter({ hasText: "cloud-model" }).getByRole("button", { name: "Add" }).click();
  await edit2.getByRole("button", { name: "Close" }).click();
  await expect(generalPreset).toContainText("Custom");
  await expect(general).toContainText("cloud-model");
  await generalPreset.click();
  await expect(item("Save to Cloud")).toBeVisible();
  await item("Save to Cloud").click();
  await expect(generalPreset).toContainText("Cloud");
  await expect(general).toContainText("cloud-model");

  // New preset makes one from the column's table; its edit renames and Delete removes it, leaving the column on Cloud.
  await generalPreset.click();
  await item("New preset…").click();
  const newPreset = page.getByRole("complementary", { name: "New preset" });
  await newPreset.getByLabel("Name", { exact: true }).fill("Work");
  await newPreset.getByRole("button", { name: "Save" }).click();
  await expect(newPreset).toHaveCount(0);
  await generalPreset.click();
  await expect(item("Work")).toBeVisible();
  await item("Edit Work").click();
  const editPreset = page.getByRole("complementary", { name: "Work" });
  await editPreset.getByLabel("Name", { exact: true }).fill("Deep work");
  await editPreset.getByRole("button", { name: "Save" }).click();
  await expect(editPreset).toHaveCount(0);
  await generalPreset.click();
  await item("Edit Deep work").click();
  const editPreset2 = page.getByRole("complementary", { name: "Deep work" });
  await editPreset2.getByRole("button", { name: "Delete preset…" }).click();
  await page.getByRole("dialog", { name: "Delete Deep work?" }).getByRole("button", { name: "Delete" }).click();
  await expect(editPreset2).toHaveCount(0);

  // The old Settings → Model profiles address lands here; Settings has Sleep in its place.
  await page.goto(`/#/u/${userId}/settings/profiles`);
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/tasks$`));
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await page.goto(`/#/u/${userId}/settings/sleep`);
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Sleep" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("checkbox", { name: "Sleep fallback" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Model profiles" })).toHaveCount(0);
});

test("New preset summary: +N fallbacks and a red gone model", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  // General chat follows a gone offering first, with two fallbacks after it, so the New preset summary shows both.
  await page.route(/\/api\/u\/[^/]+\/models\/page$/, async (route) => {
    type M = { id: string; modelId: string; status?: string };
    const real = await (await route.fetch()).json() as {
      endpoints: { kind: string; models: M[] }[];
      presets: { columns: { general: { preset: unknown; entries: Record<string, unknown> } } };
    };
    const cloud = real.endpoints.find((e) => e.kind === "cloud" && e.models.some((m) => m.modelId === "cloud-model"))!;
    const live = cloud.models.find((m) => m.modelId === "cloud-model")!;
    cloud.models.push({ ...live, id: "off-gone", modelId: "gone-model", status: "gone" });
    real.presets.columns.general.preset = null;
    real.presets.columns.general.entries.chat = [{ offeringId: "off-gone" }, { offeringId: live.id }, { offeringId: live.id }];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(real) });
  });
  // The shell fetches …/models/page when the app first loads, before this mock existed; reload once so its answer comes through it.
  await page.reload();
  await page.goto(`/#/u/${userId}/models/tasks`);
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await page.locator(".ttable thead th").nth(2).locator("button.preset-button").click();
  await page.getByRole("button", { name: "New preset…" }).click();
  const summary = page.getByRole("complementary", { name: "New preset" }).locator("ul.preset-summary");
  await expect(summary).toContainText("gone-model");
  await expect(summary).toContainText("+2 fallbacks");
  await expect(summary.locator(".pill.bad").first()).toHaveText("gone");
});

test("Text models: a row per model with starred first; a row opens to its copies, and a copy's Settings saves Temperature as yours", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/text-models-${name}-${page.viewportSize()!.width}.png`, fullPage: true }); };
  const inView = () => page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".page-body")!;
    const past = [...document.querySelectorAll<HTMLElement>(".ldetail *, .drawer *")].filter((el) => el.offsetParent && el.getBoundingClientRect().right > innerWidth + 1);
    return { wide: body.scrollWidth > body.clientWidth + 1, past: past.map((el) => `${el.tagName}.${el.className}`) };
  });
  await page.goto(`/#/u/${userId}/models/text`);
  await expect(page.getByRole("heading", { level: 1, name: "Text models" })).toBeVisible();
  const facts = page.locator(".head .cap");
  await expect(facts).toHaveText(/^\d+ models · \d+ copies on 4 endpoints · \d+ groups? · 0 starred$/);
  const rows = page.locator("li.lrow");
  const row = (name: string) => rows.filter({ has: page.getByRole("button", { name: new RegExp(`^(Un)?[Ss]tar ${name}$`) }) });
  const local = row("local-model");
  await expect(local.locator(".meta")).toHaveText("local · 1 copy · gpu");
  await noHorizontalScroll(page);
  expect(await inView()).toEqual({ wide: false, past: [] });

  // A star puts the model first; Starred shows only it.
  await local.getByRole("button", { name: "Star local-model" }).click();
  await expect(facts).toContainText("· 1 starred");
  await expect(rows.first().getByRole("button", { name: "Unstar local-model" })).toHaveAttribute("aria-pressed", "true");
  if (phone(page)) {
    for (const target of [rows.first().getByRole("button", { name: "Unstar local-model" }), rows.first().locator(".lrow-main"), page.getByRole("button", { name: "Starred", exact: true })]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.getByRole("button", { name: "Starred", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Starred", exact: true }).click();
  await page.getByLabel("Search models").fill("no such model");
  await expect(page.getByText("No models match.")).toBeVisible();
  await page.getByLabel("Search models").fill("");
  await shot("list");

  // The row opens in place to its copy, with Settings in the copy's line.
  await local.locator(".lrow-main").click();
  await expect(local.locator(".lrow-main")).toHaveAttribute("aria-expanded", "true");
  const detail = local.locator(".ldetail");
  await expect(detail.locator("tr[data-offering]")).toHaveCount(1);
  await expect(detail.locator(".model-name")).toHaveText("local-model");
  await expect(detail.locator(".model-endpoint")).toHaveText(" · gpu");
  await expect(detail.locator(".copy-name")).toContainText("local");
  await noHorizontalScroll(page);
  expect(await inView()).toEqual({ wide: false, past: [] });
  await shot("detail");

  // Settings: Sampling only on a plain endpoint, with its Context window; Temperature saved is yours.
  const settings = detail.getByRole("button", { name: "Settings for local-model on gpu" });
  await settings.click();
  const drawer = page.getByRole("complementary", { name: "Settings for local-model" });
  await expect(drawer.getByRole("group", { name: "Settings" })).toHaveCount(0);
  await expect(drawer.getByLabel("Context window")).toBeVisible();
  const temperature = drawer.getByLabel("Temperature", { exact: true });
  await temperature.fill("0.4");
  const put = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/settings"));
  let saved = put();
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Saved.");
  await settings.click();
  await expect(temperature).toHaveValue("0.4");
  await expect(drawer.locator(".srow").filter({ has: page.getByLabel("Temperature", { exact: true }) })).toContainText("yours");
  await noHorizontalScroll(page);
  expect(await inView()).toEqual({ wide: false, past: [] });
  await shot("settings");
  // Reset takes it back to the endpoint's defaults.
  await drawer.getByRole("button", { name: "Reset" }).click();
  await expect(temperature).toHaveValue("");
  saved = put();
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(drawer).toHaveCount(0);

  // A speaking model's Settings is its voice drawer.
  const kokoro = row("kokoro");
  await kokoro.locator(".lrow-main").click();
  await kokoro.locator(".ldetail").getByRole("button", { name: "Settings for kokoro on speech" }).click();
  const voice = page.getByRole("complementary", { name: "kokoro settings" });
  await expect(voice).toBeVisible();
  await voice.getByRole("button", { name: "Close" }).click();
  await expect(voice).toHaveCount(0);

  await local.getByRole("button", { name: "Unstar local-model" }).click();
  await expect(facts).toContainText("· 0 starred");
});

/**
 * The e2e has no model host: a made-up one, "box", joins the Models page's answer, and its host-backed calls are
 * answered here. Returns what was posted to start a download.
 */
async function fakeHost(page: Page, downloads: Record<string, unknown>[], models: Record<string, unknown>[] = []) {
  const GB = 2 ** 30;
  const started: unknown[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/\/api\/u\/[^/]+\/models\/page$/, async (route) => {
    const real = await (await route.fetch()).json() as { endpoints: Record<string, unknown>[]; hosts: unknown[] };
    const local = real.endpoints.find((e) => e.kind === "local")!;
    real.endpoints.push({ ...local, id: "ep-box", name: "box", api: "host", addresses: ["box.lan:7236"], fingerprint: "SHA256:aaaa", state: "up", shared: false, models });
    real.hosts.push({ endpointId: "ep-box", status: {
      name: "box", version: "0.9.0", fingerprint: "SHA256:aaaa", state: "running", gpus: [], downloads: { active: downloads.filter((d) => d.state === "downloading").length },
      modelsFolder: { path: "/srv/models", free: 96 * GB },
    } });
    await route.fulfill(json(real));
  });
  await page.route(/\/api\/u\/[^/]+\/hosts\/ep-box\/downloads(\/[^/?]+)?(\?[^/]*)?$/, async (route) => {
    const method = route.request().method();
    const id = /downloads\/([^/]+)$/.exec(route.request().url())?.[1];
    if (method === "GET") {
      const finished = downloads.filter((d) => !["queued", "downloading", "verifying"].includes(String(d.state)));
      return route.fulfill(json({ downloads: new URL(route.request().url()).searchParams.has("preview") ? [...downloads.filter((d) => !finished.includes(d)), ...finished.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 1)] : downloads, finishedTotal: finished.length }));
    }
    if (method === "POST") { started.push(route.request().postDataJSON()); return route.fulfill(json({ downloads: [] })); }
    // DELETE cancels a running one, or clears a finished one from the list.
    const at = downloads.findIndex((d) => d.id === id);
    if (downloads[at]!.state === "downloading") downloads[at] = { ...downloads[at], state: "cancelled" };
    else downloads.splice(at, 1);
    return route.fulfill(json({}));
  });
  await page.route(/\/api\/u\/[^/]+\/models\/downloads\/history\?/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const q = (query.get("q") ?? "").toLowerCase();
    const entries = downloads.filter((d) => !["queued", "downloading", "verifying"].includes(String(d.state)))
      .filter((d) => Object.values(d).join(" ").toLowerCase().includes(q)).map((download) => ({ endpointId: "ep-box", download }));
    const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit") ?? 20);
    return route.fulfill(json({ total: entries.length, entries: entries.slice(offset, offset + limit) }));
  });
  await page.route(/\/api\/u\/[^/]+\/hosts\/ep-box\/hub\/files\?/, (route) => {
    const repo = new URL(route.request().url()).searchParams.get("repo");
    return route.fulfill(json({
      source: "huggingface", repo, revision: "abc", gated: false, card: null, free: 96 * GB,
      files: [
        { path: "m-Q4_K_M.gguf", size: 4.7 * GB, sha256: null, allowed: true, reason: null, present: false, fits: true },
        { path: "m-Q8_0.gguf", size: 8.5 * GB, sha256: null, allowed: true, reason: null, present: true, fits: true },
        // A GGUF repository's vision projector.
        ...(repo?.endsWith("-GGUF") ? [{ path: "mmproj-F16.gguf", size: 0.9 * GB, sha256: null, allowed: true, reason: null, present: false, fits: true }] : []),
      ],
    }));
  });
  return started;
}

test("Downloads History: the queue shows progress with Cancel and how each ended, Accounts keeps a token showing only its last four, and Download text model starts one", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const GB = 2 ** 30;
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/downloads-${name}-${page.viewportSize()!.width}.png`, fullPage: true }); };
  const started = await fakeHost(page, [
    { id: "d1", source: "huggingface", repo: "a/m-GGUF", url: null, path: "lyrica/huggingface/a/m-GGUF/m-Q4_K_M.gguf", size: 4.7 * GB, received: 1.2 * GB,
      state: "downloading", verified: null, error: null, startedAt: new Date().toISOString() },
    { id: "d2", source: "url", repo: null, url: null, path: "lyrica/url/example.org/vae.safetensors", size: 0.3 * GB, received: 0.3 * GB,
      state: "done", verified: false, error: null, startedAt: "2026-10-01T10:00:00Z" },
  ]);
  await page.goto(`/#/u/${userId}/models/downloads`);
  await expect(page.getByRole("heading", { level: 1, name: "Downloads" })).toBeVisible();
  await expect(page.locator(".head .cap")).toHaveText("1 running · 1 finished");
  await expect(page.getByRole("navigation", { name: "Models pages" }).getByRole("link", { name: /^Downloads/ }).locator(".count")).toHaveText("1");

  // In progress: the file, where from and to, a progress bar and Cancel.
  const running = page.locator("li.dl[data-download=d1]");
  await expect(running).toContainText("m-Q4_K_M.gguf");
  await expect(running).toContainText("from Hugging Face to box");
  const bar = running.getByRole("progressbar", { name: "m-Q4_K_M.gguf" });
  await expect(bar).toHaveAttribute("aria-valuenow", "25");
  await expect(bar).toHaveAttribute("aria-valuemax", "100");
  await expect(running).toContainText("Downloading · 1.2 GB of 4.7 GB");
  // Finished: unverified, with why, then its size and Ready.
  const done = page.locator("li.dl[data-download=d2]");
  await expect(done).toContainText("from example.org to box");
  await expect(done.locator(".dl-end")).toHaveText("Unverified no checksum given · 0.3 GB · Ready");
  await expect(page.locator("[aria-live=polite]").first()).toBeAttached();
  await noHorizontalScroll(page);
  if (phone(page)) for (const b of [running.getByRole("button", { name: "Cancel m-Q4_K_M.gguf" }), page.getByRole("button", { name: "Add a Hugging Face token" })]) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await shot("queue");

  // Cancel: the host keeps nothing, and the queue says so.
  await running.getByRole("button", { name: "Cancel m-Q4_K_M.gguf" }).click();
  await expect(running).toContainText("Cancelled Nothing was kept.");
  await expect(page.locator(".head .cap")).toHaveText("Nothing running · 2 finished");
  await expect(page.locator("li.dl")).toHaveCount(1);
  await page.getByRole("link", { name: "Show all", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Download history" })).toBeVisible();
  await expect(page.locator("li.dl")).toHaveCount(2);
  await page.getByLabel("Search", { exact: true }).fill("vae.safetensors");
  await expect(page.locator("li.dl")).toHaveCount(1);
  await expect(page.locator("li.dl")).toContainText("vae.safetensors");
  await page.locator(".head").getByRole("link", { name: "Downloads", exact: true }).click();
  await page.getByRole("button", { name: "Clear finished" }).click();
  await expect(page.getByText("No downloads yet. Start one from a library's Download model button, or here.")).toBeVisible();

  // Accounts: a token is a password field, and afterwards only its last four show.
  const hf = page.locator("li.acct[data-hub=huggingface]");
  await expect(hf).toContainText("No token");
  await hf.getByRole("button", { name: "Add a Hugging Face token" }).click();
  const field = hf.getByLabel("Access token");
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("hf_madeUpToken1234abcd");
  await expect(hf.getByRole("group", { name: "Who can use it" })).toBeVisible();
  await shot("accounts");
  await hf.getByRole("button", { name: "Save" }).click();
  await expect(hf).toContainText("Token saved · ••••abcd · only you");
  await expect(page.getByText("hf_madeUpToken1234abcd")).toHaveCount(0);
  expect(await page.content()).not.toContain("madeUpToken");
  if (phone(page)) expect((await hf.getByRole("button", { name: "Remove the Hugging Face token" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await hf.getByRole("button", { name: "Remove the Hugging Face token" }).click();
  await expect(hf).toContainText("No token");

  // Download model on Text models leads to Download text model, and Cancel back to it.
  await page.goto(`/#/u/${userId}/models/text`);
  await page.getByRole("button", { name: "Download model" }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/downloads/text$`));
  await expect(page.getByRole("heading", { level: 1, name: "Download text model" })).toBeVisible();
  await expect(page.getByLabel("Download to")).toHaveValue("ep-box");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/text$`));
  await page.getByRole("button", { name: "Download model" }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Look up the repository first." })).toHaveText("Look up the repository first.");
  await page.getByLabel("Repository").fill("not a repository");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That isn't a repository. Use owner/name, or paste the page's link." })).toHaveText("That isn't a repository. Use owner/name, or paste the page's link.");
  await page.getByLabel("Repository").fill("https://huggingface.co/a/m-GGUF/tree/main");
  await page.getByRole("button", { name: "Look up" }).click();
  const files = page.getByRole("group", { name: "Files to download" });
  await expect(files.getByRole("checkbox")).toHaveCount(3);
  await expect(files.locator(".choice").nth(2)).toContainText("Vision");
  await expect(files.locator(".choice").nth(1)).toContainText("already on this host");
  await expect(files.getByRole("checkbox").nth(1)).toBeDisabled();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose a file." })).toHaveText("Choose a file.");
  // Ticking a model ticks its vision projector; unticking the last model unticks it again.
  await files.getByRole("checkbox").first().check();
  await expect(files.getByRole("checkbox").nth(2)).toBeChecked();
  await files.getByRole("checkbox").first().uncheck();
  await expect(files.getByRole("checkbox").nth(2)).not.toBeChecked();
  await files.getByRole("checkbox").first().check();
  await noHorizontalScroll(page);
  await shot("text");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/downloads$`));
  expect(started).toEqual([{ source: "huggingface", repo: "a/m-GGUF", files: ["m-Q4_K_M.gguf", "mmproj-F16.gguf"] }]);
  // A link must be https and name one model file.
  await page.goto(`/#/u/${userId}/models/downloads/text`);
  await page.getByRole("group", { name: "Source" }).getByRole("button", { name: "Link" }).click();
  await page.getByLabel("Link to the file").fill("http://example.org/m.bin");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Use an https link to one .gguf or .safetensors file." })).toHaveText("Use an https link to one .gguf or .safetensors file.");
});

/** The made-up host's image library: one recipe, one proposal missing its VAE, and the parts; what the page asks of it is kept. */
async function fakeImages(page: Page) {
  const GB = 2 ** 30;
  const asked: { path: string; body: unknown }[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const Z = "lyrica/huggingface/Comfy-Org/z_image_turbo/split_files";
  const zi = "00000000-0000-4000-8000-000000000001", qi = "00000000-0000-4000-8000-000000000002";
  const part = (file: string, role: string, arch: string, size: number, more: Record<string, unknown> = {}) =>
    ({ file, size: size * GB, format: "safetensors", role, slot: null, arch, precision: "bf16", downloaded: file.startsWith("lyrica/"), usedBy: [], vram: null, ...more });
  const parts = [
    part(`${Z}/diffusion_models/z_image_turbo_bf16.safetensors`, "diffusion", "z-image", 12.3, { usedBy: [zi] }),
    part(`${Z}/text_encoders/qwen_3_4b.safetensors`, "text_encoder", "z-image", 8, { slot: "qwen3", usedBy: [zi] }),
    part(`${Z}/vae/ae.safetensors`, "vae", "z-image", 0.3, { usedBy: [zi] }),
    part("comfy/vae/ae_fp32.safetensors", "vae", "z-image", 0.3, { precision: "fp32" }),
    part("comfy/loras/pixel-art.safetensors", "lora", "z-image", 0.2),
    part("comfy/diffusion_models/qwen_image_fp8.safetensors", "diffusion", "qwen-image", 20.4, { precision: "fp8", usedBy: [qi] }),
  ];
  const recipes = [
    { id: zi, name: "Z-Image Turbo", useFor: "both", state: "confirmed", ready: true, arch: "z-image", template: "z-image", does: ["create"], loras: [], base: null, starter: null,
      parts: [{ role: "diffusion", slot: null, file: parts[0]!.file, added: false }, { role: "text_encoder", slot: "qwen3", file: parts[1]!.file, added: false }, { role: "vae", slot: null, file: parts[2]!.file, added: false }],
      defaults: { steps: 8, cfg: 1, width: 1024, height: 1024 } },
    { id: qi, name: "Qwen-Image", state: "proposed", ready: false, arch: "qwen-image", template: "qwen-image", does: ["create"], loras: [], base: null, starter: null, defaults: { steps: 30, cfg: 4 },
      parts: [{ role: "diffusion", slot: null, file: parts[5]!.file, added: false },
        { role: "vae", slot: null, file: null, added: false, missing: { source: "huggingface", repo: "Comfy-Org/Qwen-Image_ComfyUI", path: "split_files/vae/qwen_image_vae.safetensors", size: 0.25 * GB } }] },
  ];
  await page.route(/\/api\/u\/[^/]+\/hosts\/ep-box\/images$/, (route) => {
    const byRole: Record<string, unknown[]> = {};
    for (const p of parts) (byRole[p.role as string] ??= []).push(p);
    return route.fulfill(json({ recipes, parts: byRole }));
  });
  await page.route(/\/api\/u\/[^/]+\/hosts\/ep-box\/(recipes\/[^/]+|manage)$/, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/ep-box\//, "");
    const body = route.request().postDataJSON() as { do?: string; name?: string; change?: { op?: string; useFor?: string } };
    asked.push({ path, body });
    if (body.do === "change" && body.change?.op === "useFor") recipes.find((r) => path === `recipes/${r.id}`)!.useFor = body.change.useFor;
    return route.fulfill(json(body.do === "copy" ? { ...recipes[0], id: "00000000-0000-4000-8000-000000000003", name: body.name } : body.do === "delete" ? { deleted: [], kept: [] } : { models: 0, parts: 6, proposals: 1 }));
  });
  await page.route(/\/api\/u\/[^/]+\/offerings\/off-z\/delete-copy$/, (route) => route.fulfill(json({ usedIn: [] })));
  return { asked, zi, qi, offering: { id: "off-z", modelId: `recipe/${zi}`, label: `box/recipe/${zi}`, manual: false, status: "listed", recipe: "Z-Image Turbo", image: true } };
}

test("Image models: a recipe opens to its parts with Change, Add a part and Delete; Parts lists the files; To review selects and ignores; Download image model scans and downloads", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const images = await fakeImages(page);
  const started = await fakeHost(page, [], [images.offering]);
  const post = (path: string) => images.asked.filter((a) => a.path === path).map((a) => a.body);
  await page.goto(`/#/u/${userId}/models/images`);
  await expect(page.getByRole("heading", { level: 1, name: "Image models" })).toBeVisible();
  await expect(page.locator(".head .cap")).toHaveText("1 model (recipe) · 6 parts on 1 host · 0 groups · 1 to review");
  await expect(page.getByRole("navigation", { name: "Models pages" }).getByRole("link", { name: "Image models" })).toHaveAttribute("aria-current", "page");

  // A recipe: its facts, then its copy on the host as a block of parts.
  const list = page.getByRole("list", { name: "Image models" });
  await expect(list.getByRole("button", { name: /Z-Image Turbo/ })).toContainText("Z-Image · create · fast and quality · 1 copy · box");
  await expect(list.getByText("Qwen-Image")).toHaveCount(0);
  await list.getByRole("button", { name: /Z-Image Turbo/ }).click();
  const block = page.getByRole("region", { name: "Z-Image Turbo on box" });
  await expect(block.locator(".copyhead")).toContainText("template z-image · 8 steps · CFG 1 · 1024×1024");
  await expect(block.locator(".partrow").nth(1)).toContainText("Text encoderQwen3");
  await expect(block.locator(".partrow").nth(0)).toContainText("BF16 · downloaded by Lyrica");
  await noHorizontalScroll(page);
  if (phone(page)) for (const b of [block.getByRole("button", { name: "Change the VAE" }), block.getByRole("button", { name: "Add a part" })]) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  // Use for saves at once and the facts line reflects the tag after reload.
  const useFor = block.getByRole("group", { name: "Use for" });
  await expect(useFor.getByRole("button", { name: "Both", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const [label, tag, facts] of [["Fast", "fast", "fast"], ["Quality", "quality", "quality"], ["Both", "both", "fast and quality"]]) {
    await useFor.getByRole("button", { name: label!, exact: true }).click();
    await expect.poll(() => post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "change", change: { op: "useFor", useFor: tag } });
    await expect(useFor.getByRole("button", { name: label!, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(list.locator(".lrow-main .meta")).toContainText(`create · ${facts} ·`);
  }
  await page.reload();
  await list.getByRole("button", { name: /Z-Image Turbo/ }).click();
  await expect(useFor.getByRole("button", { name: "Both", exact: true })).toHaveAttribute("aria-pressed", "true");
  await noHorizontalScroll(page);
  if (phone(page)) expect((await useFor.getByRole("button", { name: "Fast", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Change: the host's other VAEs for the architecture, or Download another….
  await block.getByRole("button", { name: "Change the VAE" }).click();
  const vae = block.getByLabel("Choose the VAE");
  await expect(vae.locator("option")).toHaveText(["ae.safetensors · BF16", "ae_fp32.safetensors · FP32 · shared folder", "Download another…"]);
  await vae.selectOption("comfy/vae/ae_fp32.safetensors");
  await expect.poll(() => post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "change", change: { op: "swap", role: "vae", slot: null, file: "comfy/vae/ae_fp32.safetensors" } });

  // Add a part: a LoRA goes into a copy named after it, unless the box is unticked.
  await block.getByRole("button", { name: "Add a part" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a part to Z-Image Turbo" });
  await expect(dialog.getByRole("group", { name: "Part" }).getByRole("button")).toHaveText(["LoRA"]);
  await expect(dialog.getByRole("radio", { name: "comfy/loras/pixel-art.safetensors" })).toBeChecked();
  await expect(dialog.getByLabel("Save as a new model, keeping Z-Image Turbo as it is")).toBeChecked();
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => post("recipes/00000000-0000-4000-8000-000000000003")).toEqual([{ do: "change", change: { op: "addLora", file: "comfy/loras/pixel-art.safetensors", strength: 1 } }]);
  expect(post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "copy", name: "Z-Image Turbo + pixel art" });
  // The page opens the new model's row; this made-up host never makes it, so open Z-Image Turbo again.
  await list.getByRole("button", { name: /Z-Image Turbo/ }).click();

  // Delete: what goes and what it frees, and that no list uses it.
  await block.getByRole("button", { name: "Delete" }).click();
  const del = page.getByRole("dialog", { name: "Delete Z-Image Turbo from box?" });
  await expect(del).toContainText("Deletes z_image_turbo_bf16.safetensors, qwen_3_4b.safetensors, ae.safetensors, which frees 20.6 GB.");
  await expect(del).toContainText("Nothing of yours uses it.");
  await del.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "delete" });

  // Parts: a type at a time, each file with what uses it.
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Parts" }).click();
  await expect(page.getByRole("group", { name: "Type" }).getByRole("button", { pressed: true })).toHaveText("Diffusion models 2");
  const parts = page.getByRole("list", { name: "Parts" });
  await expect(parts.locator("li").first()).toContainText("qwen_image_fp8.safetensorsbox · Qwen-Image · FP8 · 20.4 GB · shared folderUsed by Qwen-Image (to confirm)");
  await page.getByRole("group", { name: "Type" }).getByRole("button", { name: /^Unused files/ }).click();
  await expect(parts.locator("li")).toHaveCount(2);
  await expect(parts.locator("li").first()).toContainText("Not used by any recipe");
  await page.getByRole("group", { name: "Type" }).getByRole("button", { name: /^VAEs/ }).click();
  await parts.getByRole("button", { name: "Z-Image Turbo" }).click();
  await expect(list.getByRole("button", { name: /Z-Image Turbo/ })).toHaveAttribute("aria-expanded", "true");

  // To review: Ctrl-click or Select picks a row; the bar acts on the selection; Escape clears it.
  await page.getByRole("link", { name: "1 to review" }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/images/review$`));
  await expect(page.locator(".head .cap")).toHaveText("Image models · 1 found on your hosts");
  const row = page.locator("li.rvrow");
  await expect(row).toContainText("Qwen-Image1 part missing · 0.3 GB");
  await expect(row).toContainText("Qwen-Image · create · qwen_image_fp8.safetensors with qwen_image_vae.safetensors");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  if (phone(page)) expect((await row.getByRole("button", { name: "Actions for Qwen-Image on box" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noHorizontalScroll(page);
  await row.locator(".meta").click({ modifiers: ["Control"] });
  const bar = page.getByRole("toolbar", { name: "Selection" });
  await expect(bar).toContainText("1 selected");
  await expect(bar.getByRole("button", { name: "Use 0 ready" })).toBeDisabled();
  await expect(bar.getByRole("button", { name: "Download parts (0.3 GB)" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await row.getByRole("button", { name: "Actions for Qwen-Image on box" }).click();
  await page.getByRole("menuitem", { name: "Select" }).click();
  await expect(bar).toContainText("1 selected");
  await noHorizontalScroll(page);
  await bar.getByRole("button", { name: "Ignore" }).click();
  await expect.poll(() => post(`recipes/${images.qi}`)).toEqual([{ do: "ignore" }]);
  await expect(bar).toHaveCount(0);

  // Download image model: a scan of the models folder shows what it proposes; Hugging Face downloads the files picked.
  await page.goto(`/#/u/${userId}/models/images`);
  await page.getByRole("button", { name: "Download model" }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/images/download$`));
  await expect(page.getByRole("heading", { level: 1, name: "Download image model" })).toBeVisible();
  await page.getByRole("group", { name: "Source" }).getByRole("button", { name: "Scan folder" }).click();
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByRole("list", { name: "Found" }).locator("li.rvrow")).toContainText("Qwen-Image");
  expect(post("manage")).toEqual([{ method: "POST", path: "/host/v1/scan" }]);
  await page.getByRole("group", { name: "Source" }).getByRole("button", { name: "Hugging Face" }).click();
  await page.getByLabel("Repository").fill("Comfy-Org/Qwen-Image_ComfyUI");
  await page.getByRole("button", { name: "Look up" }).click();
  const files = page.getByRole("group", { name: "Files to download" });
  await expect(files.getByRole("checkbox")).toHaveCount(2);
  await expect(files.getByRole("checkbox").nth(1)).toBeDisabled();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose a file." })).toHaveText("Choose a file.");
  await files.getByRole("checkbox").first().check();
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/downloads$`));
  expect(started).toEqual([{ source: "huggingface", repo: "Comfy-Org/Qwen-Image_ComfyUI", files: ["m-Q4_K_M.gguf"] }]);
  // Downloads reads the page again as it opens; let that answer go unanswered.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Web search: the administrator sets the SearXNG address and sees whether it answers; without one the switch says why", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  await page.goto(`/#/u/${userId}/admin/search`);
  const section = page.getByRole("region", { name: "Web search" });
  const address = section.getByLabel("SearXNG address");
  await address.fill(`${fake}/searxng`);
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.locator(".state-word")).toHaveText("Reachable");
  await noHorizontalScroll(page);
  await shot("web-search-reachable");
  await address.fill(`${fake}/nothing-here`);
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.locator(".state-word")).toHaveText("Unreachable");
  await expect(section.locator(".state-word")).toHaveAttribute("title", /answered 404/);
  await shot("web-search-unreachable");
  await address.fill("");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.locator(".state-word")).toHaveCount(0);

  await newThread(page, "General");
  await send(page, "hello there");
  await page.getByRole("button", { name: "Attach or switch tools" }).click();
  const menu = page.getByRole("menu", { name: "Attach and tools" });
  const web = menu.locator("label.switch", { hasText: "Web search" });
  await expect(web).toHaveAttribute("title", "Search needs a SearXNG address in Administration");
  await expect(menu.getByLabel("Web search")).toBeEnabled();
  await web.hover();
  await shot("web-search-switch-unset");
  await page.keyboard.press("Escape");
});

test("the sidebar brand links home and closes the phone drawer", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/admin/status`);
  await expect(page.getByRole("heading", { name: "Status", exact: true })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const brand = page.locator("a.brand");
  await expect(brand).toHaveAttribute("href", `#/u/${userId}`);
  await expect(brand).not.toHaveAttribute("aria-current", "page");
  await brand.click();
  await expect(brand).toHaveAttribute("aria-current", "page");
  if (phone(page)) {
    await expect(page.locator(".app")).toHaveAttribute("data-side-open", "false");
    await page.getByRole("button", { name: "Show threads" }).click();
    await brand.click();
    await expect(page.locator(".app")).toHaveAttribute("data-side-open", "false");
  }
  await noHorizontalScroll(page);
});

test("Administration has Her name after Status and saves the name throughout the app", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/admin/name`);
  const nav = page.getByRole("navigation", { name: "Administration sections" });
  await expect(nav.getByRole("link").nth(0)).toHaveText("Status");
  await expect(nav.getByRole("link").nth(1)).toHaveText("Her name");
  const name = page.getByLabel("Name", { exact: true });
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(name).toHaveValue("Lyrica");
  await expect(name).toHaveAttribute("maxlength", "40");
  await expect(save).toBeDisabled();
  await name.fill("   ");
  await expect(save).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "Her name is 1 to 40 characters." })).toHaveText("Her name is 1 to 40 characters.");
  await name.fill("Ly\u2028rica");
  await expect(save).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "Her name is one line of text." })).toHaveText("Her name is one line of text.");
  await name.fill("  Lyrica  ");
  await expect(save).toBeDisabled();
  await name.fill("Moonlight");
  await save.click();
  await expect(name).toHaveValue("Moonlight");
  await expect(page.locator("a.brand")).toHaveText("Moonlight");
  await expect(page).toHaveTitle("Moonlight");
  await expect(save).toBeDisabled();
  await noHorizontalScroll(page);
  await name.fill("Lyrica");
  await save.click();
  await expect(name).toHaveValue("Lyrica");
  await expect(page).toHaveTitle("Lyrica");
});

test("Custom… pronouns opens the five fields, starting from the current words", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/settings/profile`);
  const section = page.getByRole("region", { name: "Profile" });
  await section.getByLabel("Pronouns").selectOption("custom");
  await expect(section.getByLabel("herself")).toBeVisible();
  await expect(section.getByLabel("herself")).not.toHaveValue("");
  await section.getByLabel("Pronouns").selectOption("they/them");
  await expect(section.getByLabel("herself")).toHaveCount(0);
});

test("image providers run 2: cloud switches and refusal links", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const api = async (method: string, path: string, data?: unknown) => page.evaluate(async ([method, path, data]) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return response.json();
  }, [method, `/api/u/${userId}${path}`, data] as const);
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  const ep = await api("POST", "/endpoints", { name: "image-switches", kind: "cloud", baseUrl: `${fake}/cloud/v1`, apiKey: "fake-key" }) as { id: string };
  const model = await api("POST", `/endpoints/${ep.id}/models`, { modelId: "art-model", tools: true }) as { id: string };
  await page.goto(`/#/u/${userId}/models/hosts`);
  const row = page.locator(`[data-endpoint="${ep.id}"]`);
  await row.getByRole("button", { name: /^\d+ models?$/ }).click();
  const controls = row.locator(`[data-offering="${model.id}"]`);
  await expect(controls.getByRole("checkbox", { name: "Image generation" })).not.toBeChecked();
  await controls.getByRole("checkbox", { name: "Image generation" }).click();
  await expect(controls.getByRole("checkbox", { name: "Image generation" })).toBeChecked();
  await controls.getByRole("checkbox", { name: "Image editing" }).click();
  await expect(controls.getByRole("checkbox", { name: "Image editing" })).toBeChecked();
  await controls.getByRole("button", { name: "Fast", exact: true }).click();
  await expect(controls.getByRole("button", { name: "Fast", exact: true })).toHaveAttribute("aria-pressed", "true");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/image-switches-${page.viewportSize()!.width}.png` });
  await page.goto(`/#/u/${userId}/models/images`);
  const imageRow = page.locator(`[data-entry="${model.id}"]`);
  await imageRow.getByRole("button").first().click();
  await expect(imageRow.getByRole("button", { name: "Fast", exact: true })).toHaveAttribute("aria-pressed", "true");
  await imageRow.getByRole("button", { name: "Quality", exact: true }).click();
  await expect(imageRow.getByRole("button", { name: "Quality", exact: true })).toHaveAttribute("aria-pressed", "true");
  await noHorizontalScroll(page);
  await api("DELETE", `/endpoints/${ep.id}`);

  await page.goto(`/#/u/${userId}`);
  await newThread(page, "General");
  await send(page, "An imaginary garden");
  await expect(page.getByText("You said: An imaginary garden")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  let canEdit = true, next = true;
  const asked: unknown[] = [];
  await page.route(`**${base}/messages`, route => route.fulfill({ json: { hasMore: false, messages: [
    { id: `e:${threadId}#1`, n: 1, role: "user", createdAt: "2026-10-12T12:00:00Z", parts: [{ type: "text", text: "An imaginary garden" }] },
    { id: `e:${threadId}#2`, n: 2, role: "assistant", createdAt: "2026-10-12T12:00:01Z", parts: [
      { type: "tool", toolCallId: "refused", name: "image", args: { action: "create", tier: "quality", prompt: "A garden" },
        result: "Image generation was refused (image_refusal).", isError: true,
        imageRefusal: { code: "image_refusal", offeringId: "art", endpointId: "ep" } },
    ] },
  ] } }));
  await page.route(`**${base}/image-calls/refused`, route => {
    if (route.request().method() === "POST") { asked.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { canEdit, userMessage: { n: 1, text: "An imaginary garden" }, ...(next ? { next: { offeringId: "next-art", label: "spare/art" } } : {}) } });
  });
  await page.reload();
  const marker = page.locator('.marker[data-type="tool"]');
  await expect(marker.getByRole("button", { name: "Edit message", exact: true })).toBeVisible();
  await expect(marker).toContainText("The model declined this image.");
  await expect(marker).not.toContainText("image_refusal");
  await expect(marker.getByRole("button", { name: "Try spare/art", exact: true })).toBeVisible();
  await noHorizontalScroll(page);
  if (phone(page)) expect((await marker.getByRole("button", { name: "Resend", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/image-refusal-${page.viewportSize()!.width}.png` });
  await marker.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("An imaginary garden");
  await marker.getByRole("button", { name: "Resend", exact: true }).click();
  await expect.poll(() => asked).toEqual([{ next: false }]);
  await marker.getByRole("button", { name: "Try spare/art", exact: true }).click();
  await expect.poll(() => asked).toEqual([{ next: false }, { next: true }]);
  canEdit = false; next = false;
  await page.reload();
  await expect(marker.getByRole("button", { name: "Resend", exact: true })).toBeVisible();
  await expect(marker.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
  await expect(marker.getByRole("button", { name: /^Try / })).toHaveCount(0);
});

test("image providers run 3: endpoint facts, five pills and default names", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const base = `/api/u/${userId}`;
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  const ep = await page.evaluate(async ({ base, fake }) => {
    const add = await fetch(`${base}/endpoints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "keyed-images", kind: "cloud", baseUrl: `${fake}/cloud/v1`, apiKey: "fake-secret-1234" }) });
    if (!add.ok) throw new Error(`add endpoint: ${add.status}`);
    const ep = await add.json();
    await fetch(`${base}/endpoints/${ep.id}/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: "art-chat", tools: true, vision: true, image: true, edit: true }) });
    return ep as { id: string };
  }, { base, fake });
  // Only a page fixture for the plan: no sign-in, token refresh, probe or plan call.
  await page.route(`**${base}/models/page`, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.endpoints.push({ id: "fake-plan", name: "ChatGPT", kind: "cloud", api: "chatgpt", baseUrl: "https://api.openai.com/v1", hasApiKey: false, shared: false, unencrypted: false, stale: false, state: "up", planAccount: "ada@example.test", cloudCapabilities: ["Text", "Vision", "Image"], models: [] });
    data.endpoints.push({ id: "fake-grok", name: "Grok", kind: "cloud", api: "grok", baseUrl: "https://api.x.ai/v1", hasApiKey: false, shared: false, unencrypted: false, stale: false, state: "up", cloudCapabilities: ["Text"], models: [] });
    await route.fulfill({ json: data });
  });
  await page.goto(`/#/u/${userId}/models/hosts`);
  const row = page.locator(`[data-endpoint="${ep.id}"]`);
  for (const pill of ["cloud", "API key", "Text", "Vision", "Image"]) await expect(row.locator(".pill, .kind").filter({ hasText: new RegExp(`^${pill}$`) })).toBeVisible();
  await expect(row).toContainText("key ••••1234");
  await expect(row).not.toContainText("fake-secret");
  const plan = page.locator('[data-endpoint="fake-plan"]');
  await expect(plan).toContainText("ChatGPT plan · only you · ada@example.test");
  await expect(plan).not.toContainText("https://");
  await expect(plan).not.toContainText("API key");
  await expect(page.locator('[data-endpoint="fake-grok"] .pill').filter({ hasText: /^Image$/ })).toHaveCount(0);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/image-endpoints-${page.viewportSize()!.width}.png`, fullPage: true });
  await page.getByRole("button", { name: "Add endpoint", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Add endpoint" });
  await drawer.getByRole("combobox", { name: "Kind", exact: true }).selectOption("chatgpt");
  await expect(drawer.getByLabel("Name", { exact: true })).toHaveValue("ChatGPT");
  await drawer.getByRole("combobox", { name: "Kind", exact: true }).selectOption("custom");
  await drawer.getByLabel("Base URL", { exact: true }).fill("https://api.openai.com/v1");
  await expect(drawer.getByLabel("Name", { exact: true })).toHaveValue("OpenAI");
  await drawer.getByLabel("Name", { exact: true }).fill("my-images");
  await drawer.getByRole("combobox", { name: "Kind", exact: true }).selectOption("chatgpt");
  await expect(drawer.getByLabel("Name", { exact: true })).toHaveValue("my-images");
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await page.unroute(`**${base}/models/page`);
  await page.evaluate(async path => { await fetch(path, { method: "DELETE" }); }, `${base}/endpoints/${ep.id}`);
});

test("spend share popovers and Call history project filter", async ({ page, baseURL }, testInfo) => {
  const userId = await enter(page, baseURL!);
  const project = await page.evaluate(async userId => {
    const api = async (path: string, data?: unknown) => {
      const res = await fetch(`/api/u/${userId}${path}`, { method: data ? "POST" : "GET", headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    };
    const t = await api("/threads", { pool: "general", project: true, title: "Usage project" });
    await fetch(`/api/u/${userId}/threads/general/${encodeURIComponent(t.id)}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ localOnly: true }) });
    await api(`/threads/general/${encodeURIComponent(t.id)}/messages`, { text: "steps: done Read; doing Write; todo Check" });
    return t;
  }, userId);
  await expect.poll(() => page.evaluate(async ({ userId, id }) => (await (await fetch(`/api/u/${userId}/threads/general/${encodeURIComponent(id)}/usage`)).json()).tokens, { userId, id: project.id })).toBeGreaterThan(0);
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(project.id)}`);
  if (phone(page)) await page.getByRole("button", { name: /^Threads/ }).click();
  await page.getByRole("button", { name: /^[\d.,]+[kM]? tokens$/ }).click();
  await expect(page.getByTitle("Counts every request, cached reads included.")).toBeVisible();
  await expect(page.getByText("By thread", { exact: true })).toBeVisible();
  await expect(page.getByText("This chat", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/spend-share-${testInfo.project.name}.png` });
  await page.getByRole("link", { name: "Recent calls", exact: true }).last().click();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(`general/${project.id}`);
  await page.reload();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(`general/${project.id}`);
  // Recent calls keeps its own project list when the sidebar hides projects.
  await page.evaluate(async userId => {
    await fetch(`/api/u/${userId}/me/display`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projects: "none" }) });
  }, userId);
  await page.reload();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(`general/${project.id}`);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(async userId => {
    await fetch(`/api/u/${userId}/me/display`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projects: "all" }) });
  }, userId);
});


test("project welcome and fold in", async ({ page, baseURL }) => {
  const user = { id: await enter(page, baseURL!) };
  const origin = baseURL!;
  const api = async (method: string, path: string, data?: unknown) => {
    return page.evaluate(async ({ method, path, data }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
      return r.json();
    }, { method, path, data });
  };
  const u = `/api/u/${user.id}`;
  const ep = await api("POST", `${u}/endpoints`, { name: "fake", kind: "local", baseUrl: `http://127.0.0.1:${Number(new URL(origin).port) + 10}/local/v1` });
  const found = await api("POST", `${u}/endpoints/${ep.id}/discover`);
  await api("PUT", `${u}/columns/general/chat`, { model: { offeringId: found.models[0].id } });
  const a = await api("POST", `${u}/threads`, { pool: "general", title: "Garden notes" });
  const b = await api("POST", `${u}/threads`, { pool: "general", title: "Seed catalogue" });
  await api("PATCH", `${u}/threads/general/${encodeURIComponent(a.id)}/settings`, { hosts: ["garden.example"], internet: true });
  const p = await api("POST", `${u}/threads`, { pool: "general", project: true, title: "Garden" });
  await api("PATCH", `${u}/threads/general/${encodeURIComponent(p.id)}/settings`, { hosts: [], internet: false });
  await page.goto(`/#/u/${user.id}/t/general/${encodeURIComponent(p.id)}`);
  const width = page.viewportSize()!.width;
  await expect(page.getByRole("button", { name: "Set up from recent work" })).toBeVisible();
  await expect(page.getByText("Let's get to work!", { exact: true })).toBeVisible();
  if (process.env.LYRICA_PROJECT_SHOTS) await page.screenshot({ path: `../shots/welcome-${width}.png` });
  await page.getByRole("button", { name: "Set up from recent work" }).click();
  await expect(page.getByRole("dialog").getByLabel("Garden notes")).toBeChecked();
  if (process.env.LYRICA_PROJECT_SHOTS) await page.screenshot({ path: `../shots/dialog-${width}.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Set up from recent work" })).toBeFocused();
  await page.getByRole("button", { name: "Set up from recent work" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set up from recent work" })).toBeFocused();
  await api("POST", `${u}/threads/general/${encodeURIComponent(p.id)}/messages`, { text: `fold: ${a.id}, ${b.id}` });
  await expect(page.getByRole("group", { name: "Fold in", exact: true })).toBeVisible();
  await expect(page.getByText("Loses", { exact: false }).first()).toBeVisible();
  if (process.env.LYRICA_PROJECT_SHOTS) await page.screenshot({ path: `../shots/fold-in-${width}.png` });
  const card = page.getByRole("group", { name: "Fold in", exact: true });
  const overview = async () => (await api("GET", `${u}/threads/general/${encodeURIComponent(p.id)}/overview`)).threads;
  const dialog = page.getByRole("dialog");
  // Nothing folds before the dialog confirms it; Cancel leaves the thread where it was.
  await card.getByRole("button", { name: "Fold in", exact: true }).first().click();
  await expect(dialog.getByRole("heading", { name: /^Fold Garden notes into Garden\?$/ })).toBeVisible();
  await expect(dialog.getByText("A thread can't be taken out of a project once it's in.")).toBeVisible();
  if (process.env.LYRICA_PROJECT_SHOTS) await page.screenshot({ path: `../shots/fold-dialog-${width}.png` });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await overview()).toHaveLength(0);
  expect((await api("GET", `${u}/threads/general/${encodeURIComponent(a.id)}`)).parent).toBeUndefined();
  // Confirming with the access box ticked grants the losses, then folds.
  await card.getByRole("button", { name: "Fold in", exact: true }).first().click();
  await dialog.getByRole("checkbox", { name: /^Give Garden access to these/ }).check();
  await dialog.getByRole("button", { name: "Fold in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await overview()).length).toBe(1);
  await expect(page.getByText("Loses", { exact: false })).toHaveCount(0);
  await card.getByRole("button", { name: /^Fold in all/ }).click();
  await expect(dialog.getByRole("heading", { name: /^Fold 1 thread/ }).or(dialog.getByRole("heading", { name: /^Fold Seed catalogue into/ }))).toBeVisible();
  await dialog.getByRole("button", { name: "Fold in", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await overview()).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await api("POST", `${u}/threads/general/${encodeURIComponent(p.id)}/messages`, { text: "draft: Grow seedlings | Keep a planting journal" });
  // The draft card's own link (the header has none since the overview took it).
  await expect(page.getByRole("link", { name: "Project settings", exact: true }).last()).toBeVisible();
  await page.getByRole("link", { name: "Project settings", exact: true }).last().click();
  const goal = page.getByRole("textbox", { name: "Goal", exact: true });
  await expect(goal).toHaveValue("Grow seedlings");
  expect((await api("GET", `${u}/threads/general/${encodeURIComponent(p.id)}`)).goal).toBeUndefined();
  await goal.fill("Grow herbs");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect((await api("GET", `${u}/threads/general/${encodeURIComponent(p.id)}`)).goal).toBe("Grow herbs");
  await page.getByRole("link", { name: "Memory", exact: true }).last().click();
  await expect(page.getByRole("textbox", { name: /^Instructions/ })).toHaveValue("Keep a planting journal");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByRole("textbox", { name: /^Instructions/ })).toHaveValue("");
  const empty = await api("POST", `${u}/threads`, { pool: "general", project: true, title: "Plan garden" });
  await page.goto(`/#/u/${user.id}/t/general/${encodeURIComponent(empty.id)}`);
  await page.getByRole("button", { name: "Make a plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  const planned = await api("GET", `${u}/threads/general/${encodeURIComponent(empty.id)}/overview`);
  expect(planned.threads.map((t: { title: string }) => t.title)).toEqual(["Plan"]);
  await page.goto(`/#/u/${user.id}/t/general/${encodeURIComponent(empty.id)}`);
  await expect(page.locator(".tcard").getByRole("link", { name: "Plan", exact: true })).toBeVisible();
  const source = await api("POST", `${u}/threads`, { pool: "general", title: "Recent planting" });
  const setup = await api("POST", `${u}/threads`, { pool: "general", project: true, title: "Seedlings" });
  await page.goto(`/#/u/${user.id}/t/general/${encodeURIComponent(setup.id)}`);
  await page.getByRole("button", { name: "Set up from recent work" }).click();
  const options = page.getByRole("dialog").getByRole("checkbox");
  // The list loads after the dialog opens, and earlier tests leave threads: wait for the rows, then untick them all.
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "Recent planting" })).toBeVisible();
  for (const option of await options.all()) await option.uncheck();
  await page.getByRole("dialog").getByRole("checkbox", { name: "Recent planting" }).check();
  const sent = page.waitForRequest(r => r.method() === "POST" && r.url().endsWith("/messages"));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect((await sent).postDataJSON().recentThreadIds).toEqual([source.id]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(`/#/u/${user.id}/t/general/${encodeURIComponent(source.id)}`);
  await page.getByRole("button", { name: "Thread actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Make project…" })).toHaveAttribute("title", "Turns this thread into a project.");
  const continuation = page.getByRole("menuitem", { name: "Continue as project" });
  await expect(continuation).toHaveAttribute("title", "Starts a new project from this thread; the thread stays.");
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Start a project from Recent planting?" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Continue as project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project settings", exact: true })).toBeVisible();
  expect((await api("GET", `${u}/threads/general/${encodeURIComponent(source.id)}`)).project).toBeFalsy();
});

test("move to project confirms children and losses, filters pools and local-only destinations", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const api = async (method: string, path: string, data?: unknown) => page.evaluate(async ({ method, path, data }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }, { method, path, data });
  const u = `/api/u/${userId}`;
  const create = (pool: string, title: string, project = false) => api("POST", `${u}/threads`, { pool, title, project });
  const source = await create("general", "Seed notes");
  await api("POST", `${u}/threads/general/${encodeURIComponent(source.id)}/messages`, { text: "Seed notes for spring." });
  await expect.poll(async () => (await api("GET", `${u}/threads/general/${encodeURIComponent(source.id)}`)).busy).toBe(false);
  const child = await api("POST", `${u}/threads/general/${encodeURIComponent(source.id)}/messages/1/branch`, { title: "Watering" });
  const garden = await create("general", "Orchard", true);
  const cloud = await create("general", "Cloud orchard", true);
  const secret = await create("private", "Private orchard", true);
  const privateSource = await create("private", "Private notes");
  const path = (pool: string, id: string) => `${u}/threads/${pool}/${encodeURIComponent(id)}`;
  await api("PATCH", `${path("general", garden.id)}/settings`, { localOnly: true, hosts: [], internet: false });
  await api("PATCH", `${path("general", source.id)}/settings`, { hosts: ["garden.example"], internet: true });
  const open = async (pool: string, id: string) => {
    await page.goto(`/#/u/${userId}/t/${pool}/${encodeURIComponent(id)}`);
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Move to project/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /^Move to project/ }).click();
  };
  await open("general", source.id);
  await expect(page.getByRole("menuitem", { name: "Orchard", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Cloud orchard", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Private orchard", exact: true })).toHaveCount(0);
  const width = page.viewportSize()!.width;
  if (process.env.LYRICA_PROJECT_SHOTS) await page.screenshot({ path: `../shots/move-flyout-${width}.png` });
  await page.getByRole("menuitem", { name: "Orchard", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Move Seed notes to Orchard?" })).toBeVisible();
  await expect(dialog).toContainText("Watering");
  await expect(dialog).toContainText("Cloud models");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  expect((await api("GET", path("general", source.id))).parent).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  if (process.env.LYRICA_PROJECT_SHOTS) await page.screenshot({ path: `../shots/move-confirm-${width}.png` });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await api("GET", path("general", source.id))).parent).toBeUndefined();
  await open("general", source.id);
  await page.getByRole("menuitem", { name: "Orchard", exact: true }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(garden.id)));
  expect((await api("GET", path("general", source.id))).parent).toBe(garden.id);
  expect((await api("GET", path("general", child.id))).parent).toBe(garden.id);
  expect((await api("GET", `${path("general", source.id)}/settings`)).localOnly).toBe(true);
  expect((await api("GET", `${path("general", garden.id)}/settings`)).network.hosts).toContain("garden.example");
  await open("private", privateSource.id);
  await expect(page.getByRole("menuitem", { name: "Private orchard", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Orchard", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Cloud orchard", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const local = await create("general", "Local notes");
  await api("PATCH", `${path("general", local.id)}/settings`, { localOnly: true });
  await open("general", local.id);
  await expect(page.getByRole("menuitem", { name: "Orchard", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Cloud orchard", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await api("PATCH", path("general", garden.id), { hidden: true });
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(local.id)}`);
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Move to project/ })).toHaveCount(0);
});
