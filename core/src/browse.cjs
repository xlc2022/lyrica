// Runs in the sandbox with its own node (`node -e`): one Chromium for a thread's `browse` tool, driven over the
// DevTools protocol on a pipe (core/src/browse.ts, browseArgv). It reaches the network as the sandbox allows.
// Arguments: profile folder, user agent. It reads one JSON request per line on stdin ({ id, op, ... }) and answers
// each with one JSON line ({ id, ... } or { id, fail }). No packages: the sandbox has none.
//
// What is structural here (docs/briefs/browse.md): an action that would send a form is done only when the request
// says `approved`, and a page load that posts without it is failed in the browser, so nothing is sent.
const { spawn } = require("node:child_process");
const { rmSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const [profile, agent] = process.argv.slice(1);
const LOAD_MS = 20_000, SETTLE_MS = 600;
// Anubis works out a proof of work in the page, a few seconds, and then loads the real page by itself.
const CHECK_MS = 30_000;
// Chromium can drop a cookie with no end date when it closes, and writes none for a while after it is set, so a
// browser that is killed loses a fresh login. The cookies are kept here too, in the profile, after each action,
// and given back at the next start.
const COOKIES = `${profile}/lyrica-cookies.json`;
// A file a page offers is saved here under its download's id, then lyricad moves it into her folder. One that
// grows past DOWNLOAD_BYTES or takes over DOWNLOAD_MS is cancelled.
const DOWNLOADS = `${profile}/downloads`, DOWNLOAD_BYTES = 100_000_000, DOWNLOAD_MS = 60_000;
/** Downloads not yet answered, by id: the site's name for the file, its state and size, and when it ends. */
const downloads = new Map();

mkdirSync(profile, { recursive: true });
// What an earlier browser left half-saved or unmoved is gone.
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });
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

let next = 1, session, target, frame;
/**
 * Every frame of the page by id: the session that reaches it (the page's own, or a frame from another site's), its
 * parent, and our world in it with that world's generation. A number she sees is ours, mapped to a frame's world and
 * that world's own number for the element, so a number never comes to mean something else, in any frame.
 */
const frames = new Map();
let seq = 0, refs = 0;
const numbers = new Map(), byNumber = new Map();
/** Whether the main frame is loading, and who waits for it to stop. */
let loading = false, stopped = [];
/** A form post may go: only while an approved action runs. What was stopped otherwise, by host. */
let mayPost = false, heldPost;
let notes = [];
const waiting = new Map();
/** A command to the page's session; `to` true sends it to the browser, a string to that session. */
const send = (method, params = {}, to) => new Promise((resolve, reject) => {
  const id = next++;
  const sid = to === true ? undefined : typeof to === "string" ? to : session;
  waiting.set(id, { resolve, reject });
  toChrome.write(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }) + "\0");
});
const quiet = (p) => p.catch(() => {});

/** A frame from another site, in a session of its own: held until its posts are watched too, then let go. */
async function attachFrame(sid, id) {
  const f = frames.get(id);
  frames.set(id, { ...f, sid, world: undefined });
  await Promise.all([
    send("Page.enable", {}, sid), send("DOM.enable", {}, sid),
    send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document" }] }, sid),
    send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid),
  ].map(quiet));
  await quiet(send("Runtime.runIfWaitingForDebugger", {}, sid));
}

