// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// The phone check, Models, tasks, downloads, images, administration, questions, push and Code mode.
// Tests run in order on this file's own lyricad per size.
import { createServer } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { phone, enter, newThread, send, openSettings, openProjectSettings, threadIdOf, sendTo, hitHeight, noHorizontalScroll, fetchReal } from "./helpers.ts";
import type { ModelsPage } from "../src/api.ts";

test.describe.configure({ mode: "serial" });
// Routes that fetch the real response (fakeHost, fakeImages) can still be running when a test ends.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

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
    // Not networkidle: the shell's user stream stays open for as long as the page does.
    await expect(page.locator("header.head h1")).toBeVisible();
    await expect(page.locator(".loading")).toHaveCount(0);
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

  // A model router no longer lists has Remove in its model list, which asks first and then drops it.
  const endpoints = await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/endpoints`) as { id: string; name: string }[];
  const routerId = endpoints.find((e) => e.name === "router")!.id;
  await page.evaluate(async (path) => { await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: "old-model" }) }); }, `/api/u/${userId}/endpoints/${routerId}/models`);
  await page.route(/\/api\/u\/[^/]+\/models\/page$/, async (route) => {
    const body = await (await fetchReal(route)).json() as ModelsPage;
    for (const ep of body.endpoints) for (const m of ep.models) if (m.modelId === "old-model") m.status = "missing";
    // The page before the reload may still be asking: the reload drops that request, so there is nothing left to answer.
    await route.fulfill({ json: body }).catch((err: Error) => { if (!String(err).includes("Route is already handled")) throw err; });
  });
  await page.reload();
  const routerRow = page.locator("li.ep-row").filter({ hasText: /^router / });
  await routerRow.getByRole("button", { name: /^\d+ models?$/ }).click();
  const old = routerRow.locator("li[data-offering]").filter({ hasText: "old-model" });
  await expect(old.locator(".pill")).toHaveText("missing");
  await expect(routerRow.locator("li[data-offering]").filter({ hasText: "cloud-model" }).getByRole("button", { name: "Remove" })).toHaveCount(0);
  await noHorizontalScroll(page);
  await shot("missing-model");
  await old.getByRole("button", { name: "Remove old-model" }).click();
  const ask = page.getByRole("dialog", { name: "Remove old-model?" });
  await ask.getByRole("button", { name: "Remove" }).click();
  await expect(ask).toHaveCount(0);
  await expect(old).toHaveCount(0);
  await page.unroute(/\/api\/u\/[^/]+\/models\/page$/);

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
    await expect(item.locator(".status-state", { hasText: "checked" }).locator(".num")).toHaveText(/^\d+$/);
  }
  // A text endpoint with no measured turn in the past day shows no speed, and its tooltip says so; a speech-only one never mentions speed.
  const gpuItem = line.locator(".status-item").filter({ hasText: "gpu" });
  await expect(gpuItem.locator(".status-state", { hasText: "tok/s" })).toHaveCount(0);
  await expect(gpuItem).toHaveAttribute("title", "gpu · no turns in the past day");
  await expect(line.locator(".status-item").filter({ hasText: "speech" })).toHaveAttribute("title", "speech");
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
  await expect(renamed).toHaveAttribute("title", new RegExp(`^${LONG} · `));
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
  await expect(cloudItem).toHaveAttribute("title", new RegExp(`^${LONG_CLOUD} · .+ · checked \\d+ (s|min) ago$`));
  if (page.viewportSize()?.width === 390) await page.screenshot({ path: "shots/status-390.png" });

  // Back as they were, for the tests that follow.
  await rename(gpuId, "gpu");
  await rename(routerId, "router");

  // With measured turns, the speed follows the name in mono, and the tooltip adds prompt speed and how many turns it covers.
  await page.route("**/models/page", async (route) => {
    const body = await (await route.fetch()).json() as ModelsPage;
    body.endpointUses = [{ endpointId: gpuId, calls: 9, tokPerSec: 41.6, promptTokPerSec: 812.3, speedCalls: 9 },
      ...body.endpointUses.filter((u) => u.endpointId !== gpuId)];
    await route.fulfill({ json: body });
  });
  await page.reload();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  const fast = line.locator(".status-item").filter({ hasText: "gpu" });
  await expect(fast.locator(".status-state", { hasText: "tok/s" })).toHaveText("· 42 tok/s");
  await expect(fast).toHaveAttribute("title", "gpu · 42 tok/s · 812 prompt tok/s · last 9 turns");
  await noHorizontalScroll(page);
  if (page.viewportSize()?.width === 390) await page.screenshot({ path: "shots/status-speed-390.png" });
  await page.unroute("**/models/page");
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
    const real = await (await fetchReal(route)).json() as {
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
  // An empty field shows what applies instead: the window planned by, and the longest reply it allows.
  await expect(drawer.getByLabel("Context window")).toHaveAttribute("placeholder", /^[\d,]+$/);
  await expect(drawer.getByLabel("Maximum reply length")).toHaveAttribute("placeholder", /^[\d,]+$/);
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
    const real = await (await fetchReal(route)).json() as { endpoints: Record<string, unknown>[]; hosts: unknown[] };
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
  await expect(page.getByLabel("Download to")).toHaveAttribute("title", "/srv/models");
  await page.getByRole("button", { name: "Cancel" }).click();
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
  // Starter recipes: Z-Image Turbo's parts are all here; FLUX.1 schnell's model isn't.
  const sp = (path: string, size: number, present: boolean) => ({ role: "diffusion", source: "huggingface", repo: "Comfy-Org/x", path, sha256: "00", size: size * GB, present });
  const starters = [
    { id: "z-image-turbo", name: "Z-Image Turbo", template: "z-image", parts: [sp("split_files/z_image_turbo_bf16.safetensors", 12.3, true)], loras: [], defaults: {} },
    { id: "flux-schnell", name: "FLUX.1 schnell", template: "flux", parts: [sp("flux1-schnell.safetensors", 11.9, false), { ...sp("ae.safetensors", 0.3, true), role: "vae" }], loras: [], defaults: {} },
  ];
  await page.route(/\/api\/u\/[^/]+\/hosts\/ep-box\/starters(\/[^/]+\/install)?$/, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/ep-box\//, "");
    if (route.request().method() === "GET") return route.fulfill(json({ starters }));
    asked.push({ path, body: route.request().postDataJSON() });
    return route.fulfill(json({ recipe: { ...recipes[0], id: "00000000-0000-4000-8000-000000000004", name: "FLUX.1 schnell" }, downloads: [] }));
  });
  return { asked, zi, qi, offering: { id: "off-z", modelId: `recipe/${zi}`, label: `box/recipe/${zi}`, manual: false, status: "listed", recipe: "Z-Image Turbo", image: true } };
}

test("a host card has one facts line and Pause, Edit and ⋯; Edit opens a drawer that moves the models folder after asking, and Pair again… is a page", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/models-folder-${name}-${page.viewportSize()!.width}.png`, fullPage: true }); };
  let update: Record<string, unknown> = { available: true, changesFolder: true, state: "idle" };
  const status = () => ({ name: "box", version: "0.9.0", fingerprint: "SHA256:aaaa", state: "running", gpus: [], downloads: { active: 0 }, modelsFolder: { path: "/srv/models", free: 2 ** 40 }, update });
  await page.route(/\/api\/u\/[^/]+\/models\/page$/, async (route) => {
    const real = await (await fetchReal(route)).json() as { endpoints: Record<string, unknown>[]; hosts: unknown[] };
    const local = real.endpoints.find((e) => e.kind === "local")!;
    real.endpoints.push({ ...local, id: "ep-box", name: "box", api: "host", addresses: ["box.lan:7236"], fingerprint: "SHA256:aaaa", state: "up", shared: false, models: [] });
    real.hosts.push({ endpointId: "ep-box", status: status() });
    await route.fulfill(json(real));
  });
  const asked: unknown[] = [];
  await page.route(/\/api\/u\/[^/]+\/hosts\/ep-box\/models-folder$/, async (route) => {
    asked.push(route.request().postDataJSON());
    update = { available: true, changesFolder: true, state: "requested", models: "/mnt/big/models" };
    await route.fulfill(json(status()));
  });
  await page.goto(`/#/u/${userId}/models/hosts`);
  const card = page.locator("article.host[data-endpoint=ep-box]");
  await expect(card.locator(".host-facts")).toContainText("box.lan:7236·version0.9.0·models folder/srv/models·");
  await expect(card.locator(".host-top").getByRole("button")).toHaveText(["Pause", "Edit", ""]);
  await expect(card.locator(".host-facts").getByRole("button", { name: "Dashboard" })).toBeVisible();
  await shot("card");
  await card.getByRole("button", { name: "Edit" }).click();
  const drawer = page.getByRole("complementary", { name: "Edit box" });
  await drawer.getByLabel("Models folder").fill("/mnt/big/models");
  await shot("change");
  await drawer.getByRole("button", { name: "Save" }).click();
  const ask = page.getByRole("dialog");
  await shot("dialog");
  await expect(ask.getByRole("heading")).toHaveText("Move box to another models folder?");
  await expect(ask).toContainText("restarts on /mnt/big/models");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(asked).toEqual([]);
  await drawer.getByRole("button", { name: "Save" }).click();
  await ask.getByRole("button", { name: "Move" }).click();
  await expect(card.locator(".status-word")).toHaveText("Moving");
  await shot("moving");
  expect(asked).toEqual([{ path: "/mnt/big/models" }]);
  await expect(drawer).toHaveCount(0);
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(drawer.getByLabel("Models folder")).toBeDisabled();
  await drawer.getByRole("button", { name: "Close" }).click();
  await noHorizontalScroll(page);

  // A failed move says why; an updater from before this release says how to get one that moves.
  update = { available: true, changesFolder: true, state: "failed", models: "/etc", error: "a system folder" };
  await page.reload();
  await expect(card.getByRole("note")).toHaveText("Moving to /etc failed: it's one of the system's folders.");
  await shot("failed");
  update = { available: true, state: "idle" };
  await page.reload();
  await expect(card.locator(".host-facts [title]").filter({ hasText: "models folder" })).toHaveAttribute("title", "Run install.sh on the host again to change it from here.");
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(drawer.getByLabel("Models folder")).toBeDisabled();
  await drawer.getByRole("button", { name: "Close" }).click();

  // Pair again… is a page of its own for that host: only the code, then the fingerprint.
  await card.getByRole("button", { name: "Actions for box" }).click();
  await page.getByRole("menuitem", { name: "Pair again…" }).click();
  await expect(page).toHaveURL(/\/models\/hosts\/add-host\?host=ep-box$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pair box again");
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await expect(page.getByLabel("Pairing code")).toBeVisible();
  await shot("pair-again");
  await noHorizontalScroll(page);
});



