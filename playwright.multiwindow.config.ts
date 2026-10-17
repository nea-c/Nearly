import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  testMatch: "window-transfer.spec.ts",
  outputDir: "test-results/multiwindow-browser",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1437",
    channel: "msedge",
    viewport: { width: 1280, height: 920 },
  },
  webServer: {
    command: "npm run dev -- --port 1437",
    url: "http://127.0.0.1:1437",
    reuseExistingServer: false,
    env: { NEARLY_ENABLE_MOCK: "1" },
  },
  reporter: "list",
});
