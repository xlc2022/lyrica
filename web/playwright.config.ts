import { defineConfig, devices } from "@playwright/test";

// Each project gets its own lyricad (web/e2e/serve.ts), so every one starts locked, and the projects run side by
// side, one worker each: each web-*.spec.ts file at phone and at desktop size, and the setup page. Keep one spec
// file per project, since two files of a project would share its lyricad; a new web-*.spec.ts file goes in SPECS.
// Build the UI first: npm run build && npm run e2e -w @lyrica/web
const SPECS = ["chat", "projects", "admin"];
const sizes = [
  { size: "phone", use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, defaultBrowserType: "chromium" as const } },
  { size: "desktop", use: { viewport: { width: 1280, height: 800 } } },
];
// Ports from 7341, each lyricad's fake model server 10 above its own (web/e2e/helpers.ts enter()).
const servers = [
  ...SPECS.flatMap((spec, i) => sizes.map((s, j) => ({ name: `${s.size}-${spec}`, port: 7341 + i * 2 + j, use: s.use, testMatch: new RegExp(`web-${spec}\\.spec\\.ts`), setup: false }))),
  // A lyricad with no self.db, for the setup page (setup.spec.ts).
  { name: "setup", port: 7341 + SPECS.length * 2, use: { viewport: { width: 1280, height: 800 } }, testMatch: /setup\.spec\.ts/, setup: true },
];

export default defineConfig({
  testDir: "e2e",
  workers: servers.length,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    // Dictation records from a fake microphone, and Read aloud plays without a gesture.
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
  },
  projects: servers.map((s) => ({ name: s.name, testMatch: s.testMatch, use: { ...s.use, baseURL: `http://127.0.0.1:${s.port}` } })),
  webServer: servers.map((s) => ({
    command: `npx tsx e2e/serve.ts ${s.port} ${s.port + 10}${s.setup ? " setup" : ""}`,
    url: `http://127.0.0.1:${s.port}/api/state`,
    reuseExistingServer: false,
    stdout: "pipe" as const,
  })),
});