test("Image models: groups by architecture with Role and Where; a recipe opens to its parts with Change, Add part and Delete model…; Parts lists the files; To review selects and ignores; Download image model makes a starter after asking, scans and downloads", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const images = await fakeImages(page);
  const started = await fakeHost(page, [], [images.offering]);
  const post = (path: string) => images.asked.filter((a) => a.path === path).map((a) => a.body);
  await page.goto(`/#/u/${userId}/models/images`);
  await expect(page.getByRole("heading", { level: 1, name: "Image models" })).toBeVisible();
  await expect(page.locator(".head .cap")).toHaveText("1 model (recipe) · 6 parts on 1 host · 0 groups · 1 to review");
  await expect(page.getByRole("navigation", { name: "Models pages" }).getByRole("link", { name: "Image models" })).toHaveAttribute("aria-current", "page");
  // Scan in the header has each host read its models folder again.
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect.poll(() => post("manage")).toEqual([{ method: "POST", path: "/host/v1/scan" }]);

  // A recipe: its facts, then its copy on the host as a block of parts.
  const list = page.getByRole("list", { name: "Z-Image models" });
  await expect(page.getByRole("region", { name: "Z-Image", exact: true }).locator("header")).toContainText("Z-Image1 model");
  await expect(list.getByRole("button", { name: /^Z-Image Turbo/ })).toContainText("Z-Image · generate · fast and quality · 1 copy · box");
  await expect(page.locator(".arch-groups").getByText("Qwen-Image")).toHaveCount(0);
  // The parts that fit Z-Image, collapsed under its models.
  await expect(page.getByRole("region", { name: "Z-Image", exact: true }).locator("summary")).toContainText("Parts for Z-Image");
  // Role and Where narrow the list.
  await page.getByRole("group", { name: "Role" }).getByRole("button", { name: "Upscale" }).click();
  await expect(page.locator(".arch-groups")).toContainText("No image models match.");
  await page.getByRole("group", { name: "Role" }).getByRole("button", { name: "Generate" }).click();
  await expect(list.getByRole("button", { name: /^Z-Image Turbo/ })).toBeVisible();
  await page.getByRole("group", { name: "Where" }).getByRole("button", { name: "Cloud" }).click();
  await expect(list).toHaveCount(0);
  await page.getByRole("group", { name: "Where" }).getByRole("button", { name: "All" }).click();
  await page.getByRole("group", { name: "Role" }).getByRole("button", { name: "All" }).click();
  await list.getByRole("button", { name: /^Z-Image Turbo/ }).click();
  const block = page.getByRole("region", { name: "Z-Image Turbo on box" });
  await expect(block.locator(".copyhead")).toContainText("template z-image · 8 steps · CFG 1 · 1024×1024");
  await expect(block.locator(".partrow").nth(1)).toContainText("Text encoderQwen3");
  await expect(block.locator(".partrow").nth(0)).toContainText("BF16 · downloaded by Lyrica");
  await noHorizontalScroll(page);
  if (phone(page)) for (const b of [block.getByRole("button", { name: "Change the VAE" }), block.getByRole("button", { name: "Add part" })]) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  // Use for saves at once and the facts line reflects the tag after reload.
  const useFor = block.getByRole("group", { name: "Use for" });
  await expect(useFor.getByRole("button", { name: "Both", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const [label, tag, facts] of [["Fast", "fast", "fast"], ["Quality", "quality", "quality"], ["Both", "both", "fast and quality"]]) {
    await useFor.getByRole("button", { name: label!, exact: true }).click();
    await expect.poll(() => post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "change", change: { op: "useFor", useFor: tag } });
    await expect(useFor.getByRole("button", { name: label!, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(list.locator(".lrow-main .meta")).toContainText(`generate · ${facts} ·`);
  }
  await page.reload();
  await list.getByRole("button", { name: /^Z-Image Turbo/ }).click();
  await expect(useFor.getByRole("button", { name: "Both", exact: true })).toHaveAttribute("aria-pressed", "true");
  await noHorizontalScroll(page);
  if (phone(page)) expect((await useFor.getByRole("button", { name: "Fast", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Change: the host's other VAEs for the architecture, or Download another….
  await block.getByRole("button", { name: "Change the VAE" }).click();
  const vae = block.getByLabel("Choose the VAE");
  await expect(vae.locator("option")).toHaveText(["ae.safetensors · BF16", "ae_fp32.safetensors · FP32 · shared folder", "Download another…"]);
  await vae.selectOption("comfy/vae/ae_fp32.safetensors");
  await expect.poll(() => post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "change", change: { op: "swap", role: "vae", slot: null, file: "comfy/vae/ae_fp32.safetensors" } });

  // Add part, a drawer: a LoRA goes into a copy named after it, unless the box is unticked.
  await block.getByRole("button", { name: "Add part" }).click();
  const drawer = page.getByRole("complementary", { name: "Add part to Z-Image Turbo" });
  await expect(drawer.getByRole("group", { name: "Part" }).getByRole("button")).toHaveText(["LoRA"]);
  await expect(drawer.getByRole("radio", { name: /pixel-art\.safetensors/ })).toBeChecked();
  await expect(drawer.getByRole("radio", { name: /pixel-art\.safetensors/ })).toHaveAccessibleName(/Not used by any model/);
  await expect(drawer.getByLabel("Save as a new model, keeping Z-Image Turbo as it is")).toBeChecked();
  // Strength clamps to 1.5 when the field is left.
  await drawer.getByLabel("Strength").fill("3");
  await drawer.getByLabel("Strength").blur();
  await expect(drawer.getByLabel("Strength")).toHaveValue("1.5");
  await drawer.getByLabel("Strength").fill("1");
  await noHorizontalScroll(page);
  await drawer.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => post("recipes/00000000-0000-4000-8000-000000000003")).toEqual([{ do: "change", change: { op: "addLora", file: "comfy/loras/pixel-art.safetensors", strength: 1 } }]);
  expect(post(`recipes/${images.zi}`).at(-1)).toEqual({ do: "copy", name: "Z-Image Turbo + pixel art" });
  // The page opens the new model's row; this made-up host never makes it, so open Z-Image Turbo again.
  await list.getByRole("button", { name: /^Z-Image Turbo/ }).click();

  // Delete model…: what goes and what it frees, and that no list uses it.
  await block.getByRole("button", { name: "Delete model…" }).click();
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
  await expect(list.getByRole("button", { name: /^Z-Image Turbo/ })).toHaveAttribute("aria-expanded", "true");

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
  // Starter recipes come first: what each needs, and a dialog before anything missing downloads.
  const startersList = page.getByRole("radiogroup", { name: "Starter recipes" });
  await expect(page.getByRole("group", { name: "Source" }).getByRole("button", { name: "Starter recipes" })).toHaveAttribute("aria-pressed", "true");
  await expect(startersList.getByRole("radio", { name: /Z-Image Turbo/ })).toHaveAccessibleName(/every part is on this host/);
  await expect(startersList.getByRole("radio", { name: /FLUX\.1 schnell/ })).toHaveAccessibleName(/2 parts · 11\.9 GB to download/);
  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose a starter recipe." })).toBeVisible();
  await startersList.getByRole("radio", { name: /FLUX\.1 schnell/ }).check();
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Add model" }).click();
  const ask = page.getByRole("dialog", { name: "Download the missing parts?" });
  await expect(ask).toContainText("FLUX.1 schnell needs this part, which isn't on box yet.");
  await expect(ask).toContainText("flux1-schnell.safetensors");
  await expect(ask).not.toContainText("ae.safetensors");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(post("starters/flux-schnell/install")).toEqual([]);
  await page.getByRole("button", { name: "Add model" }).click();
  await ask.getByRole("button", { name: /^Download/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/u/${userId}/models/downloads$`));
  expect(post("starters/flux-schnell/install")).toHaveLength(1);
  await page.goto(`/#/u/${userId}/models/images/download`);
  await page.getByRole("group", { name: "Source" }).getByRole("button", { name: "Scan folder" }).click();
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByRole("list", { name: "Found" }).locator("li.rvrow")).toContainText("Qwen-Image");
  expect(post("manage")).toEqual([{ method: "POST", path: "/host/v1/scan" }, { method: "POST", path: "/host/v1/scan" }]);
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
  // The saved name comes back as a live update and can re-render the field mid-fill: fill until it holds.
  await expect(async () => {
    await name.fill("Lyrica");
    await expect(name).toHaveValue("Lyrica", { timeout: 1000 });
  }).toPass();
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

test("Time zone: the browser's is given at first, an unknown name is refused, and every time follows the saved one", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const me = () => page.evaluate(async (id) => (await (await fetch(`/api/u/${id}/me`)).json()) as { timeZone?: string }, userId);
  const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect.poll(async () => (await me()).timeZone).toBe(browserZone);
  await page.goto(`/#/u/${userId}/settings/profile`);
  const section = page.getByRole("region", { name: "Profile" });
  const field = section.getByLabel("Time zone");
  await expect(field).toHaveAttribute("placeholder", browserZone);
  await field.fill("Mars/Olympus");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByText(/isn't a time zone/)).toBeVisible();
  // Saved in a zone far from the browser's, the welcome page's clock moves with it.
  const zone = browserZone === "Pacific/Kiritimati" ? "Etc/GMT+10" : "Pacific/Kiritimati";
  await field.fill(zone);
  await section.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await me()).timeZone).toBe(zone);
  const there = () => page.evaluate((z) => new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()), zone);
  await page.goto(`/#/u/${userId}`);
  const shown = page.locator(".head .cap .num").first();
  await expect.poll(async () => (await shown.textContent()) === (await there())).toBe(true);
  await page.evaluate(async ([id, z]) => { await fetch(`/api/u/${id}/me/profile`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeZone: z }) }); }, [userId, browserZone] as const);
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
  // Hosts and endpoints has no image switches: they are on Image models, where the keyed endpoint's other models wait under Cloud.
  await page.goto(`/#/u/${userId}/models/hosts`);
  const row = page.locator(`[data-endpoint="${ep.id}"]`);
  await row.getByRole("button", { name: /^\d+ models?$/ }).click();
  await expect(row.getByRole("checkbox")).toHaveCount(0);
  await page.goto(`/#/u/${userId}/models/images`);
  const cloud = page.getByRole("region", { name: "Cloud", exact: true });
  await cloud.getByText("Other cloud models").click();
  const controls = cloud.locator(`[data-entry="${model.id}"]`);
  await expect(controls.getByRole("checkbox", { name: "Generate" })).not.toBeChecked();
  await controls.getByRole("checkbox", { name: "Generate" }).click();
  // Switched on, it is one of the group's models, closed; it opens to the same switches.
  const imageRow = cloud.locator(`li.img-row[data-entry="${model.id}"]`);
  await imageRow.locator(".lrow-main").click();
  await expect(imageRow.getByRole("checkbox", { name: "Generate" })).toBeChecked();
  await imageRow.getByRole("checkbox", { name: "Edit" }).click();
  await expect(imageRow.getByRole("checkbox", { name: "Edit" })).toBeChecked();
  await imageRow.getByRole("button", { name: "Fast", exact: true }).click();
  await expect(imageRow.getByRole("button", { name: "Fast", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(imageRow.locator(".lrow-main .meta")).toHaveText("generate · edit");
  // Its star is a text model's: pressed, it stays pressed after a reload.
  await imageRow.getByRole("button", { name: /^Star / }).click();
  await expect(imageRow.getByRole("button", { name: /^Unstar / })).toHaveAttribute("aria-pressed", "true");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/image-switches-${page.viewportSize()!.width}.png` });
  await page.reload();
  await expect(imageRow.getByRole("button", { name: /^Unstar / })).toHaveAttribute("aria-pressed", "true");
  await imageRow.locator(".lrow-main").click();
  await expect(imageRow.getByRole("button", { name: "Fast", exact: true })).toHaveAttribute("aria-pressed", "true");
  await imageRow.getByRole("button", { name: "Quality", exact: true }).click();
  await expect(imageRow.getByRole("button", { name: "Quality", exact: true })).toHaveAttribute("aria-pressed", "true");
  await noHorizontalScroll(page);
  // A thread picks its own image models in Thread settings, from the models that do each.
  await page.goto(`/#/u/${userId}`);
  await newThread(page, "General");
  await send(page, "A quiet pond");
  await expect(page.getByText("You said: A quiet pond")).toBeVisible();
  const settings = await openSettings(page);
  const imagesSelect = settings.getByRole("combobox", { name: /^Images( |$)/ });
  await expect(imagesSelect.locator("option", { hasText: "cloud · art-model · image-switches" })).toHaveCount(1);
  await expect(settings.getByRole("combobox", { name: /^Image upscaling/ }).locator("option", { hasText: "art-model" })).toHaveCount(0);
  await imagesSelect.selectOption({ label: "cloud · art-model · image-switches" });
  await expect(imagesSelect).toHaveValue(model.id);
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
    const response = await fetchReal(route);
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
  await expect(page.getByTitle("Counts every request, cached reads included.").first()).toBeVisible();
  // Input, output and total tokens, then GPU time.
  await expect(page.locator(".usage-head").first()).toHaveText(/^ModelInputOutputTotalCachedGPU time$/);
  await expect(page.getByText("By thread", { exact: true })).toBeVisible();
  await expect(page.getByText("This chat", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/spend-share-${testInfo.project.name}.png` });
  await page.getByRole("link", { name: "Recent calls", exact: true }).last().click();
  // The select, not the thread header's Project button, which can still be on screen while Recent calls opens.
  const filter = page.getByRole("combobox", { name: "Project", exact: true });
  await expect(filter).toHaveValue(`general/${project.id}`);
  await page.reload();
  await expect(filter).toHaveValue(`general/${project.id}`);
  // Recent calls keeps its own project list when the sidebar hides projects.
  await page.evaluate(async userId => {
    await fetch(`/api/u/${userId}/me/display`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projects: "none" }) });
  }, userId);
  await page.reload();
  await expect(filter).toHaveValue(`general/${project.id}`);
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

test("question cards answer in chat and Notifications and close on words", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "ask: How much should we plant?");
  const card = page.locator(".question-card").filter({ hasText: "How much should we plant?" });
  await expect(card.getByRole("button", { name: /^Small/ })).toBeEnabled();
  await expect(card.getByRole("button", { name: /^Small/ })).toHaveClass("primary");
  await expect(card).toContainText("Plant a small bed first.");
  await noHorizontalScroll(page);
  if (phone(page)) for (const button of await card.getByRole("button").all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(Math.round((await button.boundingBox())!.width)).toBe(Math.round((await card.locator(".question-options").boundingBox())!.width));
  }
  const width = page.viewportSize()!.width;
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/question-open-${width}.png` });
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const answered = page.waitForResponse(r => r.request().method() === "POST" && r.url().includes("/questions/"));
  await card.getByRole("button", { name: /^Small/ }).click();
  const answer = await answered;
  expect(answer.status()).toBe(204);
  await expect(card.locator(".question-result")).toHaveText("Small");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(await page.evaluate(async url => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option: 0 }) })).status, answer.url())).toBe(409);
  await page.reload();
  await expect(card.locator(".question-result")).toHaveText("Small");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/question-answered-${width}.png` });
  await send(page, "ask: Which bed comes next?");
  const next = page.locator(".question-card").filter({ hasText: "Which bed comes next?" });
  await expect(next.getByRole("button").first()).toBeEnabled();
  await page.goto(`/#/u/${userId}/notifications`);
  const row = page.locator(".nquestion").filter({ hasText: "Which bed comes next?" });
  await expect(row).toContainText("Plant a small bed first.");
  await expect(row.getByRole("button").first()).toHaveText("SmallRecommended");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/question-notifications-${width}.png` });
  await row.getByRole("button", { name: /^Large/ }).click();
  await expect(row).toHaveCount(0);
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(threadId)}`);
  await expect(next.locator(".question-result")).toHaveText("Large");
  await send(page, "ask: What about the herbs?");
  const herbs = page.locator(".question-card").filter({ hasText: "What about the herbs?" });
  await expect(herbs.getByRole("button").first()).toBeEnabled();
  await send(page, "Use pots for the herbs.");
  // The streamed turn and its stored copy can both show for a moment after a send.
  await expect(herbs).toHaveCount(1);
  await expect(herbs).toContainText("Answered in words.");
  expect(await page.evaluate(async base => (await fetch(`${base}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "[Answer to q:1]" }) })).status, base)).toBe(400);
});


test("project question cards answer in place and withdraw on Resolve", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const project = await page.evaluate(async userId => {
    const r = await fetch(`/api/u/${userId}/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: "general", project: true, title: "Question garden" }) });
    if (!r.ok) throw new Error(`Create project: ${r.status}`);
    return r.json();
  }, userId);
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(project.id)}`);
  await send(page, "start ask: Planting scope");
  const card = page.locator(".tcard").filter({ has: page.locator(".tcard-title", { hasText: "Planting scope" }) });
  await expect(card).toContainText("Waiting on you");
  await expect(card.getByRole("button", { name: /^Small/ })).toBeEnabled();
  const childId = threadIdOf((await card.locator(".tcard-title").getAttribute("href"))!);
  const projectBase = `/api/u/${userId}/threads/general/${encodeURIComponent(project.id)}`;
  await expect.poll(() => page.evaluate(async path => (await (await fetch(path)).json()).busy, projectBase)).toBe(false);
  const wakes = await page.evaluate(async path => {
    const { messages } = await (await fetch(`${path}/messages`)).json();
    return messages.filter((m: { role: string; parts: { type: string; text?: string }[] }) => m.role === "assistant" && m.parts.some(p => p.type === "text" && p.text?.includes("You said: Read the child thread notices"))).length;
  }, projectBase);
  expect(wakes).toBe(1);

  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/question-project-${page.viewportSize()!.width}.png` });
  await card.getByRole("button", { name: /^Small/ }).click();
  await expect(card.locator(".question-card")).toHaveCount(0);
  await expect(card).not.toContainText("Waiting on you");
  expect(page.url()).toContain(encodeURIComponent(project.id));
  await sendTo(page, userId, childId, "ask twice: Which herbs?");
  const childBase = `/api/u/${userId}/threads/general/${encodeURIComponent(childId)}`;
  await expect.poll(() => page.evaluate(async path => (await (await fetch(path)).json()).busy, childBase)).toBe(false);
  await expect.poll(() => page.evaluate(async path => (await (await fetch(`${path}/messages`)).json()).questions.length, childBase)).toBe(3);
  await expect(card.getByRole("button", { name: /^Small/ })).toBeEnabled();
  await card.getByRole("button", { name: "Actions for Planting scope" }).click();
  await card.getByRole("menuitem", { name: "Resolve", exact: true }).click();
  await expect(card).toContainText("Resolved");
  await expect(card).not.toContainText("Waiting on you");
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(childId)}`);
  await expect(page.locator(".question-result").filter({ hasText: "Withdrawn." })).toHaveCount(2);
});


test("private question Notifications keep their pool and answer the card", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "Private");
  await send(page, "ask: Which private garden?");
  await expect(page.locator(".question-card").getByRole("button").first()).toBeEnabled();
  const threadURL = page.url();
  await page.goto(`/#/u/${userId}/notifications`);
  await page.getByRole("combobox", { name: /^Where/ }).selectOption("private");
  const row = page.locator(".nquestion").filter({ hasText: "Which private garden?" });
  await expect(row).toContainText("private");
  await row.getByRole("checkbox").check();
  await expect(page.locator(".bulk").getByRole("button", { name: /^Small|^Large/ })).toHaveCount(0);
  await row.getByRole("button", { name: /^Small/ }).click();
  await expect(row).toHaveCount(0);
  await page.goto(threadURL);
  await expect(page.locator(".question-result")).toHaveText("Small");
});


