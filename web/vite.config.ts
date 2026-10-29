import { defineConfig } from "vite";

// `npm run dev -w @lyrica/web` serves the UI and passes /api to lyricad on
// LYRICA_API (default 127.0.0.1:7340). `npx tsx web/e2e/serve.ts 7340 7350`
// starts a throwaway lyricad with a fake model for that.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { "/api": { target: process.env.LYRICA_API ?? "http://127.0.0.1:7340", changeOrigin: false } } },
});
