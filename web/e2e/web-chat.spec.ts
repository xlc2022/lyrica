// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// Chats: a thread's messages and cards, its tools and modes, child threads, skills and portraits, uploads.
// Tests run in order on this file's own lyricad per size. web-workspace.spec.ts has the rest of a chat's UI.
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { phone, enter, newThread, send, openSettings, deleteThread, threadIdOf, noHorizontalScroll } from "./helpers.ts";

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

test("a message's menu regenerates, edits, deletes with Undo, and branches", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "first question");
  await expect(page.getByText("You said: first question")).toBeVisible();
  await send(page, "second question");
  await expect(page.getByText("You said: second question")).toBeVisible();
  const menu = (i: number) => page.getByRole("button", { name: "More actions" }).nth(i);
  // The second turn shows live before its stored copy loads; until then her first reply looks like the last turn,
  // so Regenerate goes at once instead of waiting for Undo. Stored, every message has its menu.
  await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(4);

  // Regenerate with another model: her first reply and what followed are replaced, after the Undo delay.
  await menu(1).click();
  await page.getByRole("menuitem", { name: "Regenerate with…" }).click();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/message-menu-${page.viewportSize()!.width}.png` });
  // The model that wrote the reply comes first; the search narrows the list.
  await expect(page.locator(".msg-menu .sub-item").first()).toContainText("cloud-model");
  await page.getByRole("searchbox", { name: "Search models" }).fill("local");
  await expect(page.getByRole("menuitem", { name: /cloud-model/ })).toHaveCount(0);
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
  // The box holds each call's own marker: the tool-call markers, not the recall results a call can bring into the same run.
  const calls = run.locator(".run-body .marker[data-type='tool']");
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

test("her waiting (sleeps that only echo, reads of a thread, a refused read) folds into one run, and a sleep that printed more stays out", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Watch the build");
  await expect(page.getByText("You said: Watch the build")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  let n = 0;
  const at = () => `2026-10-25T04:00:${String(n).padStart(2, "0")}Z`;
  const user = (text: string) => ({ id: `e:${threadId}#${++n}`, n, role: "user", createdAt: at(), parts: [{ type: "text", text }] });
  const hers = (...parts: unknown[]) => ({ id: `e:${threadId}#${++n}`, n, role: "assistant", model: "fake", createdAt: at(), parts });
  const think = { type: "thinking", text: "The child is still working." };
  const bash = (id: string, command: string, result: string) => ({ type: "tool", toolCallId: id, name: "bash", args: { command }, result, isError: false });
  const read = (id: string, result: string, isError = false) => ({ type: "tool", toolCallId: id, name: "threads", args: { action: "read", id: threadId }, result, isError });
  const messages = [
    user("Watch the build"),
    hers(think, bash("s1", "sleep 60 && echo \"done\"", "done")),
    hers(think, read("r1", "Working.")),
    hers(think, bash("s2", "sleep 120 && echo \"done\"", "done")),
    hers(think, read("r2", "You already read this thread twice with these arguments.", true)),
    hers({ type: "text", text: "The build passed." }),
    user("Check the log"),
    hers(bash("s3", "sleep 1; echo done; tail -1 build.log", "done\nok: 412 tests")),
    hers({ type: "text", text: "All 412 passed." }),
  ];
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: { hasMore: false, messages } }));
  await page.reload();
  await expect(page.getByText("All 412 passed.")).toBeVisible();
  const run = page.locator(".marker.tool-run");
  await expect(run).toHaveCount(1);
  await expect(run).toContainText("4 tool calls");
  // The guard turning a read away is about her waiting: the run isn't failed, and no card shows outside it.
  await expect(run).not.toContainText("failed");
  await expect(page.locator(".threads-card")).toHaveCount(0);
  await expect(page.locator(".marker", { hasText: "sleep 60" })).toHaveCount(0);
  // Only her answer has a name line before the person's next message.
  await expect(page.locator(".turn .who-name").filter({ hasText: "fake" })).toHaveCount(2);
  await expect(page.locator(".turn.quiet .marker", { hasText: "tail -1 build.log" })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/waiting-closed-${page.viewportSize()!.width}.png` });
  await run.getByRole("button", { name: /tool calls/ }).click();
  await expect(run.locator(".run-body .marker[data-type='tool']")).toHaveCount(2);
  await expect(run.locator(".run-body .threads-card")).toHaveCount(2);
  await expect(run.locator(".run-body .threads-card .status[data-state='failed']")).toHaveCount(0);
  await expect(run.locator(".run-body .threads-card p.muted")).toContainText("You already read this thread");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/waiting-open-${page.viewportSize()!.width}.png` });
});