// Principles 6 and 2: exercise the browser contract with a local receiver only.
// Sender, validation and encrypted persistence are covered by daemon/test/push.test.ts.
test("Push settings: save, test, failure and turn off", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  let status = 204;
  const bodies: string[] = [];
  const receiver = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    res.writeHead(status); res.end();
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address() as { port: number };
  const destination = `http://127.0.0.1:${address.port}/fake-topic`;
  let info: import("../src/api.ts").PushInfo = { host: "", path: "", set: false, token: false, link: false };
  let saved: unknown;
  await page.route(`**/api/u/${userId}/push{,/test}`, async route => {
    const request = route.request();
    if (request.url().endsWith("/test")) {
      const response = await fetch(destination, { method: "POST", body: "Test from Lyrica." });
      if (response.ok) {
        delete info.lastFailure;
        return route.fulfill({ status: 204 });
      }
      info.lastFailure = { at: "2026-10-18T14:02:00Z", status: response.status };
      return route.fulfill({ status: 502, json: { status: response.status, reason: "Receiver refused the push." } });
    }
    if (request.method() === "PUT") {
      saved = request.postDataJSON();
      const data = saved as { url: string; token: string; link: boolean };
      expect(data.url).toBe(destination);
      info = { host: new URL(destination).host, path: "/•••", set: true, token: !!data.token, link: data.link };
    }
    if (request.method() === "DELETE") {
      info = { host: "", path: "", set: false, token: false, link: false };
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: info });
  });
  try {
    await page.goto(`/#/u/${userId}/settings/push`);
    const section = page.getByRole("region", { name: "Push", exact: true });
    const url = section.getByLabel("URL", { exact: true });
    const token = section.getByLabel("Token");
    await expect(section.getByLabel("Include a link")).not.toBeChecked();
    await expect(token).toHaveAttribute("type", "password");
    await url.fill(destination);
    await token.fill("fake-push-token");
    await section.getByLabel("Include a link").check();
    await section.getByRole("button", { name: "Save", exact: true }).click();
    await expect(url).toHaveValue("");
    expect(saved).toEqual({ url: destination, token: "fake-push-token", link: true, origin: baseURL });
    await expect(url).toHaveAttribute("placeholder", `${new URL(destination).host}/•••`);
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute("placeholder", "Set");
    await page.reload();
    await section.getByRole("button", { name: "Send a test" }).click();
    await expect(section.getByRole("status")).toHaveText("Sent");
    expect(bodies).toEqual(["Test from Lyrica."]);
    status = 403;
    await section.getByRole("button", { name: "Send a test" }).click();
    await expect(section.getByText("403: Receiver refused the push.", { exact: true })).toBeVisible();
    const failure = section.getByRole("status").filter({ hasText: "Last push failed" });
    await expect(failure).toContainText("403");
    await expect(failure.locator("time.num")).toHaveAttribute("datetime", "2026-10-18T14:02:00Z");
    await noHorizontalScroll(page);
    if (phone(page)) for (const name of ["Send a test", "Turn off"]) {
      expect(await hitHeight(section.getByRole("button", { name }))).toBeGreaterThanOrEqual(44);
    }
    await section.scrollIntoViewIfNeeded();
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/push-settings-${page.viewportSize()!.width}.png` });
    status = 204;
    await section.getByRole("button", { name: "Send a test" }).click();
    await expect(failure).toHaveCount(0);
    await expect(section.getByRole("status")).toHaveText("Sent");
    await section.getByRole("button", { name: "Turn off" }).click();
    await expect(section.getByRole("button", { name: "Send a test" })).toHaveCount(0);
    await page.reload();
    await expect(url).toHaveAttribute("placeholder", "https://ntfy.sh/<topic>");
    await expect(section.getByLabel("Include a link")).not.toBeChecked();
    await noHorizontalScroll(page);
  } finally {
    await new Promise<void>(resolve => receiver.close(() => resolve()));
  }
});

test("Code mode: thread switch, Coding model and project defaults", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const api = (method: string, path: string, data?: unknown) => page.evaluate(async ({ method, path, data }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return r.json();
  }, { method, path: `/api/u/${userId}${path}`, data });
  const thread = await api("POST", "/threads", { pool: "general", title: "Code fixture", project: true });
  const path = `/threads/general/${encodeURIComponent(thread.id)}`;
  const address = `/#/u/${userId}/t/general/${encodeURIComponent(thread.id)}`;
  const endpoints = await api("GET", "/endpoints");
  const local = endpoints.find((ep: { name: string }) => ep.name === "gpu").models[0].id;
  const cloud = endpoints.find((ep: { name: string }) => ep.name === "router").models.find((m: { modelId: string }) => m.modelId === "cloud-model").id;
  // Different Chat and Coding choices make the header's active task observable. Both are the thread's own,
  // since an earlier test points the General column's Chat at a local model.
  await api("PATCH", `${path}/settings`, { models: { chat: { offeringId: cloud }, code: { offeringId: local } } });
  await page.goto(address);
  let drawer = await openSettings(page);
  const mode = await drawer.getByRole("combobox", { name: "Mode", exact: true }).inputValue();
  await expect(drawer.getByRole("checkbox", { name: "Code mode", exact: true })).not.toBeChecked();
  await drawer.getByRole("checkbox", { name: "Code mode", exact: true }).click();
  await expect.poll(async () => (await api("GET", `${path}/settings`)).code).toBe(true);
  await expect(drawer.getByRole("combobox", { name: "Mode", exact: true })).toHaveValue(mode);
  // One Conversation select edits what answers now: Coding here. A thread's pick replaces the preset's list.
  const conversation = drawer.getByRole("combobox", { name: "Conversation", exact: true });
  await expect(conversation).toHaveValue(local);
  await expect(conversation).toHaveAccessibleDescription("no fallback");
  await expect(drawer.getByRole("combobox", { name: "Main conversation" })).toHaveCount(0);
  await expect(drawer.getByRole("group", { name: "Helpers" }).getByRole("combobox", { name: "Watching threads" })).toBeVisible();
  await expect(drawer.getByRole("group", { name: "Images and speech" }).getByRole("combobox", { name: "Dictation" })).toBeVisible();
  // Thinking: the user's default until the thread picks a level.
  const thinking = drawer.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking.locator("option:checked")).toHaveText("Default (Medium)");
  await thinking.selectOption("off");
  await expect.poll(async () => (await api("GET", `${path}/settings`)).thinkingSet).toBe(true);
  await thinking.selectOption("");
  await expect.poll(async () => (await api("GET", `${path}/settings`)).thinkingSet).toBe(false);
  await drawer.locator(".drawer-body").evaluate((el) => el.scrollTo(0, 0));
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/code-mode-drawer-models-${page.viewportSize()!.width}.png` });
  await drawer.getByRole("checkbox", { name: "Code mode", exact: true }).scrollIntoViewIfNeeded();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/code-mode-thread-${page.viewportSize()!.width}.png` });
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Model:/ })).toContainText("local-model");
  await page.reload();
  drawer = await openSettings(page);
  await expect(drawer.getByRole("checkbox", { name: "Code mode", exact: true })).toBeChecked();
  await drawer.getByRole("checkbox", { name: "Code mode", exact: true }).click();
  await expect.poll(async () => (await api("GET", `${path}/settings`)).code).toBe(false);
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Model:/ })).toContainText("cloud-model");

  await openProjectSettings(page);
  // New threads say what new threads get, and name the coordinator they follow rather than "this chat":
  // the page opens on its own, with no chat in view. The chat's own Model and Mode live in its header, drawer and composer.
  for (const field of ["Model", "Thinking", "Fallback"])
    await expect(page.getByRole("combobox", { name: field, exact: true }).locator("option").first()).toHaveText("Same as coordinator");
  await expect(page.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This chat", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Mode", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Code mode", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await api("GET", path)).projectSettings.threadsCode).toBe(true);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Code mode", exact: true })).toBeChecked();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/code-mode-project-${page.viewportSize()!.width}.png`, fullPage: true });

  await page.goto(`/#/u/${userId}/models/tasks`);
  const coding = page.locator('tr[data-task="code"]');
  await expect(coding.getByRole("cell", { name: "Coding", exact: true })).toContainText("Coding");
  await expect(coding.locator('[data-col="General threads"]')).toContainText("= Strong subagents");
  await coding.locator('[data-col="General threads"]').click();
  await expect(page.getByRole("complementary", { name: "Edit Coding" })).toBeVisible();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/code-mode-models-${page.viewportSize()!.width}.png` });
});

// Near the end of this file: it wipes Ada's memory.
test("Users: Delete user… asks for the box and the password, waits for their work to stop, then removes them", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/delete-user-${name}-${page.viewportSize()!.width}.png` }); };
  const login = `sam${page.viewportSize()!.width}`;
  await page.goto(`/#/u/${userId}/admin/users`);
  await page.getByLabel("Login name").fill(login);
  await page.getByLabel("Display name").fill("Sam");
  await page.getByLabel("Password", { exact: true }).fill("pw2");
  await page.getByRole("button", { name: "Add user" }).click();
  const row = page.locator("li").filter({ hasText: `(${login})` });
  await expect(row).toBeVisible();
  // Your own row has neither Change password… nor Delete user….
  await expect(page.locator("li").filter({ hasText: "(ada)" }).getByRole("button", { name: "Delete user…" })).toHaveCount(0);
  for (const name of ["Change password…", "Delete user…"]) expect(await hitHeight(row.getByRole("button", { name }))).toBeGreaterThanOrEqual(page.viewportSize()!.width < 600 ? 44 : 30);
  if (process.env.SCREENSHOTS) await row.screenshot({ path: `${process.env.SCREENSHOTS}/delete-user-row-${page.viewportSize()!.width}.png` });
  await row.getByRole("button", { name: "Delete user…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Sam?" });
  const remove = dialog.getByRole("button", { name: "Delete user" });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel("I understand this can't be undone").check();
  await expect(remove).toBeDisabled();
  await dialog.getByLabel("Your password").fill("not-mine");
  await noHorizontalScroll(page);
  await shot("confirm");
  await remove.click();
  await expect(dialog.getByRole("alert")).toHaveText("That isn't your password.");
  await dialog.getByLabel("Your password").fill("pw");
  // Their work is running (the server's side is in daemon/test/delete-user.test.ts): the dialog waits until it stops.
  const path = `**/api/u/${userId}/admin/users/*/delete`;
  await page.route(path, (route) => route.fulfill({ json: { deleted: false, busy: [{ kind: "turn", user: "Sam", pool: "general" }] } }));
  await remove.click();
  const waiting = page.getByRole("dialog", { name: "Stopping Sam's work" });
  await expect(waiting.getByRole("status", { name: "Stopping" })).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Delete user" })).toBeDisabled();
  await waiting.locator("summary").click();
  await expect(waiting.getByText("Reply · General")).toBeVisible();
  await shot("stopping");
  await page.unrouteAll();
  await page.getByRole("dialog", { name: "Everything has stopped" }).getByRole("button", { name: "Delete user" }).click();
  await expect(page.getByText("Sam was deleted.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await shot("done");
});

