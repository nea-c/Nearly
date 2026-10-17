import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', testMatch: 'startup-update.spec.ts', outputDir: 'test-results/startup-update',
  timeout: 15000, workers: 1, use: { baseURL: 'http://127.0.0.1:1432', channel: 'msedge', viewport: { width: 1000, height: 720 } },
  webServer: { command: 'node ../node_modules/vite/bin/vite.js --config vite.startup-update.config.mjs --host 127.0.0.1 --port 1432 --strictPort', url: 'http://127.0.0.1:1432', reuseExistingServer: false }, reporter: 'list',
});

