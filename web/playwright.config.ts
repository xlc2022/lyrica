import { defineConfig, devices } from "@playwright/test";

// Each viewport gets its own lyricad (web/e2e/serve.ts), so both start locked.
// Build the UI first: npm run build && npm run e2e -w @lyrica/web
const servers = [
  { name: "phone", port: 7341, use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, defaultBrowserType: "chromium" as const } },
  { name: "desktop", port: 7342, use: { viewport: { width: 1280, height: 800 } } },
  // A lyricad with no self.db, for the setup page (setup.spec.ts).
  { name: "setup", port: 7343, use: { viewport: { width: 1280, height: 800 } }, setup: true },
];

export default defineConfig({
  testDir: "e2e",
  workers: 1,
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
  projects: servers.map((s) => ({ name: s.name, testMatch: s.setup ? /setup\.spec\.ts/ : /web\.spec\.ts/, use: { ...s.use, baseURL: `http://127.0.0.1:${s.port}` } })),
  webServer: servers.map((s) => ({
    command: `npx tsx e2e/serve.ts ${s.port} ${s.port + 10}${s.setup ? " setup" : ""}`,
    url: `http://127.0.0.1:${s.port}/api/state`,
    reuseExistingServer: false,
    stdout: "pipe" as const,
  })),
});