function onEvent(m) {
  const p = m.params ?? {};
  // What a frame's session raised is answered in that session.
  const sid = m.sessionId;
  if (m.method === "Page.frameStartedLoading" && p.frameId === frame) loading = true;
  else if ((m.method === "Page.frameStoppedLoading" && p.frameId === frame) || (m.method === "Page.loadEventFired" && sid === session)) {
    loading = false;
    for (const r of stopped.splice(0)) r();
  } else if (m.method === "Page.frameAttached") {
    if (!frames.has(p.frameId)) frames.set(p.frameId, { sid, parent: p.parentFrameId });
    else frames.get(p.frameId).parent = p.parentFrameId;
  } else if (m.method === "Page.frameDetached" && p.reason !== "swap") frames.delete(p.frameId);
  else if (m.method === "Page.frameNavigated") {
    const f = frames.get(p.frame.id);
    if (f) f.world = undefined;
    else frames.set(p.frame.id, { sid, parent: p.frame.parentId });
  } else if (m.method === "Target.attachedToTarget") {
    // Anything else held at its start (a worker) is let go at once.
    if (p.targetInfo.type === "iframe") void attachFrame(p.sessionId, p.targetInfo.targetId);
    else quiet(send("Runtime.runIfWaitingForDebugger", {}, p.sessionId));
  } else if (m.method === "Target.detachedFromTarget") { for (const [id, f] of frames) if (f.sid === p.sessionId && id !== frame) frames.delete(id); }
  else if (m.method === "Browser.downloadWillBegin") {
    let finish;
    const done = new Promise((r) => (finish = r));
    downloads.set(p.guid, { name: String(p.suggestedFilename || "download"), state: "inProgress", bytes: 0, done, finish });
  } else if (m.method === "Browser.downloadProgress") {
    const d = downloads.get(p.guid);
    if (!d) return;
    d.bytes = p.receivedBytes;
    if (p.state === "inProgress" && p.receivedBytes > DOWNLOAD_BYTES && !d.big) { d.big = true; quiet(send("Browser.cancelDownload", { guid: p.guid }, true)); }
    if (p.state !== "inProgress") { d.state = p.state; d.finish(); }
  } else if (m.method === "Page.javascriptDialogOpening") {
    // A message is closed; a question is answered no, so nothing is confirmed that she didn't see.
    const accept = p.type === "alert" || p.type === "beforeunload";
    if (p.type !== "beforeunload") notes.push(`The page showed a ${p.type === "alert" ? "message" : "question"} box, ${accept ? "closed" : "answered no"}: ${JSON.stringify(String(p.message).slice(0, 300))}`);
    quiet(send("Page.handleJavaScriptDialog", { accept }, sid));
  } else if (m.method === "Fetch.requestPaused") {
    const method = String(p.request.method).toUpperCase();
    if (method === "GET" || method === "HEAD" || mayPost) return void quiet(send("Fetch.continueRequest", { requestId: p.requestId }, sid));
    try { heldPost = new URL(p.request.url).host; } catch { heldPost = "another page"; }
    // Answered "no content", so nothing reaches the site and the page she was on stays.
    quiet(send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 204 }, sid));
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
  const S = { n: start, ids: new WeakMap(), els: new Map(), held: new WeakSet(), frames: [] };
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
    let s = "\\uE000" + ref(el) + "\\uE001 " + k + " " + JSON.stringify(name(el, k));
    if (k === "checkbox" || k === "radio") { if (el.checked || el.getAttribute("aria-checked") === "true") s += " (checked)"; }
    else if (k === "select") s += " = " + JSON.stringify(value(el)) + " (options: " + [...el.options].slice(0, 15).map((o) => clean(o.label, 40)).join(" | ") + (el.options.length > 15 ? " | …" : "") + ")";
    else if (k === "field" || k === "password field") s += " = " + JSON.stringify(value(el));
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " (disabled)";
    return s;
  }
  function snap() {
    S.frames = [];
    const out = [];
    let cur = "";
    const flush = () => { cur = cur.replace(/\\s+/g, " ").trim(); if (cur) out.push(cur); cur = ""; };
    const walk = (node, quietText) => {
      if (node.nodeType === 3) { if (!quietText) cur += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      const el = node, t = tag(el);
      if (SKIP.has(t) || !shown(el)) return;
      if (t === "BR") return flush();
      // A frame is marked where it stands; the driver puts its page there. One too small to see is left out.
      if (t === "IFRAME" || t === "FRAME") {
        flush();
        if (el.clientWidth < 2 || el.clientHeight < 2) return;
        S.frames.push(el);
        out.push("\\uE002" + (S.frames.length - 1) + "\\uE003" + clean(el.getAttribute("title") || el.src || "", 120) + "\\uE002");
        return;
      }
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
    // A posted form that is one plain text box and nothing else to fill in (the owner, 2026-11-11): many searches
    // are one. It goes without asking, and its post is let through.
    const filled = all.filter((e) => { const k = kind(e, getComputedStyle(e)); return k && k !== "button"; });
    const box = filled.length === 1 && tag(filled[0]) === "INPUT" && ["", "text", "search"].includes((filled[0].getAttribute("type") || "").toLowerCase());
    // Not one that says it deletes or removes, in its buttons, its box's name, where it goes or a hidden
    // _method (the owner, 2026-11-11): a "type DELETE to confirm" box is one text box too.
    const says = () => [by?.getAttribute("formaction"), form.getAttribute("action"), name(filled[0], "field"), ...all.map((e) => {
      const k = kind(e, getComputedStyle(e));
      return k === "button" ? name(e, k) : e.type === "hidden" && e.name === "_method" ? e.value : "";
    })].join(" ");
    if (method === "post" && box && !S.held.has(el) && !/delet|remov/i.test(says())) return { free: true };
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
  /** Which marked frame an element is, -1 if none. */
  const frameIndex = (el) => S.frames.indexOf(el);
  /** Where a frame's page starts on screen, inside its border and padding. */
  const box = (el) => { const r = el.getBoundingClientRect(), st = getComputedStyle(el); return { x: r.left + el.clientLeft + parseFloat(st.paddingLeft), y: r.top + el.clientTop + parseFloat(st.paddingTop) }; };
  globalThis.__ly = { snap, point, focus, pick, sends, hold, what, frameIndex, box };
})`;

/** Runs an expression in a frame's world of ours (the page's own by default), making the world again after a page change. */
async function inFrame(id, expression) {
  for (let again = 0; ; again++) {
    const f = frames.get(id);
    if (!f) throw new Error("the frame is gone");
    try {
      if (f.world === undefined) {
        const made = await send("Page.createIsolatedWorld", { frameId: id, worldName: "lyrica" }, f.sid);
        await send("Runtime.evaluate", { expression: `${PAGE}(0)`, contextId: made.executionContextId }, f.sid);
        f.world = made.executionContextId;
        f.seq = ++seq;
      }
      const r = await send("Runtime.evaluate", { expression, contextId: f.world, returnByValue: true }, f.sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } catch (err) {
      f.world = undefined;
      if (again >= 2) throw err;
      await sleep(150);
    }
  }
}
const page = (expression) => inFrame(frame, expression);

/** Calls `fn` on the element that holds a frame, in its parent's world of ours. */
async function onOwner(id, fn) {
  const f = frames.get(id), parent = f && frames.get(f.parent);
  if (!parent) throw new Error("the frame is gone");
  await inFrame(f.parent, "0");
  const { backendNodeId } = await send("DOM.getFrameOwner", { frameId: id }, parent.sid);
  const { object } = await send("DOM.resolveNode", { backendNodeId, executionContextId: parent.world }, parent.sid);
  const r = await send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, returnByValue: true }, parent.sid);
  return r.result.value;
}

/** Where a frame's page starts in the page's own coordinates, which is where a mouse event is sent. */
async function offset(id) {
  if (id === frame) return { x: 0, y: 0 };
  const own = await onOwner(id, "function () { return globalThis.__ly.box(this); }");
  const up = await offset(frames.get(id).parent);
  return { x: up.x + own.x, y: up.y + own.y };
}

/** Scrolls a frame into view in each frame around it, outermost first. */
async function reveal(id) {
  if (id === frame) return;
  await reveal(frames.get(id).parent);
  await onOwner(id, "function () { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }");
}

/** Our number for a frame world's own number for an element. */
function number(id, local) {
  const key = `${frames.get(id).seq}:${local}`;
  if (!numbers.has(key)) { numbers.set(key, ++refs); byNumber.set(refs, { id, seq: frames.get(id).seq, local }); }
  return numbers.get(key);
}
/** The frame and its own number for one of ours, or null when that page has changed since. */
function element(n) {
  const e = byNumber.get(Number(n));
  return e && frames.get(e.id)?.seq === e.seq ? e : null;
}
/** Runs a call on one of our numbers in its frame's world; undefined when it is gone. */
const onElement = (n, call) => { const e = element(n); return e ? inFrame(e.id, call(e.local)) : Promise.resolve(undefined); };

/** Waits for what an action set off: a page load if one began, then a moment for the page to fill itself in. */
async function settle() {
  await sleep(400);
  if (loading) await Promise.race([new Promise((r) => stopped.push(r)), sleep(LOAD_MS)]);
  await sleep(SETTLE_MS);
  await passCheck();
}

/** An Anubis check page goes on to the real page by itself: wait for that, so she reads the page and not the check. */
async function passCheck() {
  for (const end = Date.now() + CHECK_MS; Date.now() < end; await sleep(500)) {
    if (loading) { await Promise.race([new Promise((r) => stopped.push(r)), sleep(end - Date.now())]); await sleep(SETTLE_MS); continue; }
    const checking = await page(`!!document.getElementById("anubis_challenge")`).catch(() => true);
    if (!checking) return;
  }
}

/** Frames read inside one another at most this deep, and this many in one page. */
const FRAME_DEPTH = 3, FRAME_COUNT = 20;

/** A frame's page as text, our numbers on it, with each frame it shows read in where it stands. */
async function frameText(id, depth, count) {
  const s = await inFrame(id, "__ly.snap()");
  let text = s.text.replace(/\uE000(\d+)\uE001/g, (_, n) => `[${number(id, Number(n))}]`);
  const kids = new Map();
  for (const [kid, f] of frames) {
    if (f.parent !== id) continue;
    const i = await onOwner(kid, "function () { return globalThis.__ly ? globalThis.__ly.frameIndex(this) : -1; }").catch(() => -1);
    if (i >= 0) kids.set(i, kid);
  }
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(/\uE002(\d+)\uE003([^\uE002]*)\uE002/g)) {
    parts.push(text.slice(at, m.index));
    at = m.index + m[0].length;
    const kid = kids.get(Number(m[1]));
    let inner;
    if (kid && depth < FRAME_DEPTH && count.n < FRAME_COUNT) {
      count.n++;
      inner = await frameText(kid, depth + 1, count).catch(() => undefined);
    }
    if (!inner) { parts.push(`[a frame, not read: ${m[2]}]`); continue; }
    let host = inner.url;
    try { host = new URL(inner.url).host || inner.url; } catch {}
    parts.push(`[frame from ${host}]\n${inner.text || "(no text)"}\n[end of frame]`);
  }
  parts.push(text.slice(at));
  return { url: s.url, title: s.title, text: parts.join("") };
}

async function snapshot() {
  const s = await frameText(frame, 0, { n: 0 });
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
    // A download or a page that fails to load never fires a load event. A download is answered with the page still
    // shown, and the file.
    if (r.errorText === "net::ERR_ABORTED") { await sleep(500); if (downloads.size) { loading = false; return snapshot(); } }
    if (r.errorText) { loading = false; return { fail: r.errorText === "net::ERR_ABORTED" ? "the page stopped loading" : r.errorText }; }
    if (loading) await Promise.race([new Promise((res) => stopped.push(res)), sleep(LOAD_MS)]);
    await sleep(SETTLE_MS);
    await passCheck();
    return snapshot();
  },
  read: () => snapshot(),
  async sends({ action, ref, submit }) {
    const how = action === "click" ? "click" : action === "type" && submit ? "enter" : undefined;
    const form = how ? await onElement(ref, (n) => `__ly.sends(${n}, ${JSON.stringify(how)})`) : null;
    return { sends: form?.free ? null : form ?? null, ...((await onElement(ref, (n) => `__ly.what(${n})`)) ?? (await page("({ site: location.host, what: '' })"))) };
  },
  async click({ ref, approved }) {
    return acting(ref, "click", approved, async () => {
      const e = element(ref);
      if (!e) return { gone: true };
      // A thing in a frame: the frame into view first, then the thing in it, and the click where both put it.
      await reveal(e.id);
      const at = await inFrame(e.id, `__ly.point(${e.local})`);
      if (at.gone || at.fail) return at;
      if (at.clicked) return {};
      const o = await offset(e.id);
      const x = at.x + o.x, y = at.y + o.y;
      const mouse = { x, y, button: "left", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
      return {};
    });
  },
  async type({ ref, text, submit, approved }) {
    return acting(ref, submit ? "enter" : undefined, approved, async () => {
      const e = element(ref);
      if (!e) return { gone: true };
      await reveal(e.id);
      const f = await inFrame(e.id, `__ly.focus(${e.local})`);
      if (f.gone || f.fail) return f;
      if (text) await send("Input.insertText", { text: String(text) });
      else if (!f.empty) { await key("keyDown", "Delete", 46); await key("keyUp", "Delete", 46); }
      if (submit) { await key("keyDown", "Enter", 13, { text: "\r" }); await key("keyUp", "Enter", 13); }
      return {};
    });
  },
  async select({ ref, text }) {
    return acting(ref, undefined, false, async () => (await onElement(ref, (n) => `__ly.pick(${n}, ${JSON.stringify(String(text ?? ""))})`)) ?? { gone: true });
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

/** Waits for the downloads an action started, and answers each: saved (its id and size) or why not. */
async function finishDownloads() {
  if (!downloads.size) return [];
  const all = [...downloads];
  await Promise.race([Promise.all(all.map(([, d]) => d.done)), sleep(DOWNLOAD_MS)]);
  return all.map(([guid, d]) => {
    downloads.delete(guid);
    if (d.state === "completed") return { file: guid, name: d.name, bytes: d.bytes };
    if (d.state === "inProgress") quiet(send("Browser.cancelDownload", { guid }, true));
    rmSync(`${DOWNLOADS}/${guid}`, { force: true });
    return { name: d.name, fail: d.big ? `it is over ${DOWNLOAD_BYTES / 1e6} MB` : d.state === "inProgress" ? `it took over ${DOWNLOAD_MS / 1000} seconds` : "the site stopped it" };
  });
}

/** One action on a numbered thing: refused without a go-ahead when it would send a form, and a post it sets off without one is stopped. */
async function acting(ref, how, approved, run) {
  const form = how ? (await onElement(ref, (n) => `__ly.sends(${n}, ${JSON.stringify(how)})`)) ?? null : null;
  if (form && !form.free && !approved) return { unapproved: form };
  mayPost = !!approved || !!form?.free;
  heldPost = undefined;
  try {
    const r = await run();
    if (r.fail) return { fail: r.fail };
    if (r.gone) return { ...(await snapshot()), fail: GONE };
    await settle();
  } finally { mayPost = false; }
  if (heldPost) {
    await onElement(ref, (n) => `__ly.hold(${n})`).catch(() => {});
    notes.push(`The page tried to send a form to ${heldPost}. That needs the user's go-ahead, so nothing was sent; the same action again asks them.`);
  }
  return snapshot();
}

