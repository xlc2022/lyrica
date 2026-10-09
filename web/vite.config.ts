import { defineConfig } from "vite";

// `npm run dev -w @lyrica/web` serves the UI and passes /api to lyricad (or the
// fake in test/fake-lyricad.ts) on LYRICA_API, default 127.0.0.1:7420.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { "/api": { target: process.env.LYRICA_API ?? "http://127.0.0.1:7420", changeOrigin: false } } },
});
