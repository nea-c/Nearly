import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/ui',testMatch:['r1-settings.spec.ts','r1-selection.spec.ts','forest-checkbox.spec.ts','theme.spec.ts','jade-checkbox-geometry.spec.ts'],outputDir:'test-results/r1-focused',workers:1,timeout:30000,use:{baseURL:'http://127.0.0.1:1448',channel:'msedge',viewport:{width:1280,height:920}},webServer:{command:'npm run dev -- --config vite.r1-drag.config.ts --port 1448 --strictPort',url:'http://127.0.0.1:1448',reuseExistingServer:false,env:{NEARLY_ENABLE_MOCK:'1'}},reporter:'list'});

