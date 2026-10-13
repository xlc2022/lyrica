import { defineConfig, devices } from "@playwright/test";

// Each project gets its own lyricad (web/e2e/serve.ts), so phone and desktop
// both start locked, and the projects run side by side, one worker each. Keep
// one spec file per project: two files of a project would share its lyricad.
// Build the UI first: npm run build && npm run e2e -w @lyrica/web
const servers = [
  { name: "phone", port: 7351, use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, defaultBrowserType: "chromium" as const } },
  { name: "desktop", port: 7352, use: { viewport: { width: 1280, height: 800 } } },
  // A lyricad with no self.db, for the setup page (setup.spec.ts).
  { name: "setup", port: 7353, use: { viewport: { width: 1280, height: 800 } }, setup: true },
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
    launchOptions: { executablePath: "/nix/store/h0niwnr9jam08vbhhibr024xk9fchii8-lyrica-sandbox-tools/bin/chromium", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
  },
  projects: servers.map((s) => ({ name: s.name, testMatch: s.setup ? /setup\.spec\.ts/ : /web\.spec\.ts/, use: { ...s.use, baseURL: `http://127.0.0.1:${s.port}` } })),
  webServer: servers.map((s) => ({
    command: `npx tsx e2e/serve.ts ${s.port} ${s.port + 10}${s.setup ? " setup" : ""}`,
    url: `http://127.0.0.1:${s.port}/api/state`,
    reuseExistingServer: false,
    stdout: "pipe" as const,
  })),
});
