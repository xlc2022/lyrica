// Runs in the sandbox with its own node (`node -e`): one Chromium for a thread's `browse` tool, driven over the
// DevTools protocol on a pipe (core/src/browse.ts, browseArgv). It reaches the network as the sandbox allows.
// Arguments: profile folder, user agent. It reads one JSON request per line on stdin ({ id, op, ... }) and answers
// each with one JSON line ({ id, ... } or { id, fail }). No packages: the sandbox has none.
//
// What is structural here (docs/briefs/browse.md): an action that would send a form is done only when the request
// says `approved`, and a page load that posts without it is failed in the browser, so nothing is sent.
const { spawn } = require("node:child_process");
const { rmSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const [profile, agent] = process.argv.slice(1);
const LOAD_MS = 20_000, SETTLE_MS = 600;
// Chromium can drop a cookie with no end date when it closes, and writes none for a while after it is set, so a
// browser that is killed loses a fresh login. The cookies are kept here too, in the profile, after each action,
// and given back at the next start.
const COOKIES = `${profile}/lyrica-cookies.json`;

mkdirSync(profile, { recursive: true });
// One browser per thread, so a lock left by a browser that was killed is never another's.
for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(`${profile}/${f}`, { force: true });
const chrome = spawn(process.env.CHROME_PATH, [
  "--headless", "--no-sandbox", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--disable-gpu",
  "--disable-background-networking", "--disable-sync", "--disable-component-update", "--no-first-run", "--disable-extensions",
  "--mute-audio", "--password-store=basic", "--window-size=1280,800", "--disk-cache-size=52428800", `--user-agent=${agent}`, "about:blank",
], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  // Everything else Chromium writes goes under /tmp, the sandbox's own.
  env: { ...process.env, HOME: "/tmp/chromium", XDG_CONFIG_HOME: "/tmp/chromium/.config", XDG_CACHE_HOME: "/tmp/chromium/.cache" },
});
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let next = 1, session, target, frame, world, refs = 0;
/** Whether the main frame is loading, and who waits for it to stop. */
let loading = false, stopped = [];
/** A form post may go: only while an approved action runs. What was stopped otherwise, by host. */
let mayPost = false, heldPost;
let notes = [];
const waiting = new Map();
const send = (method, params = {}, top = false) => new Promise((resolve, reject) => {
  const id = next++;
  waiting.set(id, { resolve, reject });
  toChrome.write(JSON.stringify({ id, method, params, ...(session && !top ? { sessionId: session } : {}) }) + "\0");
});
const quiet = (p) => p.catch(() => {});

function onEvent(m) {
  const p = m.params ?? {};
  if (m.method === "Page.frameStartedLoading" && p.frameId === frame) loading = true;
  else if ((m.method === "Page.frameStoppedLoading" && p.frameId === frame) || m.method === "Page.loadEventFired") {
    loading = false;
    for (const r of stopped.splice(0)) r();
  } else if (m.method === "Page.frameNavigated" && !p.frame.parentId) world = undefined;
  else if (m.method === "Page.javascriptDialogOpening") {
    // A message is closed; a question is answered no, so nothing is confirmed that she didn't see.
    const accept = p.type === "alert" || p.type === "beforeunload";
    if (p.type !== "beforeunload") notes.push(`The page showed a ${p.type === "alert" ? "message" : "question"} box, ${accept ? "closed" : "answered no"}: ${JSON.stringify(String(p.message).slice(0, 300))}`);
    quiet(send("Page.handleJavaScriptDialog", { accept }));
  } else if (m.method === "Fetch.requestPaused") {
    const method = String(p.request.method).toUpperCase();
    if (method === "GET" || method === "HEAD" || mayPost) return void quiet(send("Fetch.continueRequest", { requestId: p.requestId }));
    try { heldPost = new URL(p.request.url).host; } catch { heldPost = "another page"; }
    // Answered "no content", so nothing reaches the site and the page she was on stays.
    quiet(send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 204 }));
  } else if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") {
    // A link that opens a new tab: there is one tab, so its address opens here and the new tab goes.
    const t = p.targetInfo;
    if (t.type !== "page" || t.targetId === target || !t.openerId) return;
    if (!/^https?:/.test(t.url)) return;
    quiet(send("Target.closeTarget", { targetId: t.targetId }, true));
    notes.push("A new tab opened; its page is shown here instead.");
    loading = true;
    quiet(send("Page.navigate", { url: t.url }));
  }
}

