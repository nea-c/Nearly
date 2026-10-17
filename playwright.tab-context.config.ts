import {createRequire} from 'node:module';
import path from 'node:path';
const vite=path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')),'bin/vite.js');
import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/ui',testMatch:'retained-syncs.spec.ts',outputDir:'test-results/tab-context-ui/browser',timeout:20000,workers:1,use:{baseURL:'http://127.0.0.1:1454',channel:'msedge',viewport:{width:1180,height:850}},webServer:{command:`node "${vite}" build --outDir test-results/tab-context-ui/static && node "${vite}" preview --outDir test-results/tab-context-ui/static --host 127.0.0.1 --port 1454 --strictPort`,url:'http://127.0.0.1:1454',reuseExistingServer:false},reporter:'list'});