test("a run with failed calls counts them after its own count", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Build it");
  await expect(page.getByText("You said: Build it")).toBeVisible();
  const threadId = threadIdOf(page.url());
  const base = `/api/u/${userId}/threads/general/${encodeURIComponent(threadId)}`;
  let n = 0;
  const at = () => `2026-10-30T04:00:${String(n).padStart(2, "0")}Z`;
  const bash = (id: string, command: string, result: string, isError = false) => ({ type: "tool", toolCallId: id, name: "bash", args: { command }, result, isError });
  const hers = (...parts: unknown[]) => ({ id: `e:${threadId}#${++n}`, n, role: "assistant", model: "fake", createdAt: at(), parts });
  const messages = [
    { id: `e:${threadId}#${++n}`, n, role: "user", createdAt: at(), parts: [{ type: "text", text: "Build it" }] },
    hers(bash("b1", "npm install", "added 12 packages")),
    hers(bash("b2", "npm run build", "error TS2304", true)),
    hers(bash("b3", "npm test", "1 failed", true)),
    hers(bash("b4", "git status", "clean")),
    hers({ type: "text", text: "Two steps failed." }),
  ];
  await page.route(`**${base}/messages`, (route) => route.fulfill({ json: { hasMore: false, messages } }));
  await page.reload();
  await expect(page.getByText("Two steps failed.")).toBeVisible();
  const run = page.locator(".marker.tool-run");
  // The count of failed calls, not the word alone, which read as if every call failed.
  await expect(run.getByRole("button")).toHaveText("4 tool calls · 2 failed");
  await expect(run.locator(".state[data-state='failed']")).toHaveText("2 failed");
  if (process.env.SCREENSHOTS) await run.screenshot({ path: `${process.env.SCREENSHOTS}/tool-run-failed-${page.viewportSize()!.width}.png` });
});

test("an open run of tool calls follows her newest call only while its box is at the bottom", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "recall: 24 slowly");
  const run = page.locator(".marker.tool-run");
  await run.getByRole("button", { name: /tool calls running/ }).click();
  const box = run.locator(".run-body");
  const calls = run.locator(".run-body .marker[data-type='tool']");
  await expect.poll(() => box.evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true);
  // At the bottom, the box follows.
  await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
  // Scrolled up, new calls land below without moving it.
  await box.evaluate((el) => { el.scrollTop = 0; });
  const seen = await calls.count();
  await expect.poll(() => calls.count()).toBeGreaterThan(seen + 2);
  expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
  // Back at the bottom, it follows again.
  await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const back = await calls.count();
  await expect.poll(() => calls.count()).toBeGreaterThan(back + 1);
  await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
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

test("deleting the turn that started a child thread lists the thread, ticked, and deletes it with the turn", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "start: Shed list");
  await expect(page.getByText("Started it.")).toBeVisible();
  await expect(page.locator(".threads-card")).toContainText("Child thread: Shed list");
  const menus = page.getByRole("button", { name: "More actions" });
  await menus.last().click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Remove messages" });
  const item = confirm.getByRole("checkbox", { name: "Delete thread Shed list" });
  await expect(item).toBeChecked();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/removal-threads-${page.viewportSize()!.width}.png` });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("start: Shed list", { exact: true })).toHaveCount(0);
  const listed = async () => ((await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/threads`)) as { title?: string }[]).filter((t) => t.title === "Shed list");
  await expect.poll(listed).toEqual([]);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(page.locator(".side").getByText("Shed list", { exact: true })).toHaveCount(0, { timeout: 15_000 });
});

