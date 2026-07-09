/**
 * Serves the built Vite SPA from dist/web. Falls back to a placeholder page
 * when the web bundle hasn't been built yet (e.g. `pnpm dev` without a prior
 * `pnpm build:web`), so the server is still useful for API/WS-only testing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { Router } from "express";

const PLACEHOLDER_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Sapiom Harness</title></head>
  <body style="font: 14px system-ui; padding: 2rem; color: #333;">
    <h1>Sapiom Harness</h1>
    <p>The web app hasn't been built yet. Run <code>pnpm --filter @sapiom/harness build:web</code>,
    or use <code>pnpm --filter @sapiom/harness dev:web</code> for a hot-reloading dev server.</p>
    <p>The API and WebSocket endpoints on this port are live.</p>
  </body>
</html>
`;

export function createStaticRouter(webDir: string): Router {
  const router = Router();
  const indexPath = join(webDir, "index.html");

  if (existsSync(indexPath)) {
    router.use(express.static(webDir));
    router.get("*", (_req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    router.get("*", (_req, res) => {
      res.status(200).set("Content-Type", "text/html").send(PLACEHOLDER_HTML);
    });
  }

  return router;
}
