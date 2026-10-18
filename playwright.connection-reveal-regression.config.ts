import base from './playwright.connection-reveal.config';
export default {...base,testMatch:['connection-reveal.spec.ts','modal-tree.spec.ts','tree-selection-v3.spec.ts','post-r1-tree-layout.spec.ts','tree-loading-silent.spec.ts'],outputDir:'test-results/connection-reveal-regression'};