test("a child thread nests under its parent, opens from its card, and goes with its parent when asked", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  // A slow thread list: Delete…, opened before the list counts the new child, counts it once it does,
  // rather than keep the thread as it was listed when the menu opened.
  await page.route(/\/threads$/, async (r) => { if (r.request().method() === "GET") await new Promise((d) => setTimeout(d, 3000)); await r.continue(); });
  await send(page, "start: Seed list");
  await expect(page.getByText("Started it.")).toBeVisible();
  const early = await deleteThread(page);
  await expect(early.getByLabel("Also delete its child thread")).toBeChecked();
  await early.getByRole("button", { name: "Cancel" }).click();
  // Lists still held by the slow route may be on their way; the menu already counted the child from an earlier one.
  await page.unrouteAll({ behavior: "ignoreErrors" });
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

  const dialog = await deleteThread(page);
  await expect(dialog.getByLabel("Also delete its child thread")).toBeChecked();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  // On a failure the message says whether the server still lists the child, or only the sidebar does.
  const listed = async () => ((await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/threads`)) as { title?: string; state?: string; parent?: string }[])
    .filter((t) => t.title === "Seed list");
  await expect(page.locator(".side").getByText("Seed list")).toHaveCount(0).catch(async (e: Error) => { throw new Error(`${e.message}\nThe server lists: ${JSON.stringify(await listed())}`); });
  await noHorizontalScroll(page);
});

test("deleting a thread shows its steps while it runs, and can't be closed until it ends", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Something to delete");
  await expect(page.getByText("You said: Something to delete")).toBeVisible();
  // The delete is held until the test lets it go, and the server says it is on its second step, taking three threads.
  let release = () => {};
  const held = new Promise<void>((go) => { release = go; });
  await page.route(/\/threads\/general\/[^/]+$/, async (r) => { if (r.request().method() === "DELETE") await held; await r.continue(); });
  await page.route(/\/deleting$/, (r) => r.fulfill({ json: { step: "messages", threads: 3 } }));
  const dialog = await deleteThread(page);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  const working = page.getByRole("dialog", { name: /^Deleting / });
  await expect(working.locator("li[aria-current=step]")).toHaveText("Deleting messages and memories");
  await expect(working.locator("li.done")).toHaveText("Stopping its work");
  await expect(working.getByText("3 threads")).toBeVisible();
  await expect(working.getByRole("button")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(working).toBeVisible();
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/delete-progress-${page.viewportSize()!.width}.png` });
  release();
  await expect(working).toHaveCount(0);
  await expect(page.getByText("You said: Something to delete")).toHaveCount(0);
});

