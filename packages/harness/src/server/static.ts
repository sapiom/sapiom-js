/**
 * Serves the built Vite SPA from dist/web. Falls back to a placeholder page
 * when the web bundle hasn't been built yet (e.g. `pnpm dev` without a prior
 * `pnpm build:web`), so the server is still useful for API/WS-only testing.
 *
 * Boot-token injection: every HTML response has a `<script>` block baked in
 * before `</head>` that sets `window.__HARNESS__ = { token, posthog }`.
 * This lets `getBootToken()` (web/src/lib/api.ts) resolve the token without
 * relying on the `?token=` query param — which is lost on navigation/reload
 * and caused every /api POST to 401 after the first page load (SAP-1898).
 *
 * PostHog config injection (SAP-1988): the same `<script>` also carries the
 * client PostHog project key + hosts, resolved server-side from env so ONE
 * shipped bundle (CLI + Electron) works across environments without a
 * build-time key. The token is a public client key by design; a documented
 * default points at the Sapiom product project (291192). Set
 * `SAPIOM_POSTHOG_KEY=""` (empty) to disable client analytics entirely — the
 * provider skips init when no key is present.
 *
 * Implementation note: `express.static` serves index.html directly on `/`
 * requests, bypassing any downstream handlers. To guarantee injection we:
 *   1. Use `express.static` with `index: false` so it never auto-serves
 *      index.html itself.
 *   2. Add a catch-all `GET *` that serves the pre-injected HTML string for
 *      any route that `express.static` didn't match (SPA deep-route fallback
 *      AND the root `/`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express, { Router, type Request, type Response } from "express";

const PLACEHOLDER_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Agent Studio</title></head>
  <body style="font: 14px system-ui; padding: 2rem; color: #333;">
    <h1>Agent Studio</h1>
    <p>The web app hasn't been built yet. Run <code>pnpm --filter @sapiom/harness build:web</code>,
    or use <code>pnpm --filter @sapiom/harness dev:web</code> for a hot-reloading dev server.</p>
    <p>The API and WebSocket endpoints on this port are live.</p>
  </body>
</html>
`;

/**
 * The client PostHog config, or null when analytics is disabled (no key).
 *
 * `SAPIOM_POSTHOG_KEY` overrides the default; setting it to an empty string is
 * an explicit opt-out that disables client capture (the provider skips init on
 * a missing key). Hosts default to PostHog US cloud — `apiHost` is the ingest
 * endpoint, `uiHost` keeps "view in PostHog" links pointing at the real app.
 */
interface PosthogClientConfig {
  key: string;
  apiHost: string;
  uiHost: string;
}

/** Documented default client key — the Sapiom product project (291192). */
const DEFAULT_POSTHOG_KEY = "phc_QmzsBloYUZJw7orDRBsEeV9Oz4lQ548cputd7RZ8pAq";

function resolvePosthogConfig(): PosthogClientConfig | null {
  // Explicit empty string disables; unset falls back to the default key.
  const key = process.env.SAPIOM_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY;
  if (!key.trim()) return null;
  return {
    key: key.trim(),
    apiHost: process.env.SAPIOM_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    uiHost: process.env.SAPIOM_POSTHOG_UI_HOST?.trim() || "https://us.posthog.com",
  };
}

/**
 * Builds the inline `<script>` that bakes the boot token (and client PostHog
 * config) into the page before any SPA JS runs. JSON.stringify ensures the
 * values are safely escaped even if they contain characters that could break a
 * bare string interpolation.
 */
function buildTokenScript(bootToken: string): string {
  const payload: { token: string; posthog?: PosthogClientConfig } = { token: bootToken };
  const posthog = resolvePosthogConfig();
  if (posthog) payload.posthog = posthog;
  const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<script>window.__HARNESS__ = ${safeJson};</script>`;
}

/**
 * Injects the boot-token `<script>` block into raw HTML. The block is
 * inserted immediately before `</head>` so it executes before any SPA modules
 * load. Falls back to prepending to `<body>` if `</head>` is absent (shouldn't
 * happen with our Vite output, but keeps the injection unconditional).
 */
function injectTokenScript(html: string, bootToken: string): string {
  const script = buildTokenScript(bootToken);
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  // Fallback: inject at the very start of <body> if </head> is missing.
  if (html.includes("<body>")) {
    return html.replace("<body>", `<body>${script}`);
  }
  // Last resort: prepend to the document.
  return script + html;
}

export function createStaticRouter(webDir: string, bootToken: string): Router {
  const router = Router();
  const indexPath = join(webDir, "index.html");

  if (existsSync(indexPath)) {
    // Read index.html once at startup. The file doesn't change at runtime
    // (it's a Vite build output), so a single read is fine and avoids
    // repeated disk I/O for every page navigation request.
    const rawHtml = readFileSync(indexPath, "utf-8");
    const injectedHtml = injectTokenScript(rawHtml, bootToken);

    // Serve hashed assets (JS, CSS, images) via express.static.
    // `index: false` prevents express.static from auto-serving index.html
    // on GET / — we handle that (and all SPA deep routes) in the catch-all
    // below so every HTML response always carries the injected token script.
    router.use(express.static(webDir, { index: false }));

    router.get("*", (_req: Request, res: Response) => {
      res.status(200).set("Content-Type", "text/html").send(injectedHtml);
    });
  } else {
    router.get("*", (_req: Request, res: Response) => {
      res.status(200).set("Content-Type", "text/html").send(PLACEHOLDER_HTML);
    });
  }

  return router;
}
