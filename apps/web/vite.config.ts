import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dev server proxies API paths to the local Fastify service so the browser
// always sees one origin — mirroring the nginx layout in deployment.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: [".ngrok-free.app"],
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/webhooks": "http://localhost:8787",
      // The App-manifest handshake, GitHub's post-install Setup URL
      // (/setup/install), and the manifest callback are served by the api.
      // The trailing slash keeps bare /setup on the SPA screen.
      "/setup/": "http://localhost:8787",
    },
  },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
