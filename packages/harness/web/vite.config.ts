import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Built SPA is served statically by the harness server from dist/web.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev:web` proxies API/WS to a locally running harness server.
    proxy: {
      "/api": "http://localhost:4100",
      "/canvas": "http://localhost:4100",
      "/ws": { target: "ws://localhost:4100", ws: true },
    },
  },
});
