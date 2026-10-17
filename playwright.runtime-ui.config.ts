import config from './playwright.config';
export default {...config,outputDir:'test-results/runtime-ui-browser',use:{...config.use,baseURL:'http://127.0.0.1:1465'},webServer:{...config.webServer,command:'npm run dev -- --config vite.r1-drag.config.ts --port 1465 --strictPort',url:'http://127.0.0.1:1465'}};
