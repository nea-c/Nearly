import { defineConfig } from 'vite';
export default defineConfig({ optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 1432, strictPort: true } });