test("a message to a child thread, and a read of it, are headed by its title, cut to one line, and by \"a forgotten thread\" once it is gone", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  const title = "Seed bed by the south wall, where the morning sun reaches first, the frost lifts early and the wind from the hill never quite gets in";
  await send(page, `start: ${title}`);
  await expect(page.getByText("Started it.")).toBeVisible();
  await send(page, `tell ${title}: Water it twice.`);
  await expect(page.getByText("Sent it.")).toBeVisible();
  const card = page.locator(".threads-card").filter({ hasText: "Water it twice." });
  const head = card.locator(".sub-head b");
  await expect(head).toHaveText(`Message to ${title}`);
  await expect(head).toHaveAttribute("title", `Message to ${title}`);
  await send(page, `read ${title}`);
  await expect(page.getByText("Read it.")).toBeVisible();
  const readHead = page.locator(".threads-card .sub-head b").filter({ hasText: /^Read / });
  await expect(readHead).toHaveText(`Read ${title}`);
  // One line, cut with an ellipsis, and Open still beside it. On a failure the message says how the head was laid out.
  // Measured again while the list has just replaced the head: the stored turn takes the live one's place after
  // "Sent it.", and a detached element measures 0 with no computed style, which read as "not cut".
  let cut: Record<string, unknown> = {};
  await expect(async () => {
    cut = await head.evaluate((el) => {
      const s = getComputedStyle(el), hidden = el.closest("[hidden], details:not([open])");
      return { connected: el.isConnected, cut: el.scrollWidth > el.clientWidth, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, className: el.className, whiteSpace: s.whiteSpace,
        width: s.width, height: el.getBoundingClientRect().height, card: el.closest(".threads-card")?.getBoundingClientRect().width, hidden: !!hidden, html: el.parentElement?.outerHTML.slice(0, 600) };
    });
    expect(cut.connected, JSON.stringify(cut)).toBe(true);
  }).toPass({ timeout: 5000 });
  expect(cut.cut, JSON.stringify(cut)).toBe(true);
  const open = card.getByRole("link", { name: "Open" });
  await expect(open).toBeVisible();
  // Measured in one step: the list can redraw the card between two boundingBox calls, and a detached element has none.
  expect(await card.evaluate((el) => {
    const middle = (e: Element) => { const r = e.getBoundingClientRect(); return r.y + r.height / 2; };
    return Math.abs(middle(el.querySelector(".sub-head b")!) - middle(el.querySelector(".sub-head a[href]")!));
  })).toBeLessThan(4);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/message-to-thread-${page.viewportSize()!.width}.png` });

  // Forgotten, the card says so and has nothing to open.
  const parentUrl = page.url();
  const childId = threadIdOf((await open.getAttribute("href"))!);
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(childId)}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await (await deleteThread(page)).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toHaveCount(0);
  await page.goto(parentUrl);
  await page.reload();
  await expect(head).toHaveText("Message to a forgotten thread");
  await expect(readHead).toHaveText("Read a forgotten thread");
  await expect(head).not.toHaveAttribute("title");
  await expect(card.getByRole("link", { name: "Open" })).toHaveCount(0);
  // Forget the parent too, so later tests' recall doesn't find these words.
  await (await deleteThread(page)).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).not.toHaveURL(parentUrl);
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
  // The search box takes focus and narrows the list by model and endpoint; Enter picks the first match.
  const search = page.getByRole("dialog").getByRole("searchbox", { name: "Search models" });
  await expect(search).toBeFocused();
  await search.fill("no such model");
  await expect(page.getByRole("dialog")).toContainText("No models match.");
  await search.fill("gpu local");
  await expect(page.getByRole("dialog").getByRole("button", { name: "cloud-model" })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("button", { name: "local-model" })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/model-search-${page.viewportSize()!.width}.png` });
  await search.press("Enter");
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
  // Both new threads are headed "New thread": wait for the general one, or the drawer opens on the private one and closes as it goes.
  await expect(page.locator(".tfacts .k").first()).toHaveText(/general/i);
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

