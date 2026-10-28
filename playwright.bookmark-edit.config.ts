import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui',
  testMatch: ['bookmark-edit-regression.spec.ts', 'bookmark-tree.spec.ts', 'post-r1-bookmarks.spec.ts', 'side-bookmark-repairs.spec.ts', 'explorer-preferences.spec.ts'],
  outputDir: 'test-results/bookmark-edit',
  timeout: 30000,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:1441', channel: 'msedge', viewport: { width: 1280, height: 920 } },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1441 --strictPort',
    url: 'http://127.0.0.1:1441', reuseExistingServer: false, env: { NEARLY_ENABLE_MOCK: '1' },
  },
  reporter: 'list',
});
