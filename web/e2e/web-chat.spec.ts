// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// Chats: a thread's messages, its tools and modes, search, memory, accounts and machines.
// Tests run in order on this file's own lyricad per size.
import { expect, test } from "@playwright/test";
import { phone, enter, newThread, send, openSettings, togglePrivate, threadIdOf, sendTo, hitHeight, noHorizontalScroll } from "./helpers.ts";

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
  const userId = await enter(page, baseURL!);
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
  // On a failure the message says whether the server still lists the child, or only the sidebar does.
  const listed = async () => ((await page.evaluate(async (path) => (await fetch(path)).json(), `/api/u/${userId}/threads`)) as { title?: string; state?: string; parent?: string }[])
    .filter((t) => t.title === "Seed list");
  await expect(page.locator(".side").getByText("Seed list")).toHaveCount(0).catch(async (e: Error) => { throw new Error(`${e.message}\nThe server lists: ${JSON.stringify(await listed())}`); });
  await noHorizontalScroll(page);
});

test("a message to a child thread is headed by its title, cut to one line, and by \"a forgotten thread\" once it is gone", async ({ page, baseURL }) => {
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
  const drawer = await openSettings(page);
  await drawer.getByRole("button", { name: "Forget this thread" }).click();
  await drawer.getByRole("button", { name: "Forget it" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toHaveCount(0);
  await page.goto(parentUrl);
  await page.reload();
  await expect(head).toHaveText("Message to a forgotten thread");
  await expect(head).not.toHaveAttribute("title");
  await expect(card.getByRole("link", { name: "Open" })).toHaveCount(0);
  // Forget the parent too, so later tests' recall doesn't find these words.
  const parent = await openSettings(page);
  await parent.getByRole("button", { name: "Forget this thread" }).click();
  await parent.getByRole("button", { name: "Forget it" }).click();
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

  // Near the window's right edge, as in a side panel, the popover slides left to stay inside it.
  if (!phone(page)) {
    await meter.evaluate((el) => Object.assign(el.parentElement!.style, { position: "fixed", right: "20px", top: "120px" }));
    await meter.click();
    const box = (await popover.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16 + 0.5);
    await noHorizontalScroll(page);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/context-edge-${page.viewportSize()!.width}.png` });
    await page.keyboard.press("Escape");
  }
});

test("her compaction's card and the stored marker open to the summary, closed until tapped", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  // Private, so the general threads of later tests don't recall these messages.
  await newThread(page, "Private");
  await send(page, "Plant the tomatoes first");
  await expect(page.getByText("You said: Plant the tomatoes first")).toBeVisible();
  // Over the 20k tokens Pi keeps, so the first exchange is compacted.
  await send(page, `Notes on the beds. ${"The beds are by the fence. ".repeat(4500)}`);
  await expect(page.getByText("You said: Notes on the beds.")).toBeVisible();
  // Long enough (400 characters) to be hers rather than notes for Pi's own.
  const summary = `We are planning the garden. ${"The tomatoes go in the sunny bed by the fence, and the beans follow. ".repeat(7)}Open question: when to water.`;
  await send(page, `compact: ${summary}`);
  await expect(page.getByText("Compacting.")).toBeVisible();
  const card = page.locator(".compaction");
  const head = card.getByRole("button", { name: "Compaction" });
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByText("Open question: when to water.")).toHaveCount(0);
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByText("Open question: when to water.")).toBeVisible();
  // The stored compaction, once the messages reload after the turn.
  const marker = page.locator('.marker[data-type="compacted"] > button');
  await expect(marker).toHaveText(/^Compacted · \S+/);
  await expect(marker).toHaveAttribute("aria-expanded", "false");
  await expect(marker.locator(".num").first()).toHaveCSS("font-family", /Plex Mono|monospace/);
  await marker.click();
  await expect(page.locator('.marker[data-type="compacted"] .marker-body')).toContainText("Open question: when to water.");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/compaction-${page.viewportSize()!.width}.png`, fullPage: true });
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
  // Polled, because the header reflows while her stored reply and the mono font come in; a line that stays wrapped still fails.
  const oneLine = async () => {
    if (!phone(page)) return;
    for (const who of [mine, hers]) {
      await expect.poll(async () => {
        const [time, line] = await Promise.all([who.locator("time").boundingBox(), who.boundingBox()]);
        return !!time && !!line && Math.abs(time.y - line.y) < time.height && line.height < time.height * 2;
      }).toBe(true);
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

test("memories export as Markdown and import back, skipping what is already there", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("button", { name: "Add a memory" }).click();
  await page.getByLabel("Text").fill("Marigold seeds keep in a tin.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const article = page.locator("article.mem-item");
  await expect(article).toContainText("Marigold seeds");

  // The memory's ⋯ downloads it as a Markdown file.
  await article.getByRole("button", { name: "More actions" }).click();
  const saving = page.waitForEvent("download");
  await article.getByRole("menuitem", { name: "Export" }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toMatch(/^marigold-seeds.*\.md$/);
  const path = await file.path();

  // Importing it again finds it already there.
  await page.goto(`/#/u/${userId}/memory`);
  await page.getByRole("button", { name: "Add a memory" }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const form = page.locator("form.import-memory");
  await expect(form.getByLabel("Pool")).toHaveValue("");
  await form.locator("input[type=file]").setInputFiles(path);
  await form.getByRole("button", { name: "Import" }).click();
  await expect(page.getByRole("status")).toHaveText("Nothing new to import · 1 already here");
  await page.getByRole("button", { name: "Done" }).click();
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

// The changes view (docs/ux.md §6): the daemon's git reads need a sandbox, so the routes are answered here with a
// branch as a thread would have it; what the badge and the dialog make of them is the real UI.
test("a project thread's chips: its checklist's count, its pull request with Draft and the checks' dot and its subagents, in the threads list's rows and on its card", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const project = await page.evaluate(async (userId) => {
    const res = await fetch(`/api/u/${userId}/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: "general", project: true, title: "Herb garden" }) });
    return (await res.json()) as { id: string };
  }, userId);
  // The overview as the daemon would send it once the forge watcher polled a pull request and a delegate call ran: the fake model does neither.
  const pull = { repo: "garden/controller", number: 430, head: "f50fa8601e5b4c9d8a3f2e1d0c9b8a7f6e5d4c3b", url: "https://github.com/garden/controller/pull/430", draft: true, checks: [{ name: "tests", result: "passed" }, { name: "typecheck", result: null }] };
  const steps = [{ text: "Read the brief", state: "done" }, { text: "Write the plan", state: "doing" }, { text: "Check it", state: "todo" }];
  await page.route("**/overview", async (route) => {
    // The page reloads the overview on its own; one still in flight when the test ends must not fail it.
    try {
      const json = await (await route.fetch()).json() as { threads: object[] };
      await route.fulfill({ json: { ...json, threads: json.threads.map((t) => ({ ...t, title: "Plan the herb beds and the watering", steps, pull, subagents: 2 })) } });
    } catch { await route.continue().catch(() => {}); }
  });
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(project.id)}`);
  await page.getByRole("button", { name: "Make a plan", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
  await page.goto(`/#/u/${userId}/t/general/${encodeURIComponent(project.id)}`);
  const card = page.locator(".tcard").filter({ has: page.locator(".tcard-title", { hasText: "Plan" }) });
  await expect(card).toBeVisible();
  // On the card the checklist keeps its own button, the pull request is a link to it, and the subagents are counted.
  await expect(card.locator(".tcard-count .link")).toHaveText("1 of 3");
  await expect(card.locator(".tchips .chip")).toHaveCount(2);
  const link = card.locator("a.chip.pull");
  await expect(link).toHaveText("#430 Draft, checks running");
  await expect(link).toHaveAccessibleName("Pull request #430, draft, checks running");
  await expect(link.locator(".draft")).toBeVisible();
  await expect(link).toHaveAttribute("href", pull.url);
  await expect(link).toHaveAttribute("title", "Pull request #430 on garden/controller\ntests: passed\ntypecheck: running");
  await expect(link.locator(".dot")).toHaveClass(/away/);
  await expect(card.locator(".chip").filter({ hasText: "2" })).toHaveAttribute("title", "2 subagents working");
  await expect(card.locator(".chip .num").first()).toHaveCSS("font-family", /Plex Mono|monospace/);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/chips-card-${page.viewportSize()!.width}.png` });
  // In the rows (the popover on a phone, the panel beside the chat from the split width) all three are plain, the row itself being the link.
  await page.getByRole("button", { name: /^Threads/ }).click();
  const row = page.locator(phone(page) ? ".threads-pop .thread-item" : ".threads-list .thread-item").first();
  await expect(row.locator(".chip")).toHaveCount(3);
  await expect(row.locator(".chip").nth(0)).toHaveText("1 of 3 steps done");
  await expect(row.locator(".chip").nth(1)).toHaveText("Pull request #430 Draft, checks running");
  await expect(row.locator(".chip").nth(2)).toHaveText("2 subagents");
  await expect(row.locator("a, button")).toHaveCount(0);
  // Both lists are narrow: the chips go under the title rather than cutting it to a letter. The title may still end in an
  // ellipsis beside a long state word, so what's checked is that it keeps most of the row.
  await expect(row.locator(".title")).toHaveText("Plan the herb beds and the watering");
  const [rowBox, title, chips] = await Promise.all([row.boundingBox(), row.locator(".title").boundingBox(), row.locator(".tchips").boundingBox()]);
  expect(title!.width).toBeGreaterThan(rowBox!.width / 2);
  expect(chips!.y).toBeGreaterThan(title!.y + title!.height - 1);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/chips-rows-${page.viewportSize()!.width}.png` });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a thread's branch shows as a badge that opens the changes view: files, commits, folds, side by side", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  const file = (path: string, kind: "added" | "modified" | "deleted" | "renamed", added: number, removed: number, oldPath?: string) => ({ path, kind, added, removed, ...(oldPath ? { oldPath } : {}) });
  const commits = [
    { hash: "f50fa8601e5b4c9d8a3f2e1d0c9b8a7f6e5d4c3b", subject: "Usage: Total's own tooltip; one doc line", author: "Lyrica", at: "2026-10-22T01:58:00Z" },
    { hash: "52b5268a1e5b4c9d8a3f2e1d0c9b8a7f6e5d4c3b", subject: "Measure subagents' turns, so their speed counts", author: "Lyrica", at: "2026-10-22T01:40:00Z" },
  ];
  const files = [file("DESIGN.md", "modified", 2, 2), file("core/src/models/index.ts", "modified", 32, 18), file("daemon/src/api.ts", "modified", 8, 3), file("docs/models.md", "renamed", 0, 0, "docs/model.md"), file("web/src/Usage.tsx", "added", 8, 0)];
  const changes = { repositories: [{ name: "garden/controller", path: "/workspace/repos/controller", branch: "lyrica/endpoint-tokens-per-second", base: "origin/main", commits, uncommitted: true, files,
    pull: { repo: "garden/controller", number: 430, head: commits[0]!.hash, url: "https://github.com/garden/controller/pull/430", checks: [{ name: "tests", result: "passed" }, { name: "typecheck", result: null }] } }] };
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: ${i % 3 ? "const value = compute(i);" : "// a comment"}`);
  const sides: Record<string, { before?: string; after?: string }> = {
    "DESIGN.md": { before: "# Design\n\nTokens follows Checklist once a thread has a counted turn. Its\npopover sums every request's reads and outputs\nby model.\n", after: "# Design\n\nTokens follows Checklist once a thread has a counted turn. Its\npopover sums every request's reads as input and\nits outputs as output, by model.\n" },
    "core/src/models/index.ts": { before: long.join("\n") + "\n", after: long.map((l, i) => (i === 29 ? "line 30: const value = measure(i, { gpu: true });" : l)).join("\n") + "\n" },
    "daemon/src/api.ts": { before: "export interface UsageRow { threadId: string; tokens: number }\n", after: "export interface UsageRow { threadId: string; tokens: number; input: number; output: number }\n" },
    "docs/models.md": { before: "# Models\n", after: "# Models\n" },
    "web/src/Usage.tsx": { after: "export function Totals() {\n  return null;\n}\n" },
  };
  await page.route("**/changes", (route) => route.fulfill({ json: changes }));
  await page.route("**/changes/commit?*", (route) => route.fulfill({ json: { files: files.slice(1, 3) } }));
  await page.route("**/changes/file?*", (route) => route.fulfill({ json: sides[new URL(route.request().url()).searchParams.get("path")!] ?? {} }));
  await newThread(page, "General");
  await send(page, "Show me the branch");
  const badge = page.locator("button.badge.changes");
  await expect(badge).toContainText("#430");
  await expect(badge).toHaveAttribute("title", "Changes in garden/controller: lyrica/endpoint-tokens-per-second");
  await expect(badge).toContainText("+50");
  await expect(badge).toContainText("−23");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/badge-${page.viewportSize()!.width}.png` });
  await badge.click();
  const dialog = page.getByRole("dialog", { name: "Changes in garden/controller" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("origin/main → lyrica/endpoint-tokens-per-second")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "#430" })).toHaveAttribute("href", "https://github.com/garden/controller/pull/430");
  const side = dialog.getByRole("navigation", { name: "Files and commits" });
  await expect(side.getByRole("button")).toHaveCount(5 + 2 + commits.length);
  await expect(side.getByRole("button", { name: /^All changes/ })).toHaveAttribute("aria-pressed", "true");
  // The changed words are marked inside the changed lines, and a renamed file says where it was.
  await expect(dialog.locator(".dl.ins mark.ins").first()).toContainText("as input");
  await expect(dialog.getByText("docs/model.md → docs/models.md")).toBeVisible();
  await expect(dialog.getByText("No differences in the text.")).toBeVisible();
  // A long unchanged stretch folds, and a press shows twenty more lines of it.
  const fold = dialog.getByRole("button", { name: "26 unmodified lines" });
  await expect(fold).toBeVisible();
  await expect(dialog.getByRole("button", { name: "27 unmodified lines" })).toBeVisible();
  await fold.click();
  await expect(dialog.getByRole("button", { name: "6 unmodified lines" })).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/unified-${page.viewportSize()!.width}.png` });
  const view = dialog.getByRole("group", { name: "View" });
  if (phone(page)) {
    await expect(view).toBeHidden();
  } else {
    await view.getByRole("button", { name: "Side by side" }).click();
    await expect(dialog.locator(".dr").first()).toBeVisible();
    await expect(dialog.locator(".dr .dl.del mark.del").first()).toContainText("outputs");
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/split-${page.viewportSize()!.width}.png` });
    await view.getByRole("button", { name: "Unified" }).click();
  }
  // One commit shows its own files; the heading names it.
  await side.getByRole("button", { name: /Measure subagents/ }).click();
  await expect(dialog.locator(".cfile")).toHaveCount(2);
  await expect(dialog.getByText("Measure subagents' turns, so their speed counts").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await noHorizontalScroll(page);
});
