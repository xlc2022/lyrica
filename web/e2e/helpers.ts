// Shared by the e2e specs (web-chat, web-projects, web-admin). Each spec runs in order on its own
// lyricad per screen size (playwright.config.ts), so each starts from a fresh one and enter() sets it up.
import { expect, type Locator, type Page, type Route } from "@playwright/test";
export const PASSPHRASE = "correct horse";

export const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 760;

/** Unlocks and logs in as needed, and makes sure ada has a cloud and a local endpoint. Returns ada's user ID. */
export async function enter(page: Page, baseURL: string): Promise<string> {
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

export async function newThread(page: Page, pool: "General" | "Private") {
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await page.getByRole("button", { name: "New thread" }).click();
  await page.getByRole("group", { name: "New thread in" }).getByRole("button", { name: pool }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
}

export async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

export async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Thread settings" }).click();
  const drawer = page.getByRole("complementary", { name: "Thread settings" });
  // A re-render can cancel the slide-in, whose finished then rejects: that still means it is done.
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))));
  return drawer;
}

/** Opens the open thread's Delete… dialog from the header's Thread actions menu. */
export async function deleteThread(page: Page) {
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Delete…/ }).click();
  return page.getByRole("dialog", { name: "Delete this thread?" });
}

/** From a project chat, opens its settings page: Project in the header shows the overview (the Threads page on a phone,
 *  the panel from 1180 px) with the Project settings link inside; from the panel, Open as a page (docs/ux.md §6). */
export async function openProjectSettings(page: Page) {
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
export async function togglePrivate(page: Page) {
  const sorting = page.locator(".showing");
  if (!(await sorting.evaluate((el) => (el as HTMLDetailsElement).open))) await sorting.locator("summary").click();
  const box = sorting.getByRole("checkbox", { name: "Private" });
  const was = await box.isChecked();
  await box.click();
  await expect(box).toBeChecked({ checked: !was });
  await sorting.locator("summary").click();
}

/** Body is overflow: hidden, so check the containers that scroll, and that nothing pokes past the viewport. */
export const location_of = (page: Page) => page.url();

/** A general thread's ID, from a link to it. */
export const threadIdOf = (href: string) => decodeURIComponent(href.split("/t/general/")[1]!.split("/")[0]!);

/** Sends a message to a general thread through the API, as another tab would: the page stays as it is, an open popover too. */
export async function sendTo(page: Page, userId: string, threadId: string, text: string) {
  await page.evaluate(async ([path, text]) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }, [`/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}/messages`, text] as const);
}

/** On a touch screen, a facts-line link reaches 44 px through its ::after. */
export const hitHeight = (button: Locator) => button.evaluate((el) => parseFloat(getComputedStyle(el, "::after").height) || el.getBoundingClientRect().height);

export async function noHorizontalScroll(page: Page) {
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

/**
 * Sleep items the `/sleep-item-fixture` route writes (serve.ts), so a Notifications row can be
 * shown cut and open. Synthetic, at three lengths: `long` is past three lines at any width,
 * `medium` only at 390 px, `short` never.
 */
export const SLEEP_FIXTURE = {
  long: "Fixture question about whether to plant the beds along the north wall this season, since the shade from the fig arrives too late in the afternoon to matter for the tomatoes and the soil there drains well enough that they should ripen before the first frost; she would rather ask than decide alone, because last year rows were placed by the fence line and nobody ever measured it.",
  medium: "Fixture question about whether the fig needs a second trellis before next spring, since its new growth already reaches the kitchen window by August and that wall is only warm in the afternoon.",
  short: "Fixture note about the greenhouse being warm enough now.",
};

/** route.fetch, tried once more if lyricad closed a kept-alive connection under it (ECONNRESET, or "socket hang up" when no byte came back), as a browser retries such a GET itself. */
export async function fetchReal(route: Route) {
  try {
    return await route.fetch();
  } catch (err) {
    if (!/ECONNRESET|socket hang up/.test(String(err))) throw err;
    return route.fetch();
  }
}
