/**
 * Sapiom Harness web workspace — Vite config.
 *
 * Two build modes, one codebase:
 *  - Real local mode (`dev:web` / `build:web`): the app talks to the real
 *    Sapiom Harness server through same-origin `/api`, `/canvas`, and `/ws`.
 *    In dev those are proxied to `http://localhost:4100` (the harness
 *    server's fixed port — do not change it).
 *  - Mock/demo mode (`VITE_MOCK=1`, e.g. the Playwright suite): no backend,
 *    no localhost references, deterministic in-memory fixtures only — the
 *    proxy is skipped entirely so nothing can reach for :4100.
 *
 * The built SPA is emitted to ../dist/web and served statically by the
 * harness server.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HARNESS_SERVER = "http://localhost:4100";

export default defineConfig({
  // The config lives in web/ but is invoked from the package root via
  // `--config web/vite.config.ts`, so pin the project root to this dir.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      // The upstream engineering frontend imports its runtime contract from
      // `@shared/types`. We vendor that contract in src/lib/harness-types.ts;
      // re-pointing it at the package's own shared contract is a follow-up.
      "@shared/types": fileURLToPath(new URL("./src/lib/harness-types.ts", import.meta.url)),
      // The design system is a private package. Public builds resolve it to a
      // committed neutral fallback so `@import "@sapiom/design-system/*"` in
      // styles.css resolves and the app renders legibly; official builds swap
      // this alias for the private package.
      "@sapiom/design-system": fileURLToPath(new URL("./src/styles/ds-neutral", import.meta.url)),
    },
  },
  build: {
    // Served statically by the harness server from dist/web.
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // Mock/demo runs (VITE_MOCK=1) never talk to a server — skip the proxy
    // entirely so nothing can reach for :4100.
    proxy:
      process.env.VITE_MOCK === "1"
        ? undefined
        : {
            "/api": { target: HARNESS_SERVER },
            "/canvas": { target: HARNESS_SERVER },
            "/ws": { target: "ws://localhost:4100", ws: true },
          },
  },
});
