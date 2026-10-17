import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/connection-mode.spec.ts",
  outputDir: "test-results/production-browser",
  use: { ...base.use, baseURL: "http://127.0.0.1:1422" },
  webServer: {
    command: "vite preview --host 127.0.0.1 --port 1422 --strictPort",
    url: "http://127.0.0.1:1422",
    reuseExistingServer: false,
  },
});
