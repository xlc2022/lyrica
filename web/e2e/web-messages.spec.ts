// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// A chat's messages: their menu, pins and reactions, runs of tool calls, code blocks, removing turns, child
// threads, the model badge, ask and plan modes, uploads and scrolling. Split from web-chat.spec.ts so that the
// two run side by side in CI (docs/ci.md). Tests run in order on this file's own lyricad per size.
import { expect, test } from "@playwright/test";
import { phone, enter, newThread, send, openSettings, deleteThread, threadIdOf, noHorizontalScroll } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

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
  await allow.click();
  await expect(allow).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Mode", exact: true }).getByRole("option")).toHaveCount(5);
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
  // Something she opens herself at the foot (a run of tool calls) is followed down, its header still in view.
  await page.locator(".scroll .msg").last().evaluate((el) => { el.style.paddingBottom = ""; });
  await send(page, "recall: 6");
  await expect(page.getByText("You said: recall: 6")).toBeVisible();
  // Her turn has finished laying out (its actions row, the facts line) before the marker is measured.
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await expect(page.getByRole("group", { name: "Message actions" }).last()).toBeVisible();
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  const marker = page.locator(".marker.tool-run").last().getByRole("button", { name: /tool calls/ });
  await marker.click();
  await expect(page.locator(".marker.tool-run").last().locator(".run-body .marker[data-type='tool']")).toHaveCount(6);
  await page.waitForTimeout(300);
  // Down to the bottom, or, where the run and what follows it are taller than the view (a short phone), as far as
  // keeps its header at the top.
  await expect.poll(async () => (await fromBottom()) <= 2
    || Math.abs((await marker.evaluate((b) => b.getBoundingClientRect().top - b.closest(".scroll")!.getBoundingClientRect().top))) <= 2).toBe(true);
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

test("typing while her reply streams leaves the conversation where it is, and opening a run of calls at the bottom follows it down", async ({ page, baseURL }) => {
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
  // Opening the run at the tail while it streams: the view follows it down, its header still in view (#986).
  const marker = page.locator(".marker.tool-run").getByRole("button", { name: /tool calls running/ });
  await marker.click();
  await expect(page.locator(".marker.tool-run .run-body")).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(150);
    await expect(marker).toBeInViewport();
  }
  await expect.poll(fromBottom).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 20_000 });
});
