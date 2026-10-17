import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  testMatch: ["drag-window.spec.ts", "window-transfer.spec.ts"],
  outputDir: "test-results/drag-window",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1441",
    channel: "msedge",
    viewport: { width: 1280, height: 920 },
  },
  webServer: {
    command: "npm run dev -- --port 1441",
    url: "http://127.0.0.1:1441",
    reuseExistingServer: false,
    env: { NEARLY_ENABLE_MOCK: "1" },
  },
});
