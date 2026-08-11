import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies API paths to the local Fastify service so the browser
// always sees one origin — mirroring the nginx layout in deployment.
//
// Both ports follow the environment scripts/dev.sh exports from .env, so a
// moved API_PORT does not leave the proxy pointing at nothing. strictPort makes
// a busy port an error rather than a silent shift to the next one, which would
// put the dev server somewhere PUBLIC_ORIGIN — and so the OAuth callback — no
// longer names.
const apiOrigin = `http://localhost:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_DEV_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": apiOrigin,
      "/auth": apiOrigin,
      "/webhooks": apiOrigin,
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
