import broad from './playwright.lifecycle-broad.config';
export default {...broad, outputDir:'test-results/r1-broad',use:{...broad.use,baseURL:'http://127.0.0.1:1449'},webServer:{command:'npm run dev -- --config vite.r1-drag.config.ts --port 1449 --strictPort',url:'http://127.0.0.1:1449',reuseExistingServer:false,env:{NEARLY_ENABLE_MOCK:'1'}}};
