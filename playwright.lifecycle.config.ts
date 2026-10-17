import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  testMatch: [
    "lifecycle-window.spec.ts",
    "drag-window.spec.ts",
    "window-transfer.spec.ts",
    "retained-syncs.spec.ts",
    "browse-restore.spec.ts",
  ],
  outputDir: "test-results/lifecycle-window",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1444",
    channel: "msedge",
    viewport: { width: 1280, height: 920 },
  },
  webServer: {
    command: "npm run dev -- --port 1444",
    url: "http://127.0.0.1:1444",
    reuseExistingServer: false,
    env: { NEARLY_ENABLE_MOCK: "1" },
  },
});
