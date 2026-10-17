import config from './playwright.config';
export default {...config,outputDir:'test-results/r1-drag-browser',use:{...config.use,baseURL:'http://127.0.0.1:1437'},webServer:{...config.webServer,command:'npm run dev -- --config vite.r1-drag.config.ts --port 1437 --strictPort',url:'http://127.0.0.1:1437'}};