test("a thread making a clip after its turn pulses its sidebar row until the clip ends", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "hello");
  const row = page.locator(".side a.thread[aria-current='page']");
  await expect(row).not.toHaveClass(/\bworking\b/);
  // The daemon marks a thread whose clip is still being made; the list is the only source the row reads.
  let making = true;
  const id = threadIdOf(page.url());
  await page.route(/\/threads$/, async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const list = await (await r.fetch()).json() as { id: string; making?: true }[];
    await r.fulfill({ json: list.map((t) => (t.id === id && making ? { ...t, making: true } : t)) });
  });
  await page.reload();
  await expect(row).toHaveClass(/\bworking\b/);
  await expect(row.locator(".sr-only", { hasText: "working" })).toHaveCount(1);
  making = false;
  await page.reload();
  await expect(row).not.toHaveClass(/\bworking\b/);
  // The list is re-read on every event; a read still in flight would fail the next test.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Allow bypass adds Bypass permissions, where nothing asks, and taking it off moves the thread to Auto", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/settings/network`);
  const allow = page.getByLabel("Allow bypass");
  await expect(allow).not.toBeChecked();
  await expect(page.getByRole("combobox", { name: "Mode", exact: true }).getByRole("option")).toHaveCount(4);
  await expect(page.getByLabel("Allow MCP bypass")).toHaveCount(0);
  await allow.click();
  await expect(allow).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Mode", exact: true }).getByRole("option")).toHaveCount(5);
  // Allow MCP bypass shows only beside Allow bypass, starts off, and turning it on asks first with the risk.
  const mcp = page.getByLabel("Allow MCP bypass");
  await expect(mcp).not.toBeChecked();
  await mcp.click();
  const warn = page.getByRole("dialog", { name: "Allow MCP bypass?" });
  await expect(warn).toContainText("run unattended");
  await warn.getByRole("button", { name: "Cancel" }).click();
  await expect(mcp).not.toBeChecked();
  await mcp.click();
  await page.getByRole("dialog", { name: "Allow MCP bypass?" }).getByRole("button", { name: "Allow" }).click();
  await expect(mcp).toBeChecked();
  await noHorizontalScroll(page);
  await newThread(page, "General");
  await page.locator(".mode-picker").getByRole("button").click();
  const items = page.getByRole("menu", { name: "Mode" }).getByRole("menuitemradio");
  await expect(items).toHaveCount(5);
  await expect(items.last()).toContainText("Commands and file changes never ask.");
  await page.keyboard.press("5");
  await expect(page.locator(".mode-picker")).toContainText("Bypass permissions");
  await noHorizontalScroll(page);
  await send(page, "run: echo bypassed");
  await expect(page.getByText("The command finished.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Allow bash?" })).toHaveCount(0);
  const thread = page.url();
  await page.goto(`/#/u/${userId}/settings/network`);
  await page.getByLabel("Allow bypass").click();
  await expect(page.getByRole("combobox", { name: "Mode", exact: true }).getByRole("option")).toHaveCount(4);
  await expect(page.getByLabel("Allow MCP bypass")).toHaveCount(0);
  // Turning Allow bypass back on doesn't bring Allow MCP bypass back.
  await page.getByLabel("Allow bypass").click();
  await expect(page.getByLabel("Allow MCP bypass")).not.toBeChecked();
  await page.getByLabel("Allow bypass").click();
  await page.goto(thread);
  await expect(page.locator(".mode-picker")).toContainText("Auto");
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
  // While the turn waits, the thread's sidebar row pulses its pool dot; it rests once the turn ends.
  const row = page.locator(".side a.thread[aria-current='page']");
  await expect(row).toHaveClass(/\bworking\b/);
  await prompt.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("The command finished.")).toBeVisible();
  await expect(row).not.toHaveClass(/\bworking\b/);
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

