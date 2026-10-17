import { defineConfig } from "vite";
export default defineConfig(({ command }) => ({
  define: { __NEARLY_ENABLE_MOCK__: JSON.stringify(command === "serve" && process.env.NEARLY_ENABLE_MOCK === "1") },
  clearScreen: false,
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", "drag-preview": "drag-preview.html" } } },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
}));
