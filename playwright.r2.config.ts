import config from './playwright.config';
export default {...config,outputDir:'test-results/r2-browser',use:{...config.use,baseURL:'http://127.0.0.1:1457'},webServer:{...config.webServer,command:'npm run dev -- --config vite.r1-drag.config.ts --port 1457 --strictPort',url:'http://127.0.0.1:1457'}};
