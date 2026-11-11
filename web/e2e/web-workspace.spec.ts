// The web UI against a real lyricad (e2e/serve.ts) and a fake model server, at phone and desktop sizes.
// Around a chat's messages: the composer and header, search, memory, settings, accounts, machines and users,
// project threads and subagents, and the sources and pictures a reply links to. Split from web-chat.spec.ts so
// that the two run side by side in CI (docs/ci.md). Tests run in order on this file's own lyricad per size.
import { expect, test } from "@playwright/test";
import { phone, enter, newThread, send, openSettings, togglePrivate, threadIdOf, sendTo, hitHeight, noHorizontalScroll } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

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

    // In a pane narrower than the popover, as in the panel beside a chat, it overlaps the pane to its left rather than being cut.
    await meter.evaluate((el) => {
      el.parentElement!.removeAttribute("style");
      Object.assign(el.closest<HTMLElement>(".main")!.style, { width: "260px", justifySelf: "end" });
    });
    await meter.click();
    const wide = (await popover.boundingBox())!;
    const main = (await page.locator(".main").filter({ has: meter }).boundingBox())!;
    expect(wide.x).toBeLessThan(main.x);
    expect(await popover.evaluate((el, x) => el.contains(document.elementFromPoint(x, el.getBoundingClientRect().top + 12)), wide.x + 4)).toBe(true);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/context-overlap-${page.viewportSize()!.width}.png` });
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

test("coming back to a thread while she reasons shows her reasoning from its start", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  // "think slowly:" reasons a sentence every 300 ms for about 4 s before the reply.
  await send(page, "think slowly: about the kettle");
  const reasoning = page.getByRole("button", { name: "Show reasoning" });
  await reasoning.click();
  await expect(page.locator(".thought")).toContainText("Step 2 of my reasoning.");
  const thread = page.url();

  // She opens another page, and comes back while the reasoning goes on.
  const side = page.getByRole("complementary", { name: "Threads" });
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await side.getByRole("link", { name: /^Notifications/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await page.waitForTimeout(700);
  await page.goto(thread);
  await page.getByRole("button", { name: "Show reasoning" }).click();
  const thought = page.locator(".thought");
  await expect(thought).toContainText("Step 5 of my reasoning.");
  // From its first sentence, not from where she came back, and only once.
  await expect(thought).toHaveText(/^Step 1 of my reasoning\. Step 2 of my reasoning\. /);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/reasoning-back-${page.viewportSize()!.width}.png` });
  expect((await thought.textContent())!.match(/Step 1 of/g)).toHaveLength(1);
  // The stored reply keeps the whole reasoning too.
  await expect(page.getByText("You said: think slowly")).toBeVisible();
  await page.getByRole("button", { name: "Show reasoning" }).click();
  await expect(page.locator(".thought")).toHaveText(/^Step 1 of my reasoning\. [\s\S]*Step 12 of my reasoning\.\s*$/);
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

