// Runs in the sandbox with its own node (`node -e`): opens one page in the sandbox's Chromium over the DevTools
// protocol on a pipe, with the network blocked, and prints one JSON line: what the page said and the screenshot.
// Arguments: url, width, height, wait after load (ms), load limit (ms). No packages: the sandbox has none.
const { spawn } = require("node:child_process");
const [url, width, height, wait, limit] = process.argv.slice(1);
const W = Number(width), H = Number(height);
const chrome = spawn(process.env.CHROME_PATH, [
  "--headless", "--no-sandbox", "--remote-debugging-pipe", "--user-data-dir=/tmp/chromium",
  // WebGL in software: the flags that worked in every run, where --disable-gpu leaves no WebGL at all.
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  // A page's own module and fetch calls between its files work as they do when served.
  "--allow-file-access-from-files",
  "--host-resolver-rules=MAP * ~NOTFOUND", "--disable-background-networking", "--no-first-run", "--disable-extensions",
  "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
// The end of what Chromium printed, to say why it stopped if it does.
let said = "";
chrome.stderr.on("data", (d) => { said = (said + d.toString()).slice(-4000); });
const why = () => {
  const lines = said.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? `: ${lines.slice(-6).join(" | ").slice(-800)}` : "";
};
const out = { console: [], errors: [], blocked: [], loaded: false };
let next = 1, session;
const waiting = new Map(), events = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = next++;
  waiting.set(id, { resolve, reject });
  toChrome.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
});
const cut = (s) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
const text = (a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type;
let loaded;
const onLoad = new Promise((r) => (loaded = r));
function event(m) {
  const p = m.params;
  if (m.method === "Runtime.consoleAPICalled") out.console.push({ level: p.type, text: cut(p.args.map(text).join(" ")) });
  else if (m.method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails;
    const what = (d.exception?.description ?? d.text).split("\n")[0];
    out.errors.push(cut(`${what}${d.url ? ` (${d.url.split("/").pop()}:${d.lineNumber + 1})` : ""}`));
  } else if (m.method === "Log.entryAdded" && (p.entry.level === "error" || p.entry.level === "warning") && !p.entry.text.includes("ERR_BLOCKED_BY_CLIENT")) {
    // A blocked request is listed once, under blocked.
    out.console.push({ level: p.entry.level, text: cut(p.entry.text) });
  }
  else if (m.method === "Fetch.requestPaused") {
    const local = /^(file|data|blob|about):/.test(p.request.url);
    if (!local && out.blocked.length < 20 && !out.blocked.includes(p.request.url)) out.blocked.push(cut(p.request.url));
    send(local ? "Fetch.continueRequest" : "Fetch.failRequest", local ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {});
  } else if (m.method === "Page.loadEventFired") loaded();
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
    } else if (m.method) event(m);
  }
});
const done = (result) => { process.stdout.write(JSON.stringify(result) + "\n"); chrome.kill("SIGKILL"); process.exit(0); };
chrome.on("exit", (code, signal) => done({ ...out, fail: `Chromium exited (${code ?? signal}) before the page was captured${why()}` }));
// A Chromium that dies resets its pipe before its exit is seen: wait a moment for the exit, rather than crash on the reset.
const lost = () => setTimeout(() => done({ ...out, fail: `Chromium closed its connection before the page was captured${why()}` }), 2000).unref();
for (const p of [toChrome, fromChrome]) p.on("error", lost);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await Promise.all(["Runtime.enable", "Log.enable", "Page.enable"].map((m) => send(m)));
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  out.loaded = await Promise.race([onLoad.then(() => true), sleep(Number(limit)).then(() => false)]);
  await sleep(Number(wait));
  const probe = "JSON.stringify({ title: document.title, canvases: [...document.querySelectorAll('canvas')].map((c) => [c.width, c.height]), text: (document.body?.innerText ?? '').trim().length })";
  const { result } = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
  Object.assign(out, JSON.parse(result.value));
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  done({ ...out, png: data });
})().catch((e) => done({ ...out, fail: String(e.message ?? e) }));
