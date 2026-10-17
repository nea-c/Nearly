import base from './playwright.production.config';
export default {...base,outputDir:'test-results/r2-production-browser',use:{...base.use,baseURL:'http://127.0.0.1:1461'},webServer:{...base.webServer,command:'vite preview --host 127.0.0.1 --port 1461 --strictPort',url:'http://127.0.0.1:1461'}};
