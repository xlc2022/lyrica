import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Browser, BROWSE_SCRIPT, BROWSE_UNAPPROVED, browseFormText, browseFormWarning, sandboxTools, type BrowserProcess } from "../src/index.ts";

// The browse tool's driver against a real Chromium and a site on loopback (docs/briefs/browse.md). The driver runs
// here as it does in the sandbox, without the sandbox: what is checked is what the user would notice, a form
// that is never sent without their yes and a login that lasts. Skipped where no Chromium is installed.
const chromium = [process.env.CHROME_PATH, sandboxTools().browser, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((f) => f && existsSync(f));

const SHOP = `<title>Shop</title><h1>Shop</h1><p>Welcome to the <a href="/two">second page</a>.</p>
<form action="/find"><input type="search" name="q" placeholder="Search"><button>Go</button></form>
<form method="post" action="/login"><label>Email: <input name="email"></label><label for="pw">Password</label><input id="pw" type="password" name="pw">
<select name="c" aria-label="Country"><option>Austria</option><option>Brazil</option></select><button type="submit">Sign in</button></form>
<form method="post" action="/ask"><input type="hidden" name="t" value="1"><input name="q" placeholder="Ask"><button>Send</button></form>
<form method="post" action="/ask"><input name="q" placeholder="Note"><input type="checkbox" name="keep" aria-label="Keep"><button>Save</button></form>
<form method="post" action="/ask"><input name="c" placeholder="Type the name to confirm"><button>Delete account</button></form>
<form method="post" action="/items/remove"><input name="c" placeholder="Which"><button>Confirm</button></form>
<form method="post" action="/ask"><input type="hidden" name="_method" value="delete"><input name="c" placeholder="Why"><button>Yes</button></form>
<div id="js" style="cursor:pointer">Poster</div><div style="display:none">hidden words</div>
<script>document.getElementById("js").addEventListener("click", () => { const f = document.createElement("form"); f.method = "post"; f.action = "/login"; document.body.append(f); f.submit(); });</script>`;

describe.skipIf(!chromium)("the browse tool's browser", () => {
  let server: Server, site: string, dir: string;
  const posts: string[] = [];
  const browsers: Browser[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lyrica-browse-"));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        res.setHeader("content-type", "text/html");
        if (req.method === "POST" && url.pathname === "/ask") { posts.push(body); return res.end("<title>Asked</title><p>Asked</p>"); }
        if (req.method === "POST") { posts.push(body); res.setHeader("set-cookie", ["sid=abc; Max-Age=9999", "visit=now"]); return res.end("<title>In</title><p>Signed in</p>"); }
        if (url.pathname === "/find") return res.end(`<title>Results</title><p>Results for ${url.searchParams.get("q")}</p>`);
        if (url.pathname === "/two") return res.end(`<title>Two</title><p>Cookie: ${req.headers.cookie ?? "none"}</p>`);
        res.end(SHOP);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await Promise.all(browsers.splice(0).map((b) => b.close())); posts.length = 0; });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const browser = (profile: string) => {
    const b = new Browser(async () => spawn(process.execPath, ["-e", BROWSE_SCRIPT, join(dir, profile), "test"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CHROME_PATH: chromium, BROWSE_TRACE: "1" } }) as BrowserProcess);
    browsers.push(b);
    return b;
  };
  /** The number of the thing whose line holds `words`. */
  const ref = (text: string | undefined, words: string) => Number(new RegExp(`\\[(\\d+)\\] [a-z ]+ "${words}`).exec(text ?? "")?.[1]);

  it("reads a page as text with a number on each thing to act on, and goes where a click leads", async () => {
    const b = browser("a");
    const page = await b.act("1", { action: "open", url: site });
    expect(page.title).toBe("Shop");
    expect(page.text).toContain("# Shop");
    expect(page.text).toMatch(/\[\d+\] link "second page"/);
    expect(page.text).toMatch(/\[\d+\] password field "Password" = ""/);
    expect(page.text).toMatch(/\[\d+\] select "Country" = "Austria" \(options: Austria \| Brazil\)/);
    expect(page.text).not.toContain("hidden words");
    const two = await b.act("2", { action: "click", ref: ref(page.text, "second page") });
    expect(two.url).toBe(`${site}/two`);
    // A number from the page before is gone, and never means something on this one.
    expect((await b.act("3", { action: "click", ref: ref(page.text, "Go") })).fail).toContain("isn't on the page any more");
    expect((await b.act("4", { action: "screenshot" })).image).toBeTruthy();
  }, 60_000);

  it("searches without asking, and never sends a form without the user's yes for that call", async () => {
    const b = browser("b");
    let page = await b.act("1", { action: "open", url: site });
    const search = ref(page.text, "Search");
    expect((await b.look({ action: "type", ref: search, submit: true })).form).toBeUndefined();
    const found = await b.act("2", { action: "type", ref: search, text: "shoes", submit: true });
    expect(found.text).toContain("Results for shoes");

    page = await b.act("3", { action: "back" });
    await b.act("4", { action: "type", ref: ref(page.text, "Email"), text: "ada@example.com" });
    await b.act("5", { action: "select", ref: ref(page.text, "Country"), text: "Brazil" });
    page = await b.act("6", { action: "type", ref: ref(page.text, "Password"), text: "hunter2" });
    // The password is never read back, on the page or on the card.
    expect(page.text).toContain('password field "Password" = "•••"');
    expect(page.text).not.toContain("hunter2");
    const signIn = ref(page.text, "Sign in");
    const seen = await b.look({ action: "click", ref: signIn });
    expect(browseFormWarning(seen.form!)).toBe(`This sends a form on ${new URL(site).host}.`);
    expect(browseFormText(seen.form!)).toBe(`POST to ${new URL(site).host} (Sign in)\nEmail: ada@example.com\nPassword: •••\nCountry: Brazil`);

    // Without the gate's yes the driver refuses, whatever the caller meant.
    expect((await b.act("7", { action: "click", ref: signIn })).fail).toBe(BROWSE_UNAPPROVED);
    // A yes is for one call: another call's id doesn't carry it.
    b.approve("8");
    expect((await b.act("9", { action: "click", ref: signIn })).fail).toBe(BROWSE_UNAPPROVED);
    expect(posts).toEqual([]);
    b.approve("10");
    expect((await b.act("10", { action: "click", ref: signIn })).text).toContain("Signed in");
    expect(posts).toEqual(["email=ada%40example.com&pw=hunter2&c=Brazil"]);
  }, 90_000);

  it("sends a posted form that is one text box without asking, and asks for one with anything else to fill in or that deletes", async () => {
    const b = browser("f");
    let page = await b.act("1", { action: "open", url: site });
    const ask = ref(page.text, "Ask");
    expect((await b.look({ action: "type", ref: ask, submit: true })).form).toBeUndefined();
    expect((await b.act("2", { action: "type", ref: ask, text: "tea", submit: true })).text).toContain("Asked");
    expect(posts).toEqual(["t=1&q=tea"]);
    page = await b.act("3", { action: "back" });
    expect((await b.look({ action: "click", ref: ref(page.text, "Send") })).form).toBeUndefined();
    expect((await b.look({ action: "click", ref: ref(page.text, "Save") })).form).toBeTruthy();
    expect((await b.act("4", { action: "click", ref: ref(page.text, "Save") })).fail).toBe(BROWSE_UNAPPROVED);
    // One box, but it says it deletes or removes: in its button, where it goes, or a hidden _method.
    for (const button of ["Delete account", "Confirm", "Yes"]) expect((await b.look({ action: "click", ref: ref(page.text, button) })).form).toBeTruthy();
    expect((await b.look({ action: "type", ref: ref(page.text, "Type the name to confirm"), submit: true })).form).toBeTruthy();
    expect((await b.act("5", { action: "click", ref: ref(page.text, "Delete account") })).fail).toBe(BROWSE_UNAPPROVED);
    expect(posts.length).toBe(1);
  }, 60_000);

  it("stops a post a page's script sets off, keeps the page, and asks for the same click from then on", async () => {
    const b = browser("c");
    const page = await b.act("1", { action: "open", url: site });
    const poster = ref(page.text, "Poster");
    expect((await b.look({ action: "click", ref: poster })).form).toBeUndefined();
    const held = await b.act("2", { action: "click", ref: poster });
    expect(posts).toEqual([]);
    expect(held.title).toBe("Shop");
    expect(held.notes?.join(" ")).toContain("nothing was sent");
    expect((await b.look({ action: "click", ref: poster })).form).toBeTruthy();
    b.approve("3");
    expect((await b.act("3", { action: "click", ref: poster })).text).toContain("Signed in");
    expect(posts.length).toBe(1);
  }, 60_000);

  // A cookie with no end date too: many sites' logins are one.
  it("keeps a login when the browser closes and opens again", async () => {
    const b = browser("d");
    const page = await b.act("1", { action: "open", url: site });
    b.approve("2");
    await b.act("2", { action: "click", ref: ref(page.text, "Sign in") });
    await b.act("3", { action: "close" });
    expect(b.running).toBe(false);
    expect((await b.act("4", { action: "open", url: `${site}/two` })).text).toMatch(/Cookie: (?=.*sid=abc)(?=.*visit=now)/);
  }, 60_000);
  it("keeps a fresh login when the browser is killed", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const b = new Browser(async () => (child = spawn(process.execPath, ["-e", BROWSE_SCRIPT, join(dir, "e"), "test"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CHROME_PATH: chromium } })) as BrowserProcess);
    browsers.push(b);
    const page = await b.act("1", { action: "open", url: site });
    b.approve("2");
    await b.act("2", { action: "click", ref: ref(page.text, "Sign in") });
    // Killed at once, before Chromium has written its own cookie store.
    child!.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1000));
    expect((await b.act("3", { action: "open", url: `${site}/two` })).text).toMatch(/Cookie: (?=.*sid=abc)(?=.*visit=now)/);
  }, 60_000);
});
