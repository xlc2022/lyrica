// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// Chats: a thread's replies and their counts, routines, the sidebar, skills and portraits, images and clips.
// Tests run in order on this file's own lyricad per size. web-messages.spec.ts has a message's menu and actions,
// tool-call runs, child threads, models and modes; web-workspace.spec.ts has the rest of a chat's UI.
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { phone, enter, newThread, send, threadIdOf, noHorizontalScroll } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

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

test("the request's counts take the dots' place while the prompt is read and she thinks, and leave with her words", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  // SHOTS=<dir> keeps a picture of each line, for a pull request.
  const shot = async (name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}-${phone(page) ? 390 : 1280}.png` }); };
  const line = page.locator(".call-stats");
  await send(page, "prefill slowly: hello");
  await expect(line).toHaveText(/^Reading [\d,]+ of 2,212 new · [\d,.]+ tok\/s$/);
  await expect(line).toHaveAttribute("title", /48\.2k prompt tokens, 46\.0k from cache/);
  await shot("call-stats-reading");
  await expect(line).toHaveText(/^Thinking · \d+ tokens · 38\.4 tok\/s$/);
  await shot("call-stats-thinking");
  await expect(page.getByText("You said: prefill slowly")).toBeVisible();
  await expect(line).toHaveCount(0);
  // A server that says nothing: the prompt's estimate with a clock, then the output Lyrica counts.
  await send(page, "wait slowly: hello");
  await expect(line).toHaveText(/^Prompt [\d,.k]+ · \d+ s$/);
  await shot("call-stats-prompt");
  await expect(line).toHaveText(/^Thinking · ≈\d+ tokens$/);
  await shot("call-stats-counted");
  await expect(page.getByText("You said: wait slowly")).toBeVisible();
  await expect(line).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("under a closed run of tool calls, the request's counts show while she reads and thinks", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "recall: 3 then prefill slowly");
  const run = page.locator(".marker.tool-run");
  await expect(run.getByRole("button", { name: /tool calls running/ })).toHaveAttribute("aria-expanded", "false");
  const line = run.locator(".run-call .call-stats");
  await expect(line).toHaveText(/^Reading [\d,]+ of 2,212 new · [\d,.]+ tok\/s$/);
  await expect(line).toHaveText(/^Thinking · \d+ tokens · 38\.4 tok\/s$/);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/call-stats-run-${phone(page) ? 390 : 1280}.png` });
  await expect(page.getByText("You said: recall: 3")).toBeVisible();
  await expect(page.locator(".call-stats")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("a project chat's Routine fact holds its threads' routines, each linked to its thread", async ({ page, baseURL, request }) => {
  const userId = await enter(page, baseURL!);
  const seeded = await request.post(`http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}/routines-fixture`, { data: { userId, project: true } });
  expect(seeded.ok()).toBe(true);
  const { threadId, projectId } = await seeded.json() as { threadId: string; projectId: string };
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Garden");
  await page.getByRole("button", { name: /^Routine / }).click();
  const pop = page.getByRole("dialog", { name: "Routines", exact: true });
  await expect(pop.locator(".routine-item")).toHaveCount(3);
  await expect(pop.getByRole("link", { name: "Garden checks" }).first()).toHaveAttribute("href", new RegExp(encodeURIComponent(threadId)));
  await expect(pop).not.toContainText("Execution-only");
  await noHorizontalScroll(page);
  // Remove reaches the thread's own routine from here; the fact goes with the last (and the next test starts with none).
  for (let n = 3; n > 0; n--) {
    await pop.locator(".routine-item").first().getByRole("button", { name: /^Remove routine/ }).click();
    if (n > 1) await expect(pop.locator(".routine-item")).toHaveCount(n - 1);
  }
  await expect(page.getByRole("button", { name: /^Routine / })).toHaveCount(0);
});

test("routine titles explain their purpose on focus and touch without exposing instructions", async ({ page, baseURL, request }) => {
  const userId = await enter(page, baseURL!);
  const seeded = await request.post(`http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}/routines-fixture`, { data: { userId } });
  expect(seeded.ok()).toBe(true);
  const { threadId } = await seeded.json() as { threadId: string };
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(threadId)}`);
  const fact = page.getByRole("button", { name: /^Routine / });
  await fact.click();
  const pop = page.getByRole("dialog", { name: "Routines", exact: true });
  await expect(pop.locator(".routine-title").first()).toContainText("Watering review");
  await expect(pop).not.toContainText("Execution-only");
  const title = pop.locator(".routine-title").first();
  if (phone(page)) await title.tap();
  else {
    await title.hover();
    await expect(title.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(title.getByRole("tooltip")).toBeHidden();
    await expect(pop).toBeVisible();
    await page.mouse.move(0, 0);
    await title.focus();
  }
  await expect(title.getByRole("tooltip")).toBeVisible();
  await expect(title.getByRole("tooltip")).toHaveText("Reviews the watering plan for the garden.");
  await page.keyboard.press("Escape");
  await expect(title.getByRole("tooltip")).toBeHidden();
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await fact.click();
  const legacy = pop.locator(".routine-title").last();
  await legacy.click();
  await expect(legacy).toContainText(/^Routine \d+/);
  await expect(legacy).not.toContainText("Garden checks");
  await expect(legacy.getByRole("tooltip")).toHaveText("Runs the saved instructions in a new thread.");
  await noHorizontalScroll(page);
  await page.goto(`/#/u/${userId}/settings/routines`);
  const rows = page.locator(".routine-item");
  await expect(rows).toHaveCount(3);
  await expect(rows.first().getByRole("link", { name: "Garden checks" })).toBeVisible();
  const longTitle = rows.nth(1).locator(".routine-title");
  await longTitle.click();
  const tip = longTitle.getByRole("tooltip");
  await expect(tip).toBeVisible();
  const bounds = await tip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await noHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await rows.nth(1).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(rows.nth(1).getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await rows.nth(1).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(rows.nth(1).getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await rows.last().getByRole("button", { name: /^Remove routine \d+$/ }).click();
  await expect(rows).toHaveCount(2);
});

test("a reply that lands while scrolled up shows a jump-to-latest control that takes the person down to the bottom", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  // A reply long enough to scroll the conversation, so scrolling up means something.
  await send(page, `reply: ${Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} of the reply, which keeps going past one line on the way down.`).join("\n\n")}`);
  const scroll = page.locator(".scroll").first();
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await expect(stop).toBeHidden();
  await page.locator(".scroll").first().evaluate((el) => { el.scrollTop = 0; });
  // Deliver a message while scrolled up; its reply lands below the fold.
  await send(page, "Hello there");
  await expect(page.getByText("You said: Hello there")).toBeVisible();
  const jump = page.getByRole("button", { name: "Jump to latest" });
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOTS) return;
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  await expect(jump).toBeInViewport();
  await shot("jump-to-latest");
  await jump.click();
  // Ends at the bottom, where the control is gone.
  await expect.poll(async () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
  await shot("jump-to-latest-bottom");
  await noHorizontalScroll(page);
});

test("the sidebar's right edge drags wider or narrower, moves with the keyboard, and keeps its width; a phone's slide-over has none", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  const divider = page.getByRole("separator", { name: "Sidebar width" });
  if (phone(page)) {
    await expect(divider).toBeHidden();
    return;
  }
  const side = page.getByRole("complementary", { name: "Threads" });
  await expect(divider).toHaveAttribute("aria-valuenow", "248");
  await divider.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "288");
  expect(Math.round((await side.boundingBox())!.width)).toBe(288);
  await page.reload();
  await expect(divider).toHaveAttribute("aria-valuenow", "288");
  // Dragging left past the minimum stops there; Home goes there too, End to the widest.
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2);
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "200");
  expect(Math.round((await side.boundingBox())!.width)).toBe(200);
  await divider.focus();
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "440");
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "200");
  await page.evaluate(() => localStorage.removeItem("lyrica.sidebar-width"));
  await page.reload();
  await expect(divider).toHaveAttribute("aria-valuenow", "248");
  await noHorizontalScroll(page);
});

test("Settings → Claude Code and Codex shows Codex's own sign-in and then Signed in", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const base = `/api/u/${userId}/codex`;
  // The real route needs the mounted home (FUSE); fake Codex's state here.
  let state: { installed: boolean; signedIn: boolean; signIn?: { url: string; code: string } } = { installed: true, signedIn: false };
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() === "DELETE") state = { installed: true, signedIn: false };
    await route.fulfill({ json: state });
  });
  await page.route(`**${base}/sign-in`, async (route) => {
    state = { installed: true, signedIn: false, signIn: { url: "https://auth.openai.com/codex/device", code: "ABCD-12345" } };
    await route.fulfill({ json: state });
  });
  await page.goto(`/#/u/${userId}/settings/codex`);
  // settings/codex opens the section Codex shares with Claude Code.
  await expect(page.getByRole("link", { name: "Claude Code and Codex" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Claude Code" })).toBeVisible();
  const section = page.getByRole("region", { name: "Codex" });
  await expect(section.getByText("What you ask it for goes to OpenAI.")).toBeVisible();
  await section.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(section.getByRole("status")).toHaveText("Waiting for Codex");
  await expect(section.getByRole("link", { name: "https://auth.openai.com/codex/device" })).toHaveAttribute("target", "_blank");
  await expect(section.locator("code")).toHaveText("ABCD-12345");
  state = { installed: true, signedIn: true };
  await expect(section.getByText("Signed in")).toBeVisible({ timeout: 10_000 });
  await section.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).last().click();
  await expect(section.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await noHorizontalScroll(page);
});

test("her saved skill waits on a card until Approve, then shows in Settings → Skills, where Add skill and Remove work", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  // Private, so its words stay out of later General threads' automatic recall on this server.
  await newThread(page, "Private");
  // The turn's stored copy replaces the live one, remounting the card, while Approve's answer is still on its way (seen in CI):
  // both are held back here so that order always happens, and the card must still end up approved.
  await page.route(/\/messages(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
  await page.route("**/approve", async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue().catch(() => {}); });
  await send(page, "skill: render-check | Before saying a scene renders. | 1. Take a screenshot.");
  await expect(page.getByText("Saved it.")).toBeVisible();
  const card = page.getByRole("group", { name: "Skill render-check" });
  await expect(card).toHaveAttribute("data-pending", "Skill");
  await expect(card.locator(".skill-body")).toHaveCount(0);
  await card.getByRole("button", { name: "Steps" }).click();
  await expect(card.getByRole("button", { name: "Steps" })).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".skill-body")).toHaveText("1. Take a screenshot.");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText(/In .*'s skills/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await page.goto(`/#/u/${userId}/settings/skills`);
  const section = page.getByRole("region", { name: "Skills" });
  await expect(section.getByRole("heading", { name: "Skills" })).toHaveAttribute("title", /^Procedures for jobs that come up again\./);
  await expect(section.locator(".skill")).toHaveCount(1);
  await expect(section.locator(".skill").first()).toContainText("render-check");
  await section.getByRole("button", { name: "Add skill" }).click();
  await section.getByLabel("Name").fill("Release Notes");
  await expect(section.getByText(/A name is lowercase letters/)).toBeVisible();
  await expect(section.getByRole("button", { name: "Save" })).toBeDisabled();
  await section.getByLabel("Name").fill("release-notes");
  await section.getByLabel("When to use it").fill("When writing a release's notes.");
  await section.getByLabel("Steps").fill("List what changed, newest first.");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.locator(".skill")).toHaveCount(2);
  await expect(section.locator(".skill").first()).toContainText("Yours");
  // Export all downloads both as one file, and importing it again finds them already here.
  await section.getByRole("button", { name: "More skill actions" }).click();
  const saving = page.waitForEvent("download");
  await section.getByRole("menuitem", { name: "Export all" }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toMatch(/^lyrica-skills-.*\.md$/);
  await section.getByRole("button", { name: "More skill actions" }).click();
  await section.getByRole("menuitem", { name: "Import…" }).click();
  await section.locator("form.import-skills input[type=file]").setInputFiles(await file.path());
  await section.locator("form.import-skills").getByRole("button", { name: "Import" }).click();
  await expect(section.getByRole("status")).toHaveText("Nothing new to import · 2 already here");
  await section.getByRole("button", { name: "Done" }).click();
  await section.locator(".skill").first().getByRole("button", { name: "Remove" }).click();
  await section.getByRole("group", { name: "Remove" }).getByRole("button", { name: "Remove" }).click();
  await expect(section.locator(".skill")).toHaveCount(1);
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
  await expect(nav.getByRole("link").nth(-2)).toHaveText("Portrait photos");
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
      askedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }] : [],
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

test("a message waiting behind her turn has Steer now while she works, and it sends it into the turn", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Plan the garden");
  await expect(page.getByText("You said: Plan the garden")).toBeVisible();
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadIdOf(page.url()))}`;
  let busy = true;
  const steered: string[] = [];
  await page.route(`**${base}/events`, (route) => route.fulfill({ contentType: "text/event-stream",
    body: `event: hello\ndata: ${JSON.stringify({ type: "hello", busy, queued: ["Use the blue tiles instead"], permissions: [] })}\n\n` }));
  await page.route(`**${base}/queue/*/steer`, (route) => { steered.push(`${new URL(route.request().url()).pathname} ${route.request().postDataJSON().text}`); return route.fulfill({ json: { ok: true } }); });
  await page.reload();
  const waiting = page.locator(".msg.user.queued");
  await expect(waiting).toContainText("Use the blue tiles instead");
  const steer = waiting.getByRole("button", { name: "Steer now" });
  await expect(steer).toHaveAttribute("title", /turn after her current step, instead of when the turn ends\.$/);
  // Only the waiting parts fade: the link stays full strength.
  expect(await steer.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/steer-now-${page.viewportSize()!.width}.png` });
  await steer.click();
  await expect.poll(() => steered).toEqual([`${base}/queue/0/steer Use the blue tiles instead`]);
  // With no turn running, the message just waits: nothing to steer.
  busy = false;
  await page.reload();
  await expect(page.locator(".msg.user.queued")).toContainText("Use the blue tiles instead");
  await expect(page.getByRole("button", { name: "Steer now" })).toHaveCount(0);
});

/** A solid square PNG of one colour, so each attempt looks different in a screenshot. */
function solidPng(r: number, g: number, b: number, size = 96): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("her rejected attempts fold into one closed group, and her pick shows last on its own", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "A lantern by a pond");
  await expect(page.getByText("You said: A lantern by a pond")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const at = (c: string) => `/workspace/images/${c.repeat(8)}-0000-0000-0000-000000000000.png`;
  const [a, b, c] = [at("a"), at("b"), at("c")];
  const colours: Record<string, Buffer> = { a: solidPng(200, 80, 60), b: solidPng(70, 120, 200), c: solidPng(60, 160, 90) };
  const make = (id: string, path: string) => [
    { type: "tool", toolCallId: id, name: "image", args: { action: "create", tier: "fast", prompt: "A lantern by a pond" }, result: path, isError: false },
    { type: "image", paths: [path], model: "box/Z-Image", tier: "fast" },
  ];
  const reject = (id: string, path: string) => ({ type: "tool", toolCallId: id, name: "image", args: { action: "reject", images: [path] }, result: "Rejected", isError: false });
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: {
    messages: [
      { id: `e:${threadId}#0`, n: 0, role: "user", createdAt: "2026-10-26T12:00:00Z", parts: [{ type: "text", text: "A lantern by a pond" }] },
      { id: `e:${threadId}#1`, n: 1, role: "assistant", createdAt: "2026-10-26T12:00:01Z", parts: make("m1", a) },
      { id: `e:${threadId}#2`, n: 2, role: "assistant", createdAt: "2026-10-26T12:00:02Z", parts: [reject("r1", a), ...make("m2", b)] },
      { id: `e:${threadId}#3`, n: 3, role: "assistant", createdAt: "2026-10-26T12:00:03Z", parts: [reject("r2", b), ...make("m3", c), { type: "text", text: "The third one has the lantern's glow on the water." }] },
    ], hasMore: false,
  } }));
  await page.route(`**${base}/files/thumb?*`, (route) => route.fulfill({ status: 404 }));
  await page.route(`**${base}/file?*`, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    route.fulfill({ contentType: "image/png", body: colours[path.split("/").at(-1)![0]!] ?? colours.a });
  });
  await page.reload();
  const group = page.getByRole("button", { name: "2 rejected" });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  // Only the last attempt shows full size; the rejects, and the turns that made and set them aside, are folded away.
  await expect(page.locator(".turn .message-image")).toHaveCount(1);
  await expect(page.getByRole("img", { name: c.split("/").at(-1)! })).toBeVisible();
  // The last message's reject of the second attempt folds too; its making call, image and words stay.
  await expect(page.getByRole("button", { name: "Rejecting an image" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Making an image" })).toHaveCount(1);
  await expect(page.getByText("The third one has the lantern's glow on the water.")).toBeVisible();
  // Closed, the marker stands for the folded messages: it has the first one's id and names them all.
  await expect(page.locator("#m-1.rejected-run")).toHaveAttribute("data-folds", "1 2 3");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ fullPage: true, path: `${process.env.SCREENSHOTS}/rejects-closed-${page.viewportSize()!.width}.png` });
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  const rejected = page.locator(".rejected-body img");
  await expect(rejected).toHaveCount(2);
  await expect(rejected.first()).toHaveAttribute("src", `${base}/file?path=${encodeURIComponent(a.replace("/images/", "/images/rejected/"))}`);
  // Open, the fold shows the two turns that made the rejects and the last message's reject, with their markers, and no third image.
  await expect(page.locator(".rejected-turns .turn")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Making an image" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Rejecting an image" })).toHaveCount(2);
  await expect(page.locator(".rejected-turns .message-image")).toHaveCount(0);
  await expect(page.locator("#m-1")).toHaveCount(1);
  await expect(page.locator(".rejected-turns #m-1")).toHaveCount(1);
  await expect(page.locator("#m-3")).toHaveCount(1);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ fullPage: true, path: `${process.env.SCREENSHOTS}/rejects-open-${page.viewportSize()!.width}.png` });
});

