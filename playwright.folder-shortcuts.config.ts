import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', testMatch: ['folder-shortcuts.spec.ts', 'navigation.spec.ts', 'explorer-preferences.spec.ts'],
  outputDir: 'test-results/folder-shortcuts', workers: 2,
  use: { baseURL: 'http://127.0.0.1:1443', channel: 'msedge', viewport: { width: 1280, height: 920 } },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1443 --strictPort', url: 'http://127.0.0.1:1443', reuseExistingServer: false, env: { NEARLY_ENABLE_MOCK: '1' } },
  reporter: 'list',
});
