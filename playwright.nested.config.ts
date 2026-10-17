import {createRequire} from 'node:module';
import path from 'node:path';
const vite=path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')),'bin/vite.js');
import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/ui',testMatch:'sync-profile-safety.spec.ts',outputDir:'test-results/nested-modal/browser',timeout:30000,workers:1,use:{baseURL:'http://127.0.0.1:1474',channel:'msedge',viewport:{width:1180,height:850}},webServer:{command:`node "${vite}" build --outDir test-results/nested-modal/static && node "${vite}" preview --outDir test-results/nested-modal/static --host 127.0.0.1 --port 1474 --strictPort`,url:'http://127.0.0.1:1474',reuseExistingServer:false},reporter:'list'});