test("a clip she made shows its poster and facts, and plays in the browser's player", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "A fox in the snow");
  await expect(page.getByText("You said: A fox in the snow")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const path = "/workspace/videos/fox.mp4";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: {
    messages: [{ id: `e:${threadId}#1`, n: 1, role: "assistant", createdAt: "2026-10-28T04:00:00Z", parts: [
      { type: "tool", toolCallId: "fox", name: "image", args: { action: "video", prompt: "A fox in the snow" }, result: path, isError: false },
      { type: "video", path, model: "shared.box/Wan 2.2 TI2V 5B", width: 1280, height: 704, duration: 5.04, audio: true },
    ] }, { id: `e:${threadId}#2`, n: 2, role: "assistant", createdAt: "2026-10-28T04:10:00Z", parts: [
      { type: "tool", toolCallId: "cat", name: "image", args: { action: "video", prompt: "A cat on a roof" }, result: "Making the clip in the background; it takes minutes.", isError: false },
      { type: "text", text: "It's on its way." },
    ] }, { id: `e:${threadId}#3`, n: 3, role: "notice", createdAt: "2026-10-28T04:20:00Z", parts: [
      { type: "delegation", text: "The clip failed: the host ran out of memory.", status: "clip-failed" },
    ] }, { id: `e:${threadId}#4`, n: 4, role: "assistant", createdAt: "2026-10-28T04:30:00Z", parts: [
      { type: "tool", toolCallId: "owl:made", name: "image", args: { action: "animate", image: "/workspace/uploads/owl.png", prompt: "The owl turns its head" }, result: "The clip is ready. Made with Clip on box.", isError: false },
      { type: "video", path: "/workspace/videos/owl.mp4", model: "shared.box/Wan 2.2 TI2V 5B", width: 704, height: 704, duration: 5.04, audio: false },
    ] }], hasMore: false,
  } }));
  await page.route(`**${base}/files/thumb?*`, (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route(`**${base}/file?*`, (route) => route.fulfill({ contentType: "video/mp4", body: Buffer.alloc(0) }));
  await page.reload();
  // A clip still being made in the background: its call only started it.
  await expect(page.getByText("Making a clip started", { exact: true })).toBeVisible();
  // One that failed there is a notice headed Clip, failed, with the reason.
  const failed = page.locator(".subagent.delivered[data-status='clip-failed']");
  await expect(failed.locator("b")).toHaveText("Clip");
  await expect(failed).toContainText("failed");
  await expect(failed).toContainText("The clip failed: the host ran out of memory.");
  // One made in the background keeps its call's marker above it, which opens to the prompt it was made from.
  const owl = page.getByRole("button", { name: "Animating an image done" });
  await owl.click();
  await expect(owl).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".marker-body pre").first()).toContainText("The owl turns its head");
  await expect(page.getByRole("button", { name: "Play owl.mp4" })).toBeVisible();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) { await owl.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SCREENSHOTS}/clip-call-${page.viewportSize()!.width}.png` }); }
  await owl.click();
  const play = page.getByRole("button", { name: "Play fox.mp4" });
  await expect(play).toBeVisible();
  await expect(page.getByText("Made with box/Wan 2.2 TI2V 5B · 5.0 s · sound", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clip actions for fox.mp4" }).click();
  await expect(page.getByRole("menuitem", { name: "Download" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeVisible();
  await page.keyboard.press("Escape");
  if (process.env.SCREENSHOTS) await page.screenshot({ fullPage: true, path: `${process.env.SCREENSHOTS}/clip-${page.viewportSize()!.width}.png` });
  await play.click();
  await expect(page.getByLabel("fox.mp4", { exact: true })).toHaveAttribute("src", `${base}/file?path=${encodeURIComponent(path)}`);
  await expect(play).toHaveCount(0);
});

test("an image or clip being made shows a card at its shape with how far it has got, until it arrives", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "A garden at dusk");
  await expect(page.getByText("You said: A garden at dusk")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: {
    messages: [{ id: `e:${threadId}#1`, n: 1, role: "assistant", createdAt: "2026-10-29T04:00:00Z", parts: [
      { type: "tool", toolCallId: "garden", name: "image", args: { action: "create", tier: "quality", prompt: "A garden at dusk", aspectRatio: "16:9" } },
    ] }, { id: `e:${threadId}#2`, n: 2, role: "assistant", createdAt: "2026-10-29T04:01:00Z", parts: [
      { type: "tool", toolCallId: "cat", name: "image", args: { action: "video", prompt: "A cat on a roof" }, result: "Making the clip in the background; it takes minutes.", isError: false },
      { type: "text", text: "It's on its way." },
    ] }, { id: `e:${threadId}#3`, n: 3, role: "assistant", createdAt: "2026-10-29T04:02:00Z", parts: [
      { type: "tool", toolCallId: "pond", name: "image", args: { action: "create", tier: "fast", prompt: "A pond", count: 2 } },
    ] }], hasMore: false,
  } }));
  let making: object[] = [
    { toolCallId: "garden", startedAt: ago(75), progress: 0.95, stage: "decoding" },
    { toolCallId: "cat", startedAt: ago(200), queued: true },
    { toolCallId: "pond", startedAt: ago(83) },
  ];
  await page.route(`**${base}/events`, (route) => route.fulfill({ contentType: "text/event-stream",
    body: `event: hello\ndata: ${JSON.stringify({ type: "hello", busy: true, queued: [], permissions: [], making })}\n\n` }));
  await page.reload();
  const garden = page.getByRole("progressbar", { name: "Making an image" }).first();
  // Past sampling, the stage stands beside the percent.
  await expect(garden).toHaveAttribute("aria-valuenow", "95");
  await expect(garden).toHaveAttribute("aria-valuetext", "95%, decoding");
  await expect(garden).toContainText("95% · Decoding");
  // At the shape asked for, at most 420 px wide and 320 px tall.
  const box = (await garden.boundingBox())!;
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
  expect(box.width).toBeLessThanOrEqual(422);
  // A clip waiting for the host's GPU says so; one with no progress counts the time since it started.
  await expect(page.getByRole("progressbar", { name: "Making a clip" })).toContainText("Waiting");
  const pond = page.locator(".making-cards").nth(2);
  await expect(pond.locator(".making")).toHaveCount(2);
  await expect(pond.getByRole("progressbar")).toHaveText(/^1:2\d$/);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) {
    await garden.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/making-top-${page.viewportSize()!.width}.png` });
    await pond.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/making-${page.viewportSize()!.width}.png` });
  }
  // Once nothing is being made, the cards go.
  making = [];
  await page.reload();
  await expect(page.getByText("It's on its way.")).toBeVisible();
  await expect(page.locator(".making")).toHaveCount(0);
});