test("a thread opens at its latest message, even when the space above the conversation grows while it loads or content grows after", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, `reply: ${Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the long thread, which keeps going past one line on the way down.`).join("\n\n")}`);
  await expect(page.getByText(/^Line 30 of the long thread/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await newThread(page, "General");
  // The messages come late, and meanwhile the header grows (badges wrapping, the parent's line arriving): the conversation's box shrinks before there is anything to scroll.
  await page.route(/\/messages$/, async (r) => { await new Promise((d) => setTimeout(d, 800)); await r.continue(); });
  await page.route(/\/events$/, async (r) => { await new Promise((d) => setTimeout(d, 2000)); await r.continue(); });
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await page.locator(".side").getByRole("link", { name: /Line 1 of the long thread/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("New thread");
  await expect(page.locator(".scroll .msg")).toHaveCount(0);
  await page.locator(".thread-head").evaluate((el) => { el.style.paddingBottom = "160px"; });
  const scroll = page.locator(".scroll").first();
  const fromBottom = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect(page.getByText(/^Line 30 of the long thread/)).toBeAttached();
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  // Content that grows after it opened (a picture loading, a diagram drawn) keeps it at the bottom.
  await page.locator(".scroll .msg").last().evaluate((el) => { el.style.paddingBottom = "400px"; });
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // Something she opens herself near the foot (a run of tool calls) opens in place: the view doesn't follow it down.
  await page.locator(".scroll .msg").last().evaluate((el) => { el.style.paddingBottom = ""; });
  await send(page, "recall: 6");
  await expect(page.getByText("You said: recall: 6")).toBeVisible();
  // Her turn has finished laying out (its actions row, the facts line) before the marker is measured.
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await expect(page.getByRole("group", { name: "Message actions" }).last()).toBeVisible();
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  const marker = page.locator(".marker.tool-run").last().getByRole("button", { name: /tool calls/ });
  const before = (await marker.boundingBox())!.y;
  await marker.click();
  await expect(page.locator(".marker.tool-run").last().locator(".run-body .marker[data-type='tool']")).toHaveCount(6);
  await page.waitForTimeout(300);
  expect(Math.abs((await marker.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  await expect(marker).toBeInViewport();
});

test("opening a run of calls whose header sits part way above the view leaves the conversation where it was", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "recall: 8");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await send(page, `reply: ${Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of the long thread, which keeps going past one line on the way down.`).join("\n\n")}`);
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  const run = page.locator(".marker.tool-run").getByRole("button", { name: /tool calls/ });
  for (const open of ["true", "false"]) {
    // Its top 10 px out of view: the browser's own scroll anchoring would hold a line below it in place and carry the
    // view down past it (#986).
    await run.evaluate((b) => { const s = b.closest(".scroll")!; s.scrollTop += b.getBoundingClientRect().top - s.getBoundingClientRect().top + 10; });
    await page.waitForTimeout(200);
    // Where the header was when she pressed it: Playwright's click scrolls it into view first, as her own scroll might.
    await run.evaluate((b) => { b.addEventListener("pointerdown", () => { (window as unknown as { at: number }).at = b.getBoundingClientRect().top; }, { once: true }); });
    await run.click();
    await expect(run).toHaveAttribute("aria-expanded", open);
    await page.waitForTimeout(400);
    const at = await page.evaluate(() => (window as unknown as { at: number }).at);
    expect(Math.abs((await run.evaluate((b) => b.getBoundingClientRect().top)) - at)).toBeLessThanOrEqual(2);
  }
});

test("typing while her reply streams leaves the conversation where it is, and opening a run of calls keeps its header where it was pressed", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, `reply: ${Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of the long thread, which keeps going past one line on the way down.`).join("\n\n")}`);
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  const scroll = page.locator(".scroll").first();
  const fromBottom = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  // Every move of the conversation up and away from the bottom while she types, by whatever cause (#986). The tail
  // shrinking a little moves it up too, but leaves it at the bottom.
  await scroll.evaluate((el) => {
    const w = window as unknown as { off: number[]; last: number };
    w.off = []; w.last = el.scrollTop;
    el.addEventListener("scroll", () => {
      const d = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (el.scrollTop < w.last - 1 && d > 2) w.off.push(Math.round(d));
      w.last = el.scrollTop;
    });
  });
  await send(page, "recall: 24 slowly");
  await expect(page.locator(".marker.tool-run").getByRole("button", { name: /tool calls running/ })).toBeVisible();
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  const box = page.getByLabel("Message", { exact: true });
  await box.click();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.type("a few words typed while she works ", { delay: 15 });
    await page.keyboard.press("Shift+Enter");
  }
  expect(await page.evaluate(() => (window as unknown as { off: number[] }).off)).toEqual([]);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  // Opening the run at the tail while it streams: its header stays where she pressed it.
  const marker = page.locator(".marker.tool-run").getByRole("button", { name: /tool calls running/ });
  const before = (await marker.boundingBox())!.y;
  await marker.click();
  await expect(page.locator(".marker.tool-run .run-body")).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(150);
    expect(Math.abs((await marker.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  }
  await expect(marker).toBeInViewport();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 20_000 });
});