(async () => {
  const { targetInfos } = await send("Target.getTargets");
  target = targetInfos.find((t) => t.type === "page")?.targetId ?? (await send("Target.createTarget", { url: "about:blank" })).targetId;
  const attached = await send("Target.attachToTarget", { targetId: target, flatten: true });
  await send("Target.setDiscoverTargets", { discover: true });
  await quiet(send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOADS, eventsEnabled: true }, true));
  session = attached.sessionId;
  await send("Page.enable");
  await send("DOM.enable");
  frame = (await send("Page.getFrameTree")).frameTree.frame.id;
  frames.set(frame, { sid: session });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document" }] });
  // A frame from another site runs in a session of its own, held at its start until its posts are watched too.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  try {
    const kept = JSON.parse(readFileSync(COOKIES, "utf8"));
    await Promise.all(kept.map((c) => quiet(send("Storage.setCookies", { cookies: [c] }, true))));
  } catch {}
  const keepCookies = async () => {
    const { cookies } = await send("Storage.getCookies", {}, true);
    // Written whole or not at all: a kill in the middle leaves the file before.
    writeFileSync(`${COOKIES}.new`, JSON.stringify(cookies.map(({ expires, size, session, ...c }) => (session ? c : { ...c, expires }))), { mode: 0o600 });
    renameSync(`${COOKIES}.new`, COOKIES);
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
    let r;
    try { r = ops[m.op] ? await ops[m.op](m) : { fail: `unknown op ${m.op}` }; }
    catch (err) { r = { fail: String(err.message ?? err) }; }
    if (m.op !== "sends") { const got = await finishDownloads(); if (got.length) r = { ...r, downloads: got }; }
    // Kept before the answer, so a browser killed right after an action has them.
    if (m.op !== "sends") await quiet(keepCookies());
    answer({ id: m.id, ...r });
  };
  process.stdin.on("data", (d) => {
    line += d.toString();
    let i;
    while ((i = line.indexOf("\n")) >= 0) { const text = line.slice(0, i); line = line.slice(i + 1); queue = queue.then(() => handle(text)); }
  });
  process.stdin.on("end", () => { queue = queue.then(shut); });
  answer({ ready: true });
})().catch((e) => { process.stdout.write(JSON.stringify({ fail: String(e.message ?? e) }) + "\n"); quit(); });
