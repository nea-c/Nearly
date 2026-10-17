import {createRequire} from 'node:module';
import path from 'node:path';
const vite=path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')),'bin/vite.js');
import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/ui',testMatch:['theme.spec.ts','theme-explicit.spec.ts'],
  outputDir:'test-results/green-themes/browser',timeout:30000,workers:2,
  use:{baseURL:'http://127.0.0.1:1456',channel:'msedge',viewport:{width:1180,height:850}},
  webServer:{
    command:`node "${vite}" build --outDir test-results/green-themes/static && node "${vite}" preview --outDir test-results/green-themes/static --host 127.0.0.1 --port 1456 --strictPort`,url:'http://127.0.0.1:1456',reuseExistingServer:false,
  },reporter:'list',
});
