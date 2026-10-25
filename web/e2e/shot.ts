// Screenshots of the web UI, so a UI change can be looked at without a person:
// a throwaway lyricad from serve.ts with ada signed in, then each page at the
// phone (390×844) and desktop (1280×800) widths, light and dark.
// Usage, after `npm run build`:
//   npx tsx web/e2e/shot.ts [--out dir] [--phone|--desktop] [--light|--dark] [--full] [--model-facts] [page]...
// --model-facts seeds synthetic recorded model metadata for populated Status shots.
// A page is ada's route without `#/u/<id>/` (`settings`, `models/hosts`,
// `memory`; nothing for home), or a whole `#/...` route.
// Each picture is <out>/<page>-<width>-<theme>.png (out defaults to shots/);
// their paths are printed. The browser is $LYRICA_CHROMIUM, else the first of
// chromium-headless-shell, chromium or chromium-browser on the PATH, else
// Playwright's own.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const PASSPHRASE = "correct horse"; // serve.ts's

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 && !!args.splice(i, 1); };
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const out = resolve(value("--out") ?? "shots");
const only = { phone: flag("--phone"), desktop: flag("--desktop"), light: flag("--light"), dark: flag("--dark") };
const full = flag("--full");
const modelFacts = flag("--model-facts");
const pages = args.length ? args : [""];

const web = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(web, "dist", "index.html"))) throw new Error("the web UI isn't built: run npm run build first");

const sizes = [{ name: "390", width: 390, height: 844, mobile: true }, { name: "1280", width: 1280, height: 800, mobile: false }]
  .filter((s) => (!only.phone && !only.desktop) || (s.mobile ? only.phone : only.desktop));
const themes = (["light", "dark"] as const).filter((t) => (!only.light && !only.dark) || only[t]);

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });
const onPath = (name: string) => process.env.PATH?.split(delimiter).map((d) => join(d, name)).find((f) => existsSync(f));
const executablePath = process.env.LYRICA_CHROMIUM || ["chromium-headless-shell", "chromium", "chromium-browser"].map(onPath).find(Boolean);

const port = await freePort();
const modelPort = await freePort();
const server = spawn(process.execPath, ["--import", "tsx", join(web, "e2e", "serve.ts"), String(port), String(modelPort)], { cwd: web, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error("lyricad for screenshots exited");
    if (await fetch(`${base}/api/state`).then((r) => r.ok, () => false)) break;
    if (i > 300) throw new Error("lyricad for screenshots didn't start");
    await new Promise((r) => setTimeout(r, 200));
  }
  const unlock = await fetch(`${base}/api/unlock`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ passphrase: PASSPHRASE }) });
  if (!unlock.ok) throw new Error(`unlock: ${unlock.status} ${await unlock.text()}`);
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    mkdirSync(out, { recursive: true });
    let seeded = false;
    for (const size of sizes) for (const theme of themes) {
      const context = await browser.newContext({ baseURL: base, viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, colorScheme: theme });
      // The page shares the context's cookies, so this signs it in.
      const login = await context.request.post("/api/login", { data: { login: "ada", password: "pw" }, headers: { origin: base } });
      if (!login.ok()) throw new Error(`log in: ${login.status()} ${await login.text()}`);
      const { user } = await login.json() as { user: { id: string } };
      if (modelFacts && !seeded) {
        const seed = await fetch(`http://127.0.0.1:${modelPort}/model-facts-fixture`, { method: "POST", body: JSON.stringify({ userId: user.id }) });
        if (!seed.ok) throw new Error(`model facts fixture: ${seed.status}`);
        seeded = true;
      }
      const page = await context.newPage();
      for (const name of pages) {
        await page.goto(name.startsWith("#") ? `/${name}` : `/#/u/${user.id}/${name}`);
        // Not networkidle: the shell's user stream stays open for as long as the page does.
        await page.waitForFunction(() => !document.querySelector(".loading"));
        await page.waitForTimeout(500);
        const file = join(out, `${name.replace(/^#?\/*|\/$/g, "").replace(/[^\w.-]+/g, "-") || "home"}-${size.name}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: full });
        console.log(file);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}
