import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/ui',
  testMatch:['navigation-visual-repairs.spec.ts','nearly-parent-hidden.spec.ts','navigation.spec.ts'],
  outputDir:'test-results/visual-repairs',timeout:30000,workers:2,
  use:{baseURL:'http://127.0.0.1:1433',channel:'msedge',viewport:{width:1280,height:920}},
  webServer:{command:'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1433 --strictPort',url:'http://127.0.0.1:1433',reuseExistingServer:false,env:{NEARLY_ENABLE_MOCK:'1'}},
  reporter:'list',
});
