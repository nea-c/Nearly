import { defineConfig } from "@playwright/test";
export default defineConfig({
  outputDir: "test-results/browser",
  testDir: "./tests/ui",
  // Production defaults are tested separately against the built bundle.
  testIgnore: "**/connection-mode.spec.ts",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: "msedge",
    viewport: { width: 1280, height: 920 },
  },
  webServer: {
    command: "node scripts/ui-dev-server.mjs",
    url: "http://127.0.0.1:1420/__qa_ready",
    reuseExistingServer: false,
    env: { NEARLY_ENABLE_MOCK: "1" },
  },
  reporter: "list",
});