test("Search closes when another page is opened, clears its query, and opens again for the next search", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General"); // one titled "New thread", for the search that follows
  const side = page.getByRole("complementary", { name: "Threads" });
  const box = side.getByRole("searchbox", { name: "Search titles and messages" });
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();

  // Opened, and used for a word nobody wrote.
  await side.getByText("Search", { exact: true }).click();
  await box.fill("nowhere at all");
  await expect(side.getByText("Nothing matches.")).toBeVisible();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/search-open-${page.viewportSize()!.width}.png` });

  // Another page closes the field and clears its query, so the list there is the list again.
  await side.getByRole("link", { name: /^Notifications/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(box).toBeHidden();
  await expect(side.getByText("Nothing matches.")).toHaveCount(0);
  if (process.env.SCREENSHOTS) {
    // The drawer slides in, so the capture waits for it to settle.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/search-closed-${page.viewportSize()!.width}.png` });
  }

  // It opens again, and searches: the field is closed by leaving, not by using it once.
  await side.getByText("Search", { exact: true }).click();
  await expect(box).toBeVisible();
  await box.fill("New thread");
  await expect(side.locator(".thread").first()).toBeVisible();
  await expect(side.getByText("Nothing matches.")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("Search closes on a second page of one area, where the route's kind does not change", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const side = page.getByRole("complementary", { name: "Threads" });
  const box = side.getByRole("searchbox", { name: "Search titles and messages" });
  // Models and its pages are one route kind, so a check on the kind alone would miss this.
  await page.goto(`/#/u/${userId}/models`);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await side.getByText("Search", { exact: true }).click();
  await box.fill("nowhere at all");
  await expect(side.getByText("Nothing matches.")).toBeVisible();
  if (phone(page)) await side.getByRole("button", { name: "Hide threads" }).click();
  await page.getByRole("navigation", { name: "Models pages" }).getByRole("link", { name: "Hosts and endpoints" }).click();
  await expect(page).toHaveURL(/\/models\/hosts$/);
  if (phone(page)) await page.getByRole("button", { name: "Show threads" }).click();
  await expect(box).toBeHidden();
  await expect(side.getByText("Nothing matches.")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("the Notes layer hides superseded notes until asked", async ({ page, baseURL, request }) => {
  const userId = await enter(page, baseURL!);
  const fixture = await request.post(`http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}/superseded-fixture`, { data: { userId } });
  expect(fixture.ok()).toBe(true);
  await page.goto(`/#/u/${userId}/memory`);
  const filter = page.getByRole("checkbox", { name: "Hide superseded" });
  // Only where notes are listed.
  await expect(filter).toHaveCount(0);
  await page.getByRole("group", { name: "Layer" }).getByRole("button", { name: "Notes" }).click();
  await expect(filter).toBeChecked();
  const list = page.getByRole("region", { name: "Browse memory" }).locator(".mem-list");
  await expect(list.getByText("Fixture flat is in Graz now")).toBeVisible();
  await expect(list.getByText("Fixture flat is in Vienna")).toHaveCount(0);
  const tag = page.getByRole("group", { name: "Tags" }).getByRole("button", { name: /^fixture-flat/ });
  await expect(tag).toHaveText("fixture-flat 1");
  await filter.uncheck();
  await expect(list.getByText("Fixture flat is in Vienna")).toBeVisible();
  await expect(list.locator("a", { hasText: "Fixture flat is in Vienna" })).toContainText("superseded");
  await expect(tag).toHaveText("fixture-flat 2");
  await noHorizontalScroll(page);
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
  // The menu opens inside the reading pane rather than under the list beside it.
  const menu = await article.getByRole("menu").boundingBox();
  const pane = await page.locator(".mem-read").boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(pane!.x);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(pane!.x + pane!.width);
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
  await page.getByRole("button", { name: "Next" }).click();
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

test("A private machine she is refused for going off network is confirmed from its row, and then has nothing left to confirm", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const vault = { name: "vault", kind: "ssh", address: "lyrica@vault.example", root: null, pool: "private", limit: "ask", keyLine: "", hostKey: `SHA256:${"A".repeat(43)}`, lastUsed: null };
  let accepted = false;
  await page.route("**/machines", (r) => r.request().method() === "GET"
    ? r.fulfill({ json: [accepted ? { ...vault, offNetwork: true } : { ...vault, offNetwork: false, state: { kind: "offNetwork", since: new Date().toISOString() } }] }) : r.fallback());
  await page.route("**/machines/vault/confirm-off-network", (r) => { accepted = true; return r.fulfill({ json: { ...vault, offNetwork: true } }); });
  await page.goto(`/#/u/${userId}/settings/machines`);
  const row = page.getByRole("region", { name: "Machines", exact: true }).locator(".machine-row");
  await expect(row).toContainText("Off network");
  await row.getByRole("button", { name: "Actions for vault" }).click();
  await page.getByRole("menuitem", { name: "Use anyway" }).click();
  const dialog = page.getByRole("dialog", { name: "Outside your network" });
  await expect(dialog).toContainText("Use it anyway?");
  await dialog.getByRole("button", { name: "Use anyway" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => accepted).toBe(true);
  // Accepted, it still says Off network, and Use anyway is gone: it would do nothing.
  await expect(row).toContainText("Off network");
  await row.getByRole("button", { name: "Actions for vault" }).click();
  await expect(page.getByRole("menuitem", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Use anyway" })).toHaveCount(0);
});

test("Add machine for a Proxmox offers the user's own Proxmox user, with its warnings and its own setup", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.goto(`/#/u/${userId}/settings/machines/new`);
  await page.getByRole("button", { name: "Proxmox" }).click();
  // Her own account is the default: no User field, no warnings.
  await expect(page.getByLabel("Account")).toHaveValue("hers");
  await expect(page.getByRole("textbox", { name: "User" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Name" }).fill("pve");
  await page.getByRole("textbox", { name: "Address" }).fill("https://127.0.0.1:1");
  await page.getByLabel("Account").selectOption("mine");
  // Mine: what a token on the user's own Proxmox user means, and Next waits for the user it is on.
  const warnings = page.getByRole("list", { name: "A token on your own user" });
  await expect(warnings.getByRole("listitem")).toHaveCount(3);
  await expect(warnings).toContainText("--privsep 1");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await page.getByRole("textbox", { name: "User" }).fill("root@pam");
  const probed = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/machines/probe"));
  await page.getByRole("button", { name: "Next" }).click();
  expect((await probed).postDataJSON()).toEqual({ kind: "proxmox", name: "pve", address: "https://127.0.0.1:1", asUser: true, user: "root@pam" });
  // The setup makes no user: a separated token on theirs.
  const token = page.getByRole("region", { name: "Token" });
  await expect(token.getByText("pveum user token add root@pam lyrica --privsep 1")).toBeVisible();
  await expect(token.getByText("pveum user add")).toHaveCount(0);
  await expect(token.getByLabel("Token")).toHaveAttribute("placeholder", "root@pam!lyrica=…");
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("Replace key tries the machine as saved and shows what it answered", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  // A machine nothing listens for: port 1 refuses, and that answer is what the page must show.
  await page.evaluate(async (userId) => {
    const call = async (path: string, body: unknown) => (await fetch(`/api/u/${userId}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ draft: unknown }>;
    const probe = await call("/machines/probe", { name: "garden-pi", address: "pi@127.0.0.1:1" });
    await call("/machines", { name: "garden-pi", address: "pi@127.0.0.1:1", pool: "general", draft: probe.draft, hostKey: `SHA256:${"A".repeat(43)}` });
  }, userId);
  await page.goto(`/#/u/${userId}/settings/machines`);
  await page.getByRole("region", { name: "Machines", exact: true }).getByRole("button", { name: "Actions for garden-pi" }).click();
  const probed = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/machines/probe"));
  await page.getByRole("menuitem", { name: "Replace key" }).click();
  // The probe names the machine as saved, not the page's empty form, and tries her own key rather than a new one.
  expect((await probed).postDataJSON()).toEqual({ kind: "ssh", name: "garden-pi", address: "pi@127.0.0.1:1", replace: true });
  await expect(page.getByRole("heading", { level: 2, name: "Replace key" })).toBeVisible();
  await expect(page.getByText("garden-pi · pi@127.0.0.1:1")).toBeVisible();
  // Nothing answers on port 1, so the Fingerprint step shows the problem and Confirm waits.
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await noHorizontalScroll(page);
});

test("Replace key shows her key's setup again when the machine answers but refuses her login", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await page.evaluate(async (userId) => {
    const call = async (path: string, body: unknown) => (await fetch(`/api/u/${userId}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ draft: unknown }>;
    const probe = await call("/machines/probe", { name: "garden-pi", address: "pi@127.0.0.1:1" });
    await call("/machines", { name: "garden-pi", address: "pi@127.0.0.1:1", pool: "general", draft: probe.draft, hostKey: `SHA256:${"A".repeat(43)}` });
  }, userId);
  // A reinstalled machine: it shows a host key, but her key isn't in its keys file any more.
  const probes: { replace?: boolean; draft?: string }[] = [];
  await page.route(/\/api\/u\/[^/]+\/machines\/probe$/, async (route) => {
    const body = route.request().postDataJSON() as { replace?: boolean; draft?: string };
    probes.push(body);
    const fingerprint = `SHA256:${"B".repeat(43)}`;
    if (body.replace) {
      await route.fulfill({ json: { setup: "# 1. Her key, in a file only root can change, beside any key already there\ntouch /etc/ssh/authorized_keys/pi\ngrep -qxF -- 'restrict ssh-ed25519 AAAA' /etc/ssh/authorized_keys/pi || printf '%s\\n' 'restrict ssh-ed25519 AAAA' >> /etc/ssh/authorized_keys/pi", fingerprint, login: false, problem: "All configured authentication methods failed", offNetwork: false } });
      return;
    }
    // New key pair: a fresh draft, which logs in once its line is on the machine (the Test step).
    await route.fulfill({ json: { draft: "d1", keyLine: "restrict ssh-ed25519 NEWKEY", setup: "# 1. Her key\nprintf '%s\\n' 'restrict ssh-ed25519 NEWKEY' >> /etc/ssh/authorized_keys/pi", fingerprint, login: body.draft === "d1", ...(body.draft === "d1" ? {} : { problem: "All configured authentication methods failed" }), offNetwork: false } });
  });
  await page.goto(`/#/u/${userId}/settings/machines`);
  await page.getByRole("region", { name: "Machines", exact: true }).getByRole("button", { name: "Actions for garden-pi" }).click();
  await page.getByRole("menuitem", { name: "Replace key" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Replace key" })).toBeVisible();
  // The Key step comes back with the setup for her existing key, Copy and Test; the Fingerprint step says why the login failed, and Confirm still works for the host key alone.
  const key = page.getByRole("region", { name: "Key" });
  await expect(key.getByText("isn't accepted there any more")).toBeVisible();
  await expect(key.getByText("/etc/ssh/authorized_keys/pi").first()).toBeVisible();
  await expect(key.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByRole("alert").first()).toHaveText(/authentication methods failed/);
  await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await key.getByRole("button", { name: "Test" }).click();
  await expect.poll(() => probes.length).toBe(2);
  expect(probes[1]).toEqual({ kind: "ssh", name: "garden-pi", address: "pi@127.0.0.1:1", replace: true });
  await noHorizontalScroll(page);
  // New key pair: a fresh pair for the machine as saved, then the Key, Test and Fingerprint steps as when adding it; Confirm saves the pair.
  await page.getByRole("button", { name: "New key pair" }).click();
  await expect.poll(() => probes.length).toBe(3);
  expect(probes[2]).toEqual({ kind: "ssh", name: "garden-pi", address: "pi@127.0.0.1:1" });
  await expect(page.getByRole("heading", { level: 2, name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New key pair" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await expect(page.getByText("ssh-ed25519 NEWKEY")).toBeVisible();
  await page.getByRole("button", { name: "Copy" }).click();
  await page.getByRole("button", { name: "Test" }).click();
  await expect.poll(() => probes.length).toBe(4);
  expect(probes[3]).toEqual({ kind: "ssh", name: "garden-pi", address: "pi@127.0.0.1:1", draft: "d1" });
  await expect(page.getByText("Logged in")).toBeVisible();
  const saved = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/machines/garden-pi/key"));
  await page.getByRole("button", { name: "Confirm" }).click();
  expect((await saved).postDataJSON()).toEqual({ hostKey: `SHA256:${"B".repeat(43)}`, draft: "d1" });
  await noHorizontalScroll(page);
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
  // Away is a private account she is refused because its host left the network, until its Use anyway is confirmed.
  const away = { name: "Away", kind: "gitea", host: "git.example", account: "lyrica", pool: "private" };
  let accepted = false;
  await page.route("**/git-accounts", (r) => r.request().method() === "GET" ? r.fulfill({ json: [
    { name: "lyrica-bot", kind: "github", host: "github.com", account: "lyrica-bot", pool: "general", offNetwork: true, state: { kind: "signedIn", since } },
    { name: "Forge", kind: "forgejo", host: "git.lan", account: "lyrica", pool: "private", offNetwork: false, state: { kind: "unreachable", since } },
    accepted ? { ...away, offNetwork: true } : { ...away, offNetwork: false, state: { kind: "offNetwork", since } },
  ] }) : r.fallback());
  await page.route("**/git-accounts/Away/confirm-off-network", (r) => { accepted = true; return r.fulfill({ json: { ...away, offNetwork: true } }); });
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
  // The refused account says Off network, and its ⋯ is where that is confirmed; once accepted the row still says so, with nothing left to confirm.
  await expect(section.locator(".machine-row").nth(2)).toContainText("Off network");
  await section.getByRole("button", { name: /^Away/ }).click();
  const awayDrawer = page.getByRole("complementary", { name: "Away" });
  await awayDrawer.getByRole("button", { name: "Actions for Away" }).click();
  await page.getByRole("menuitem", { name: "Use anyway" }).click();
  const outside = page.getByRole("dialog", { name: "Use a host outside your network?" });
  await expect(outside).toContainText("Away's host is outside your network, so a private thread's code would leave it.");
  await outside.getByRole("button", { name: "Use anyway" }).click();
  await expect(outside).toHaveCount(0);
  await expect.poll(() => accepted).toBe(true);
  await expect(section.locator(".machine-row").nth(2)).toContainText("Off network");
  await awayDrawer.getByRole("button", { name: "Actions for Away" }).click();
  await expect(page.getByRole("menuitem", { name: "Replace token" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Use anyway" })).toHaveCount(0);
  // Escape closes the menu and the drawer under it.
  await page.keyboard.press("Escape");
  await expect(awayDrawer).toHaveCount(0);

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
  // A call budget: empty is no limit; with one, the row shows today's calls against it.
  await expect(drawer.getByLabel("Calls per day")).toHaveValue("");
  await drawer.getByLabel("Calls per day").fill("4000");
  await drawer.getByLabel("Calls per minute").fill("20");
  await shot("mcp-drawer");
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(row).toContainText("0 of 4,000 today");

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
  // Measured in one go on an attached row: the plan's thread moving between the popover's state groups (Working to Idle as
  // its turn ends) remounts its row, and three separate measurements could straddle that and read a detached one.
  let box: { connected: boolean; row: number; title: DOMRect; chips: DOMRect } | undefined;
  await expect(async () => {
    box = await row.evaluate((el) => ({ connected: el.isConnected, row: el.getBoundingClientRect().width, title: el.querySelector(".title")!.getBoundingClientRect().toJSON(), chips: el.querySelector(".tchips")!.getBoundingClientRect().toJSON() }));
    expect(box.connected).toBe(true);
  }).toPass({ timeout: 5000 });
  expect(box!.title.width, JSON.stringify(box)).toBeGreaterThan(box!.row / 2);
  expect(box!.chips.y, JSON.stringify(box)).toBeGreaterThan(box!.title.y + box!.title.height - 1);
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
  await expect(dialog.locator(".cline.ins mark.ins").first()).toContainText("as input");
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
    await expect(dialog.locator(".dr .cline.del mark.del").first()).toContainText("outputs");
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

test("an open run of tool calls follows again when scrolled to its bottom while calls render before the scroll event", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "recall: 24 slowly");
  const run = page.locator(".marker.tool-run");
  await run.getByRole("button", { name: /tool calls running/ }).click();
  const box = run.locator(".run-body");
  const calls = run.locator(".run-body .marker[data-type='tool']");
  await expect.poll(() => box.evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true);
  // Scrolled up, new calls land below without moving it.
  await box.evaluate((el) => { el.scrollTop = 0; });
  const seen = await calls.count();
  await expect.poll(() => calls.count()).toBeGreaterThan(seen + 1);
  expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
  // Hold the scroll events back, scroll to the bottom, and let new calls render before the event arrives.
  await page.evaluate(() => { (window as any).held = true; window.addEventListener("scroll", (e) => { if ((window as any).held) e.stopImmediatePropagation(); }, true); });
  await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const back = await calls.count();
  await expect.poll(() => calls.count()).toBeGreaterThan(back);
  // The held event arrives late, measured against a height the person never saw: following must not stop.
  await box.evaluate((el) => { (window as any).held = false; el.dispatchEvent(new Event("scroll")); });
  const later = await calls.count();
  await expect.poll(() => calls.count()).toBeGreaterThan(later);
  await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 3000 }).toBeLessThanOrEqual(2);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/tool-run-follow-${page.viewportSize()!.width}.png` });
});

// The subagents drawer (docs/ux.md §6): the fake model never delegates, so the thread's runs are answered here as the daemon
// would send them; the header's button and the drawer's rows are the real UI.
test("a thread's subagents open in a drawer from the header: working ones first, each row a link to its thread", async ({ page, baseURL }) => {
  await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Hello there");
  await expect(page.getByText("in a few pieces.")).toBeVisible();
  const header = page.locator(".thread-head .head-actions");
  await expect(header.getByRole("button", { name: /^Subagents/ })).toHaveCount(0);
  const run = (thread: string, role: string, status: string, minutes: number, title = "") => ({
    run: `run-${thread}`, thread, role, title, model: "cloud/cloud-model", background: false, status,
    inputTokens: 12000, outputTokens: 800, startedAt: new Date(Date.now() - minutes * 60_000).toISOString(), endedAt: status === "running" ? null : new Date().toISOString(),
  });
  const runs = [run("sub-c", "reviewer", "failed", 1, "Check the restore script"), run("sub-b", "coder", "running", 5, "Fix the pool scripts"), run("sub-a", "researcher", "finished", 9)];
  await page.route("**/subagents", (route) => route.fulfill({ json: { runs, usage: { inputTokens: 36000, outputTokens: 2400 } } }));
  await page.reload();
  const button = header.getByRole("button", { name: "Subagents 3" });
  await expect(button).toBeVisible();
  await expect(button.locator(".num")).toHaveCSS("font-family", /Plex Mono|monospace/);
  await button.click();
  const drawer = page.getByRole("complementary", { name: "Subagents" });
  await expect(drawer).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.locator("p.sub-facts")).toHaveText("3 subagents · 1 working · 38k tokens");
  const rows = drawer.locator(".sub-row");
  await expect(rows).toHaveCount(3);
  // The one still working leads; the rest stay newest first.
  await expect(rows.locator(".role")).toHaveText(["coder", "reviewer", "researcher"]);
  // Each one's title follows its role, so two of the same role tell apart; one without a title shows its role alone.
  await expect(rows.locator(".sub-name")).toHaveText(["coder – Fix the pool scripts", "reviewer – Check the restore script", "researcher"]);
  await expect(rows.locator(".tstate")).toHaveText(["Working", "Failed", "Done"]);
  await expect(rows.first()).toHaveAttribute("href", /\/t\/general\/sub-b$/);
  await expect(rows.first().locator(".sub-facts")).toContainText("cloud-model");
  await expect(rows.first().locator(".sub-facts")).toContainText("13k tokens");
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/subagents-drawer-${page.viewportSize()!.width}.png` });
  // One drawer at a time: Settings takes its place, and Escape closes whichever is open.
  if (!phone(page)) {
    await page.getByRole("button", { name: "Thread settings" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Thread settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await button.click();
  }
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the pages she read show under her reply as Sources, each opening in a new tab", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  await newThread(page, "General");
  await send(page, "Hello there");
  await expect(page.getByText("You said: Hello there")).toBeVisible();
  // Her fetches run in the thread's sandbox: the fake's pages are on this machine, so the thread needs local services.
  const thread = threadIdOf(page.url());
  await page.evaluate(async (path) => {
    await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ services: true }) });
  }, `/api/u/${userId}/threads/general/${encodeURIComponent(thread)}/settings`);
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  await send(page, `fetch: ${fake}/page/moths-at-night, ${fake}/page/a-luna-moth-diary-of-seven-short-days-and-nights, ${fake}/page/moths-at-night`);
  await expect(page.getByText("Read them.")).toBeVisible();
  // Under her words, in the turn that read them.
  const sources = page.locator(".turn").filter({ hasText: "Read them." }).getByRole("list", { name: "Sources" });
  await expect(sources.getByRole("link")).toHaveCount(2);
  const first = sources.getByRole("link").first();
  await expect(first).toHaveAttribute("href", `${fake}/page/moths-at-night`);
  await expect(first).toHaveAttribute("target", "_blank");
  await expect(first).toHaveAttribute("rel", "noopener noreferrer");
  await expect(first).toHaveAttribute("title", `Moths At Night\n${fake}/page/moths-at-night`);
  await expect(first).toContainText("Moths At Night");
  await expect(first).toContainText("127.0.0.1");
  // The reply before has none.
  await expect(page.locator(".turn").filter({ hasText: "You said: Hello there" }).locator(".sources")).toHaveCount(0);
  await noHorizontalScroll(page);
  if (process.env.SCREENSHOTS) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/sources-${page.viewportSize()!.width}-${colorScheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
});

test("a source read from the offline copy of Wikipedia opens in the app: the article in a viewer, a picture large", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  const kiwix = (address: string) => page.evaluate(async ([path, a]) => {
    await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kiwix: a }) });
  }, [`/api/u/${userId}/admin/web-search`, address] as const);
  await kiwix(`${fake}/kiwix`);
  try {
    await newThread(page, "General");
    const lute = `${fake}/kiwix/content/wikipedia_en_all_nopic_2026-06/I/Lute.png`;
    await send(page, `fetch: https://en.wikipedia.org/wiki/Lute, ${lute}`);
    await expect(page.getByText("Read them.")).toBeVisible();
    const sources = page.locator(".turn").filter({ hasText: "Read them." }).getByRole("list", { name: "Sources" });
    // Her marker says the offline copy answered, not wikipedia.org. Once her calls fold into a run, the run opens to show it.
    const marker = page.locator(".marker[data-type='tool']").filter({ hasText: "web_fetch https://en.wikipedia.org/wiki/Lute" });
    await expect(async () => {
      const closed = page.locator(".marker.tool-run > button[aria-expanded='false']");
      if (await closed.count()) await closed.first().click();
      await expect(marker).toContainText("from Offline Wikipedia", { timeout: 1000 });
    }).toPass();
    // Both read from the offline copy: buttons that open in the app, not links.
    await expect(sources.getByRole("link")).toHaveCount(0);
    const article = sources.getByRole("button").first();
    const picture = sources.getByRole("button").nth(1);
    await expect(article).toHaveText("LuteOffline Wikipedia");
    await expect(article).toHaveAttribute("title", "Lute\nhttps://en.wikipedia.org/wiki/Lute");
    await expect(picture).toHaveAttribute("title", `Lute\n${lute}`);
    await noHorizontalScroll(page);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/offline-sources-${page.viewportSize()!.width}.png` });
    await article.click();
    const viewer = page.getByRole("dialog", { name: "Lute" });
    await expect(viewer.getByRole("heading", { name: "Lute", level: 1 })).toBeVisible();
    await expect(viewer.getByText("Offline Wikipedia · 2026-06")).toBeVisible();
    await expect(viewer.getByText(/A lute is any plucked string instrument/).first()).toBeVisible();
    await expect(viewer.getByRole("link", { name: "en.wikipedia.org" })).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Lute");
    // Its picture, through lyricad, opens large over it.
    const shown = viewer.getByRole("button", { name: "A Renaissance lute, open large" });
    await expect.poll(() => shown.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/offline-source-${page.viewportSize()!.width}.png` });
    await viewer.getByRole("button", { name: "Close" }).click();
    await expect(viewer).toHaveCount(0);
    await picture.click();
    const box = page.getByRole("dialog", { name: "Lute.png" });
    await expect.poll(() => box.locator(".lb-img img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
    await box.getByRole("button", { name: "Close" }).click();
  } finally {
    await kiwix("");
  }
});

test("her pictures stay put while her reply streams and after it, so the page neither flashes nor jumps", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  const kiwix = (address: string) => page.evaluate(async ([path, a]) => {
    await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kiwix: a }) });
  }, [`/api/u/${userId}/admin/web-search`, address] as const);
  await kiwix(`${fake}/kiwix`);
  try {
    await newThread(page, "General");
    const lute = `${fake}/kiwix/content/wikipedia_en_all_nopic_2026-06/I/Lute.png`;
    // "slowly" paces the fake model's pieces, so the reply is still streaming well after the picture shows.
    await send(page, ["reply: ### Lute", "", `![A Renaissance lute](${lute})`, "", "It came to Europe slowly, through Spain and Sicily, carried by traders and by musicians.", "", "Players tuned it in courses of paired strings."].join("\n"));
    const picture = page.getByRole("button", { name: "A Renaissance lute, open large" });
    await expect(picture).toBeVisible();
    // A mark on the element: a remount (which reloaded the picture and showed its link for a moment) drops it.
    const mark = () => picture.locator("img").evaluate((img) => { (img as HTMLImageElement & { kept?: boolean }).kept = true; });
    const kept = () => picture.locator("img").evaluate((img) => Boolean((img as HTMLImageElement & { kept?: boolean }).kept));
    await mark();
    const hers = page.locator(".msg.her");
    await expect(hers.getByText("carried by traders", { exact: false })).toBeVisible();
    expect(await kept()).toBe(true);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/streaming-picture-${page.viewportSize()!.width}.png` });
    await expect(hers.getByText("Players tuned it in courses of paired strings.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    // The stored copy replaces the live reply (a new element, by design) a moment after Stop goes: wait for it, its
    // section numbered, before marking, or the swap lands after the mark and reads as a remount.
    await expect(page.locator("section.turn", { has: picture })).toHaveAttribute("id", /^m-/);
    // Once the turn is done, scrolling re-renders the thread; the picture still stays the same element.
    await mark();
    await picture.hover();
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, i % 2 ? 200 : -200); await page.waitForTimeout(50); }
    expect(await kept()).toBe(true);
    await expect(page.getByRole("link", { name: "A Renaissance lute" })).toHaveCount(0);
  } finally {
    await kiwix("");
  }
});

test("a picture of the offline copy of Wikipedia shows in her reply through lyricad; another remote image stays a link", async ({ page, baseURL }) => {
  const userId = await enter(page, baseURL!);
  const fake = `http://127.0.0.1:${Number(new URL(baseURL!).port) + 10}`;
  const kiwix = (address: string) => page.evaluate(async ([path, a]) => {
    await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kiwix: a }) });
  }, [`/api/u/${userId}/admin/web-search`, address] as const);
  await kiwix(`${fake}/kiwix`);
  try {
    await newThread(page, "General");
    const lute = `${fake}/kiwix/content/wikipedia_en_all_nopic_2026-06/I/Lute.png`;
    await send(page, ["reply: ### Lute", "", `![A Renaissance lute](${lute})`, "", "*A Renaissance lute, from the offline copy.*", "", "![A lute online](https://upload.example.invalid/Lute.png)", "", "The lute came to Europe through Spain."].join("\n"));
    await expect(page.getByText("The lute came to Europe through Spain.")).toBeVisible();
    const msg = page.locator(".prose").filter({ hasText: "The lute came to Europe through Spain." });
    const picture = msg.getByRole("button", { name: "A Renaissance lute, open large" });
    await expect(picture).toBeVisible();
    await expect(picture.locator("img")).toHaveAttribute("src", `/api/u/${userId}/web/picture?url=${encodeURIComponent(lute)}`);
    await expect.poll(() => picture.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
    // An image from anywhere else is never asked for: a link with its alt text, as before.
    await expect(msg.getByRole("link", { name: "A lute online" })).toHaveAttribute("href", "https://upload.example.invalid/Lute.png");
    await expect(msg.getByRole("link", { name: "A Renaissance lute" })).toHaveCount(0);
    await noHorizontalScroll(page);
    if (process.env.SCREENSHOTS) {
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({ path: `${process.env.SCREENSHOTS}/offline-picture-${page.viewportSize()!.width}-${colorScheme}.png` });
      }
      await page.emulateMedia({ colorScheme: null });
    }
    await picture.click();
    const box = page.getByRole("dialog", { name: "Lute.png" });
    await expect(box).toBeVisible();
    await expect.poll(() => box.locator(".lb-img img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/offline-picture-large-${page.viewportSize()!.width}.png` });
    await box.getByRole("button", { name: "Close" }).click();
  } finally {
    await kiwix("");
  }
});
