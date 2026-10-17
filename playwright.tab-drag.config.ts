import { defineConfig } from "@playwright/test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const vite = join(
  dirname(require.resolve("vite/package.json")),
  "bin",
  "vite.js",
);
export default defineConfig({
  testDir: "./tests/ui",
  testMatch: "tab-drag.spec.ts",
  outputDir: "test-results/tab-drag-ui/browser",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1457",
    channel: "msedge",
    viewport: { width: 1180, height: 850 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node "${vite}" build --outDir test-results/tab-drag-ui/static && node "${vite}" preview --outDir test-results/tab-drag-ui/static --host 127.0.0.1 --port 1457 --strictPort`,
    url: "http://127.0.0.1:1457",
    reuseExistingServer: false,
  },
});