test("Settings → Reset: Wipe my memory asks for the box and the password, then wipes only the user's own", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/wipe-mine-${name}-${page.viewportSize()!.width}.png` }); };
  await newThread(page, "General");
  await send(page, "Something of mine to forget");
  await expect(page.getByText("You said: Something of mine to forget")).toBeVisible();
  // The reply shows before its turn ends; a wipe sent while it runs stops it first and asks again (the next test covers that).
  await expect.poll(async () => page.evaluate(async (path) => ((await (await fetch(path)).json()) as { busy: boolean }[]).some((t) => t.busy), `/api/u/${userId}/threads`)).toBe(false);
  await page.goto(`/#/u/${userId}/settings/reset`);
  await page.getByRole("button", { name: "Wipe my memory…" }).click();
  const dialog = page.getByRole("dialog", { name: "Wipe your memory?" });
  const wipe = dialog.getByRole("button", { name: "Wipe memory" });
  await dialog.getByLabel("I understand this can't be undone").check();
  await expect(wipe).toBeDisabled();
  await dialog.getByLabel("Your password").fill("pw");
  await noHorizontalScroll(page);
  await shot("confirm");
  await wipe.click();
  await expect(page.getByText("Memory wiped.")).toBeVisible();
  const threads = await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/threads`) as unknown[];
  expect(threads).toEqual([]);
});

// Last in this file: it wipes this lyricad's memory.
test("Reset: Wipe memory asks for the box and the password, stops what runs, then wipes", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const shot = async (name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/wipe-${name}-${page.viewportSize()!.width}.png` }); };
  await newThread(page, "General");
  await send(page, "Something to forget");
  await expect(page.getByText("You said: Something to forget")).toBeVisible();
  await page.goto(`/#/u/${userId}/admin/reset`);
  await page.getByRole("button", { name: "Wipe memory…" }).click();
  const dialog = page.getByRole("dialog", { name: "Wipe all memory?" });
  const wipe = dialog.getByRole("button", { name: "Wipe memory" });
  await expect(wipe).toBeDisabled();
  await expect(dialog.getByLabel("Keep everyone's skills")).toBeChecked();
  await dialog.getByLabel("I understand this can't be undone").check();
  await expect(wipe).toBeDisabled();
  await dialog.getByLabel("Your password").fill("not-mine");
  await noHorizontalScroll(page);
  await shot("confirm");
  await wipe.click();
  await expect(dialog.getByRole("alert")).toHaveText("That isn't your password.");
  await dialog.getByLabel("Your password").fill("pw");
  // Something is running (the server's side is in daemon/test/wipe.test.ts): until the polls say it stopped,
  // the dialog waits with a spinner and what it is stopping behind a disclosure.
  const busy = { wiped: false, busy: [{ kind: "turn", user: "Ada", pool: "general" }, { kind: "sleep", user: "Sam" }] };
  await page.route(`**/api/u/${userId}/admin/wipe`, (route) => route.fulfill({ json: busy }));
  await wipe.click();
  const waiting = page.getByRole("dialog", { name: "Stopping everything" });
  await expect(waiting.getByRole("status", { name: "Stopping" })).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Wipe memory" })).toBeDisabled();
  await waiting.locator("summary").click();
  await expect(waiting.getByText("Sleep · Sam")).toBeVisible();
  await shot("stopping");
  await page.unrouteAll();
  const stopped = page.getByRole("dialog", { name: "Everything has stopped" });
  await stopped.getByRole("button", { name: "Wipe memory" }).click();
  await expect(page.getByText("Memory wiped.")).toBeVisible();
  await shot("done");
  const threads = await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/threads`) as unknown[];
  expect(threads).toEqual([]);
});


test("Status model facts preserve existing facts and render empty, measured and missing data without phone overflow", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const displayPath = `/api/u/${userId}/me/display`;
  // The browser holds the session cookie; use its fetch as the other UI tests do.
  const original = await page.evaluate(async (path) => (await (await fetch(path)).json()).display, `/api/u/${userId}/me`);
  const show = (change: unknown) => page.evaluate(async ([path, data]) => {
    const response = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`display: ${response.status} ${await response.text()}`);
  }, [displayPath, change] as const);
  try {
    await show({ showGeneral: false, showPrivate: false });
    await page.goto(`/#/u/${userId}/admin/status`);
    const facts = page.getByRole("region", { name: "Model calls", exact: true });
    await expect(facts).toContainText("No retained calls in the last 24 hours.");
    await expect(facts).toContainText("No pools shown");
    await noHorizontalScroll(page);
    await show({ showGeneral: true, showPrivate: false });
    const modelPort = Number(new URL(baseURL!).port) + 10;
    const seeded = await page.request.post(`http://127.0.0.1:${modelPort}/model-facts-fixture`, { data: { userId } });
    expect(seeded.ok()).toBe(true);
    await page.reload();
    await expect(facts).toContainText("fixture-measured");
    await expect(facts).toContainText("3 calls · Median speed 20 tok/s · 3 measured · Recorded fallbacks 1");
    await expect(facts).toContainText("Unavailable · 0 measured · Recorded fallbacks 0");
    await expect(facts).toContainText("Retained history · General · pruned to latest 500 records per user");
    await expect(page.getByText("Her tools' network", { exact: true })).toBeVisible();
    await expect(page.getByText("Sleep time", { exact: true })).toBeVisible();
    await expect(page.locator("dt").filter({ hasText: "Start unlocked" })).toBeVisible();
    await noHorizontalScroll(page);
    // Changing pool visibility while Status stays open must discard its old aggregate.
    if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
    await page.locator(".showing summary").click();
    const general = page.locator(".showing").getByLabel("General", { exact: true });
    await general.click();
    await expect(general).not.toBeChecked();
    if (phone(page)) await page.getByRole("button", { name: "Hide threads" }).click();
    await expect(facts).toContainText("No pools shown");
    await expect(facts).toContainText("No retained calls in the last 24 hours.");
    await expect(facts).not.toContainText("fixture-measured");
  } finally { await show(original); }
});
