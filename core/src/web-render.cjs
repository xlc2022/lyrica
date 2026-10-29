// Runs in the sandbox with its own node (`node -e`): opens one web page in the sandbox's Chromium over the DevTools
// protocol on a pipe, so a page built by JavaScript can be read (core/src/web.ts, renderArgv). It reaches the
// network as the sandbox allows, like curl; images and media aren't loaded. Prints one JSON line: { html } or { fail }.
// Arguments: url, user agent, load limit (ms), wait after load (ms). No packages: the sandbox has none.
const { spawn } = require("node:child_process");
const [url, agent, limit, wait] = process.argv.slice(1);
const chrome = spawn(process.env.CHROME_PATH, [
  "--headless", "--no-sandbox", "--remote-debugging-pipe", "--user-data-dir=/tmp/chromium", "--disable-gpu",
  "--disable-background-networking", "--no-first-run", "--disable-extensions", "--mute-audio",
  "--blink-settings=imagesEnabled=false", `--user-agent=${agent}`, "about:blank",
], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  // As for the page preview: everything Chromium writes goes under /tmp, the sandbox's own.
  env: { ...process.env, HOME: "/tmp/chromium", XDG_CONFIG_HOME: "/tmp/chromium/.config", XDG_CACHE_HOME: "/tmp/chromium/.cache" },
});
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
let next = 1, session, loaded;
const waiting = new Map();
const onLoad = new Promise((r) => (loaded = r));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = next++;
  waiting.set(id, { resolve, reject });
  toChrome.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
});
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
    } else if (m.method === "Page.loadEventFired") loaded();
    else if (m.method === "Fetch.requestPaused") {
      const skip = ["Image", "Media", "Font"].includes(m.params.resourceType);
      send(skip ? "Fetch.failRequest" : "Fetch.continueRequest", skip ? { requestId: m.params.requestId, errorReason: "BlockedByClient" } : { requestId: m.params.requestId }).catch(() => {});
    }
  }
});
const done = (result) => { process.stdout.write(JSON.stringify(result) + "\n"); chrome.kill("SIGKILL"); process.exit(0); };
chrome.on("exit", (code, signal) => done({ fail: `Chromium exited (${code ?? signal}) before the page was read` }));
const lost = () => setTimeout(() => done({ fail: "Chromium closed its connection before the page was read" }), 2000).unref();
for (const p of [toChrome, fromChrome]) p.on("error", lost);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await Promise.race([onLoad, sleep(Number(limit))]);
  await sleep(Number(wait));
  const { result } = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
  done({ html: String(result.value ?? "") });
})().catch((e) => done({ fail: String(e.message ?? e) }));