let buffer = "";
fromChrome.on("data", (d) => {
  buffer += d.toString();
  let i;
  while ((i = buffer.indexOf("\0")) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    } else if (m.method) onEvent(m);
  }
});
const quit = () => { chrome.kill("SIGKILL"); process.exit(0); };
chrome.on("exit", quit);
chrome.on("error", (e) => { process.stdout.write(JSON.stringify({ fail: `Chromium didn't start: ${e.message}` }) + "\n"); process.exit(0); });
for (const p of [toChrome, fromChrome]) p.on("error", quit);

// The page's side, in a world of its own, so the page's scripts can't reach or change it. Numbers are kept per
// element and never reused in a browser's life, so an old number can't come to mean something else on a new page.
const PAGE = `((start) => {
  if (globalThis.__ly) return;
  const S = { n: start, ids: new WeakMap(), els: new Map(), held: new WeakSet() };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "SVG", "CANVAS", "VIDEO", "AUDIO", "OBJECT", "EMBED"]);
  const ROLES = { button: "button", link: "link", checkbox: "checkbox", radio: "radio", tab: "tab", menuitem: "menu item", menuitemcheckbox: "checkbox", menuitemradio: "radio", option: "option", switch: "checkbox", combobox: "field", textbox: "field", searchbox: "field" };
  const clean = (s, max = 100) => { s = String(s ?? "").replace(/\\s+/g, " ").trim(); return s.length > max ? s.slice(0, max) + "…" : s; };
  const tag = (el) => el.tagName.toUpperCase();
  const shown = (el) => el.getAttribute("aria-hidden") !== "true" && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : getComputedStyle(el).display !== "none");
  function kind(el, style) {
    const t = tag(el);
    if (t === "A" && el.hasAttribute("href")) return "link";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (["submit", "button", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      return ty === "password" ? "password field" : ty === "file" ? "file field" : "field";
    }
    if (t === "TEXTAREA") return "field";
    if (t === "SELECT") return "select";
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return "field";
    const role = ROLES[el.getAttribute("role")];
    if (role) return role;
    // A thing a script made clickable: the outermost element the pointer changes over.
    if (el.hasAttribute("onclick") || (style.cursor === "pointer" && el.parentElement && getComputedStyle(el.parentElement).cursor !== "pointer")) return "button";
    return null;
  }
  const isField = (k) => k === "field" || k === "password field" || k === "file field" || k === "select" || k === "checkbox" || k === "radio";
  function name(el, k) {
    const label = el.getAttribute("aria-label") || el.labels?.[0]?.innerText || "";
    if (isField(k)) return clean(label || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
    return clean(label || el.innerText || el.value || el.getAttribute("title") || el.querySelector?.("img[alt]")?.alt || "");
  }
  const value = (el) => (el.type === "password" ? (el.value ? "•••" : "") : tag(el) === "SELECT" ? clean(el.selectedOptions[0]?.label) : "value" in el ? clean(el.value, 200) : clean(el.innerText, 200));
  function ref(el) {
    let id = S.ids.get(el);
    if (!id) { id = ++S.n; S.ids.set(el, id); S.els.set(id, new WeakRef(el)); }
    return id;
  }
  function line(el, k) {
    let s = "[" + ref(el) + "] " + k + " " + JSON.stringify(name(el, k));
    if (k === "checkbox" || k === "radio") { if (el.checked || el.getAttribute("aria-checked") === "true") s += " (checked)"; }
    else if (k === "select") s += " = " + JSON.stringify(value(el)) + " (options: " + [...el.options].slice(0, 15).map((o) => clean(o.label, 40)).join(" | ") + (el.options.length > 15 ? " | …" : "") + ")";
    else if (k === "field" || k === "password field") s += " = " + JSON.stringify(value(el));
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " (disabled)";
    return s;
  }
  function snap() {
    const out = [];
    let cur = "";
    const flush = () => { cur = cur.replace(/\\s+/g, " ").trim(); if (cur) out.push(cur); cur = ""; };
    const walk = (node, quietText) => {
      if (node.nodeType === 3) { if (!quietText) cur += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      const el = node, t = tag(el);
      if (SKIP.has(t) || !shown(el)) return;
      if (t === "BR") return flush();
      if (t === "IFRAME" || t === "FRAME") { flush(); out.push("[a frame, not read: " + clean(el.getAttribute("title") || el.src || "", 120) + "]"); return; }
      if (t === "IMG") { const alt = clean(el.alt); if (alt && !quietText) cur += " [image: " + alt + "] "; return; }
      const style = getComputedStyle(el);
      const k = kind(el, style);
      if (k) { flush(); out.push(line(el, k)); return; }
      const block = !style.display.startsWith("inline") && style.display !== "contents";
      if (block) flush();
      if (/^H[1-6]$/.test(t)) cur += "#".repeat(Number(t[1])) + " ";
      else if (t === "LI") cur += "- ";
      // A label's words are its control's name already.
      const quietHere = quietText || (t === "LABEL" && !!el.control);
      const kids = t === "SLOT" && el.assignedNodes().length ? el.assignedNodes() : (el.shadowRoot ?? el).childNodes;
      for (const c of kids) walk(c, quietHere);
      if (style.display === "table-cell") cur += " | ";
      if (block) flush();
    };
    if (document.body) walk(document.body, false);
    flush();
    return { url: location.href, title: clean(document.title, 200), text: out.join("\\n"), n: S.n };
  }
  const find = (n) => { const el = S.els.get(n)?.deref(); return el && el.isConnected ? el : null; };
  /** Where to click it, or that a synthetic click was made because something covers it. */
  function point(n) {
    const el = find(n);
    if (!el) return { gone: true };
    if (el.disabled) return { fail: "it is disabled" };
    // One tab: a link or form that would open another opens here.
    const opener = el.closest("a[target], form[target]") ?? (el.form?.hasAttribute("target") ? el.form : null);
    if (opener) opener.target = "_self";
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    let top = document.elementFromPoint(x, y);
    while (top?.shadowRoot?.elementFromPoint(x, y) && top.shadowRoot.elementFromPoint(x, y) !== top) top = top.shadowRoot.elementFromPoint(x, y);
    const hit = top && (el.contains(top) || top.contains(el) || el.getRootNode().host?.contains?.(top) || (el.labels && [...el.labels].some((l) => l.contains(top))));
    if (!r.width || !r.height || !hit) { el.click(); return { clicked: true }; }
    return { x, y };
  }
  /** Ready to type into: focused, with what it holds selected so the new text replaces it. */
  function focus(n) {
    const el = find(n);
    if (!el) return { gone: true };
    const k = kind(el, getComputedStyle(el));
    if (k !== "field" && k !== "password field") return { fail: "it isn't a field to type into" };
    if (el.disabled || el.readOnly) return { fail: "it can't be changed" };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    el.focus();
    if (typeof el.select === "function") { try { el.select(); } catch {} }
    else { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    return { empty: !("value" in el ? el.value : el.innerText) };
  }
  function pick(n, text) {
    const el = find(n);
    if (!el) return { gone: true };
    if (tag(el) !== "SELECT") return { fail: "it isn't a select" };
    if (el.disabled) return { fail: "it is disabled" };
    const want = String(text).trim().toLowerCase(), options = [...el.options];
    const o = options.find((x) => x.label.trim().toLowerCase() === want) ?? options.find((x) => x.value.toLowerCase() === want) ?? options.find((x) => x.label.toLowerCase().includes(want));
    if (!o) return { fail: "it has no option " + JSON.stringify(text) };
    o.selected = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return {};
  }
  /** The form this action would send, or null: a click on a submit control, or Enter in a form's field. */
  function sends(n, how) {
    const el = find(n);
    if (!el) return null;
    let form, by;
    if (how === "click") {
      by = el.closest("button, input");
      const ty = (by?.getAttribute("type") || "").toLowerCase();
      const submits = by && (tag(by) === "BUTTON" ? ty === "" || ty === "submit" : ty === "submit" || ty === "image");
      form = submits ? by.form : null;
    } else if (tag(el) === "INPUT") form = el.form;
    // A page load this element posted before without a go-ahead: it asks from then on.
    if (!form) return S.held.has(el) ? { site: location.host, to: location.host, method: "POST", button: name(el, "button"), fields: [] } : null;
    const method = (by?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
    if (method === "dialog") return null;
    const all = [...form.elements];
    const heavy = all.some((e) => e.type === "password" || e.type === "file" || tag(e) === "TEXTAREA");
    const search = form.getAttribute("role") === "search" || !!form.closest("[role=search]") || all.some((e) => e.type === "search");
    // A form that only looks something up: sent in the address, to a stated place or as a search.
    if (method === "get" && !heavy && !S.held.has(el) && (form.hasAttribute("action") || search)) return null;
    const fields = [];
    for (const e of all) {
      const k = kind(e, getComputedStyle(e));
      if (!k || k === "button" || e.disabled) continue;
      if ((k === "checkbox" || k === "radio") && !e.checked) continue;
      const v = k === "checkbox" || k === "radio" ? "yes" : k === "file field" ? "" : value(e);
      if (v || k === "password field") fields.push({ name: name(e, k).replace(/\\s*[:：]$/, "") || k, value: v });
    }
    let to = location.host;
    try { to = new URL(by?.getAttribute("formaction") || form.getAttribute("action") || location.href, location.href).host; } catch {}
    return { site: location.host, to, method: method.toUpperCase(), button: by ? name(by, "button") : "", fields: fields.slice(0, 40) };
  }
  const hold = (n) => { const el = find(n); if (el) S.held.add(el); };
  /** A numbered thing in words, for a card that asks about an action on it. */
  const what = (n) => { const el = find(n); const k = el && kind(el, getComputedStyle(el)); return { site: location.host, what: k ? k + " " + JSON.stringify(name(el, k)) : "" }; };
  globalThis.__ly = { snap, point, focus, pick, sends, hold, what };
})`;