test("an image tool result shows inline, opens large, starts an edit with Images enabled, and deletes after asking", async ({ page, baseURL }) => {
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
  const editing = page.getByRole("button", { name: /^Editing an image\b/ });
  // The state word follows the label a plain space apart, not the pill's wider flex gap.
  await expect(editing).toHaveText("Editing an image failed");
  await editing.click();
  await expect(page.locator(".tool-error")).toHaveText("The image host is offline.");
  await expect(page.getByRole("button", { name: "Upscaling an image" })).toBeVisible();
  await image.click();
  const lightbox = page.getByRole("dialog", { name: "garden.png" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".fname")).toHaveText("garden.png");
  await expect(lightbox.getByRole("img")).toHaveAttribute("src", `${base}/file?path=${encodeURIComponent(path)}`);
  // Download and Copy path are buttons in its header, not behind a menu; Copy path reads Copied once it copies.
  await expect(lightbox.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expect(lightbox.getByRole("button", { name: "Image actions", exact: true })).toHaveCount(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  await lightbox.getByRole("button", { name: "Copy path", exact: true }).click();
  await expect(lightbox.getByRole("button", { name: /^(Copied|Copy failed)$/ })).toBeVisible();
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
  await page.getByRole("button", { name: "Attach or switch tools" }).click();
  // Delete… asks first; Cancel keeps it, Delete removes the file and leaves a line in its place.
  let deleted: unknown;
  await page.route(`**${base}/files/delete`, async (route) => { deleted = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); });
  await page.getByRole("button", { name: "Image actions for garden.png" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete garden.png?" });
  await expect(confirm.getByText("garden.png is deleted for good. This can't be undone.")).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(image).toBeVisible();
  expect(deleted).toBeUndefined();
  await page.getByRole("button", { name: "Image actions for garden.png" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete garden.png?" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("No longer in Files")).toBeVisible();
  await expect(image).toBeHidden();
  expect(deleted).toEqual({ paths: [path] });
  await noHorizontalScroll(page);
});

test("an image a command made, named by a link in her words, shows its thumbnail under the paragraph and opens large", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Upscale it 8x");
  await expect(page.getByText("You said: Upscale it 8x")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const path = "/workspace/images/ecee7342-8x.png";
  const png = solidPng(200, 80, 60);
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: {
    messages: [{ id: `e:${threadId}#1`, n: 1, role: "assistant", createdAt: "2026-11-09T01:20:00Z", parts: [
      { type: "tool", toolCallId: "up", name: "bash", args: { command: "cd /workspace/images && magick 531ac8cd.png -resize 800% ecee7342-8x.png" }, result: "", isError: false },
      { type: "text", text: `Done — [ecee7342-8x.png](${path}), 7295×9216, 46 MB. The source is /workspace/images/531ac8cd.png.` },
    ] }], hasMore: false,
  } }));
  // The thumbnail is the server's small copy, never the 46 MB file; the lightbox shows the file itself.
  const asked: string[] = [];
  await page.route(`**${base}/files/thumb?*`, (route) => { asked.push(new URL(route.request().url()).searchParams.get("path") ?? ""); return route.fulfill({ contentType: "image/png", body: png }); });
  await page.route(`**${base}/files/content?*`, (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.reload();
  const words = page.locator(".turn .prose p", { hasText: "Done —" });
  await expect(words).toContainText("Done — ecee7342-8x.png, 7295×9216, 46 MB.");
  await expect(words.getByRole("link", { name: "ecee7342-8x.png" })).toBeVisible();
  const thumbs = page.locator(".turn .linked-images .inline-img");
  await expect(thumbs).toHaveCount(2);
  const eight = page.getByRole("button", { name: "ecee7342-8x.png, open large" });
  await expect(eight).toBeVisible();
  await expect(eight.getByRole("img")).toHaveAttribute("src", `${base}/files/thumb?path=${encodeURIComponent(path)}`);
  expect(asked).toContain(path);
  if (process.env.SCREENSHOTS) await page.screenshot({ fullPage: true, path: `${process.env.SCREENSHOTS}/linked-image-${page.viewportSize()!.width}.png` });
  await eight.click();
  const lightbox = page.getByRole("dialog", { name: "ecee7342-8x.png" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole("img")).toHaveAttribute("src", `${base}/files/content?path=${encodeURIComponent(path)}`);
  await lightbox.getByRole("button", { name: "Close", exact: true }).click();
  await expect(lightbox).toBeHidden();
  await noHorizontalScroll(page);
});

test("a read call's card lays out the file it read: code keeps its indentation, Markdown renders, an image shows small", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Look at my files");
  await expect(page.getByText("You said: Look at my files")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  const code = "export function add(a: number, b: number) {\n    if (a < 0) {\n        return b;\n    }\n    return a + b;\n}";
  const md = "# Plan\n\n- **Build** the page\n- Test it";
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><rect width='640' height='360' fill='#2b6cb0'/><circle cx='320' cy='180' r='120' fill='#f3f5f5'/></svg>";
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: {
    messages: [{ id: `e:${threadId}#1`, n: 1, role: "assistant", createdAt: "2026-10-12T12:00:00Z", parts: [
      { type: "tool", toolCallId: "r-code", name: "read", args: { path: "src/add.ts" }, result: `${code}\n\n[Showing lines 1-6 of 90. Use offset=7 to continue.]`, isError: false },
      { type: "tool", toolCallId: "r-md", name: "read", args: { path: "/workspace/plan.md" }, result: md, isError: false },
      { type: "tool", toolCallId: "r-png", name: "read", args: { path: "/workspace/view2/final_z.png" }, result: "Read image file [image/png]", isError: false },
      { type: "tool", toolCallId: "r-gone", name: "read", args: { path: "/workspace/old.png" }, result: "Read image file [image/png]", isError: false },
    ] }], hasMore: false,
  } }));
  await page.route(`**${base}/files/thumb?*`, (route) => route.fulfill({ status: 404 }));
  await page.route(`**${base}/files/content?*`, (route) => new URL(route.request().url()).searchParams.get("path") === "/workspace/old.png"
    ? route.fulfill({ status: 404, json: { error: "/workspace/old.png is not a file" } })
    : route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.reload();
  const run = page.locator(".marker.tool-run");
  await run.getByRole("button", { name: /tool calls/ }).click();
  for (const name of [/src\/add\.ts/, /plan\.md/, /final_z\.png/, /old\.png/]) await run.getByRole("button", { name }).click();
  // Code keeps its lines and indentation, with pi's note under it and the file's name linking into Files.
  const read = run.locator(".read-text");
  await expect(read.nth(0).locator("pre")).toHaveText(code);
  expect(await read.nth(0).locator("pre").evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("pre");
  await expect(read.nth(0).locator(".read-note")).toHaveText("Showing lines 1-6 of 90");
  await expect(read.nth(0).locator(".read-note .num")).toHaveText(["1", "6", "90"]);
  await expect(read.nth(0).getByRole("link", { name: "add.ts" })).toBeVisible();
  await expect(read.nth(1).getByRole("heading", { name: "Plan" })).toBeVisible();
  await expect(read.nth(1).locator("strong")).toHaveText("Build");
  const image = run.getByRole("button", { name: "final_z.png", exact: true });
  await expect(image.getByRole("img")).toHaveAttribute("src", `${base}/files/content?path=${encodeURIComponent("/workspace/view2/final_z.png")}`);
  await expect(run.getByText("No longer in Files")).toBeVisible();
  if (process.env.SCREENSHOTS) {
    const calls = run.locator(".run-body > .marker");
    for (const [i, name] of ["code", "markdown", "image"].entries()) await calls.nth(i).screenshot({ path: `${process.env.SCREENSHOTS}/read-${name}-${page.viewportSize()!.width}.png` });
  }
  await image.click();
  await expect(page.getByRole("dialog", { name: "final_z.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await noHorizontalScroll(page);
});
