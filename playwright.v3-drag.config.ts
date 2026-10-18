import config from './playwright.config';
export default {...config, testMatch:['native-drag-v3.spec.ts','transfer-v2-drop.spec.ts','post-r1-file-drop.spec.ts'],outputDir:'test-results/v3-drag',use:{...config.use,baseURL:'http://127.0.0.1:1424'},webServer:{...config.webServer,command:'npm run dev -- --port 1424 --strictPort',url:'http://127.0.0.1:1424'}};