/** Runs an expression in the page's own world of ours, making the world again after a page change. */
async function page(expression) {
  for (let again = 0; ; again++) {
    try {
      if (world === undefined) {
        const made = await send("Page.createIsolatedWorld", { frameId: frame, worldName: "lyrica" });
        await send("Runtime.evaluate", { expression: `${PAGE}(${refs})`, contextId: made.executionContextId });
        world = made.executionContextId;
      }
      const r = await send("Runtime.evaluate", { expression, contextId: world, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } catch (err) {
      world = undefined;
      if (again >= 2) throw err;
      await sleep(150);
    }
  }
}

/** Waits for what an action set off: a page load if one began, then a moment for the page to fill itself in. */
async function settle() {
  await sleep(400);
  if (loading) await Promise.race([new Promise((r) => stopped.push(r)), sleep(LOAD_MS)]);
  await sleep(SETTLE_MS);
}

async function snapshot() {
  const s = await page("__ly.snap()");
  refs = Math.max(refs, s.n);
  return { url: s.url, title: s.title, text: s.text, notes: notes.splice(0) };
}

const key = (type, k, code, extra = {}) => send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...extra });
const GONE = "That number isn't on the page any more. Here is the page as it is now.";

const ops = {
  async open({ url }) {
    loading = true;
    let r = await send("Page.navigate", { url });
    // The sandbox's network can still be coming up at a browser's first page: once more.
    if (r.errorText === "net::ERR_NETWORK_CHANGED") { await sleep(1000); loading = true; r = await send("Page.navigate", { url }); }
    // A download or a page that fails to load never fires a load event.
    if (r.errorText) { loading = false; return { fail: r.errorText === "net::ERR_ABORTED" ? "that address is a download, which the browser refuses, or the page stopped loading" : r.errorText }; }
    if (loading) await Promise.race([new Promise((res) => stopped.push(res)), sleep(LOAD_MS)]);
    await sleep(SETTLE_MS);
    return snapshot();
  },
  read: () => snapshot(),
  async sends({ action, ref, submit }) {
    const how = action === "click" ? "click" : action === "type" && submit ? "enter" : undefined;
    return { sends: how ? await page(`__ly.sends(${Number(ref)}, ${JSON.stringify(how)})`) : null, ...(await page(`__ly.what(${Number(ref)})`)) };
  },
  async click({ ref, approved }) {
    return acting(ref, "click", approved, async () => {
      const at = await page(`__ly.point(${Number(ref)})`);
      if (at.gone || at.fail) return at;
      if (at.clicked) return {};
      const mouse = { x: at.x, y: at.y, button: "left", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
      return {};
    });
  },
  async type({ ref, text, submit, approved }) {
    return acting(ref, submit ? "enter" : undefined, approved, async () => {
      const f = await page(`__ly.focus(${Number(ref)})`);
      if (f.gone || f.fail) return f;
      if (text) await send("Input.insertText", { text: String(text) });
      else if (!f.empty) { await key("keyDown", "Delete", 46); await key("keyUp", "Delete", 46); }
      if (submit) { await key("keyDown", "Enter", 13, { text: "\r" }); await key("keyUp", "Enter", 13); }
      return {};
    });
  },
  async select({ ref, text }) {
    return acting(ref, undefined, false, () => page(`__ly.pick(${Number(ref)}, ${JSON.stringify(String(text ?? ""))})`));
  },
  async scroll({ direction }) {
    await page(`window.scrollBy(0, ${direction === "up" ? -1 : 1} * innerHeight * 0.85)`);
    await sleep(SETTLE_MS);
    return snapshot();
  },
  async back() {
    const h = await send("Page.getNavigationHistory");
    const before = h.entries[h.currentIndex - 1];
    if (!before || before.url === "about:blank") return { fail: "there is no earlier page" };
    loading = true;
    await send("Page.navigateToHistoryEntry", { entryId: before.id });
    await Promise.race([new Promise((r) => stopped.push(r)), sleep(3000)]);
    loading = false;
    await sleep(SETTLE_MS);
    return snapshot();
  },
  async screenshot() {
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const s = await page("({ url: location.href, title: document.title })");
    return { url: s.url, title: s.title, image: shot.data };
  },
};

/** One action on a numbered thing: refused without a go-ahead when it would send a form, and a post it sets off without one is stopped. */
async function acting(ref, how, approved, run) {
  if (how) {
    const form = await page(`__ly.sends(${Number(ref)}, ${JSON.stringify(how)})`);
    if (form && !approved) return { unapproved: form };
  }
  mayPost = !!approved;
  heldPost = undefined;
  try {
    const r = await run();
    if (r.fail) return { fail: r.fail };
    if (r.gone) return { ...(await snapshot()), fail: GONE };
    await settle();
  } finally { mayPost = false; }
  if (heldPost) {
    await page(`__ly.hold(${Number(ref)})`).catch(() => {});
    notes.push(`The page tried to send a form to ${heldPost}. That needs the user's go-ahead, so nothing was sent; the same action again asks them.`);
  }
  return snapshot();
}

(async () => {
  const { targetInfos } = await send("Target.getTargets");
  target = targetInfos.find((t) => t.type === "page")?.targetId ?? (await send("Target.createTarget", { url: "about:blank" })).targetId;
  const attached = await send("Target.attachToTarget", { targetId: target, flatten: true });
  await send("Target.setDiscoverTargets", { discover: true });
  await quiet(send("Browser.setDownloadBehavior", { behavior: "deny" }));
  session = attached.sessionId;
  await send("Page.enable");
  frame = (await send("Page.getFrameTree")).frameTree.frame.id;
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document" }] });

  try {
    const kept = JSON.parse(readFileSync(COOKIES, "utf8"));
    await Promise.all(kept.map((c) => quiet(send("Storage.setCookies", { cookies: [c] }, true))));
  } catch {}
  const keepCookies = async () => {
    const { cookies } = await send("Storage.getCookies", {}, true);
    writeFileSync(COOKIES, JSON.stringify(cookies.map(({ expires, size, session, ...c }) => (session ? c : { ...c, expires }))), { mode: 0o600 });
  };
  // Chromium is asked to close and left to exit by itself, so its cookies are written; killed only if it doesn't.
  const shut = async () => { quiet(send("Browser.close", {}, true)); await sleep(5000); quit(); };
  // Requests are answered one at a time, in order.
  let line = "", queue = Promise.resolve();
  const answer = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const handle = async (text) => {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.op === "close") return shut();
    try { answer({ id: m.id, ...(ops[m.op] ? await ops[m.op](m) : { fail: `unknown op ${m.op}` }) }); }
    catch (err) { answer({ id: m.id, fail: String(err.message ?? err) }); }
    if (m.op !== "sends") await quiet(keepCookies());
  };
  process.stdin.on("data", (d) => {
    line += d.toString();
    let i;
    while ((i = line.indexOf("\n")) >= 0) { const text = line.slice(0, i); line = line.slice(i + 1); queue = queue.then(() => handle(text)); }
  });
  process.stdin.on("end", () => { queue = queue.then(shut); });
  answer({ ready: true });
})().catch((e) => { process.stdout.write(JSON.stringify({ fail: String(e.message ?? e) }) + "\n"); quit(); });
