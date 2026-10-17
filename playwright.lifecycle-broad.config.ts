import lifecycle from "./playwright.lifecycle.config";
export default {
  ...lifecycle,
  testMatch: "**/*.spec.ts",
  testIgnore: "**/connection-mode.spec.ts",
  outputDir: "test-results/lifecycle-broad",
  workers: 2,
};
