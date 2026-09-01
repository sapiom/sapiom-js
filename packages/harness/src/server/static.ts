/**
 * Serves the built Vite SPA from dist/web. Falls back to a placeholder page
 * when the web bundle hasn't been built yet (e.g. `pnpm dev` without a prior
 * `pnpm build:web`), so the server is still useful for API/WS-only testing.
 *
 * Privileged bootstrap: only a browser request carrying the separate UI
 * launch credential receives `window.__HARNESS__.token`. A coding-agent PTY
 * knows this server's origin for `/ingest`, so an unconditional token-bearing
 * index page would let the model upgrade its ingest-only capability into full
 * `/api` mutation authority. A valid launch query establishes an HttpOnly,
 * same-site session cookie, then redirects to remove the UI credential before
 * any app/analytics code runs. Reloads and deep SPA routes stay authorized
 * without ever placing that UI credential in browser JavaScript.
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
import { timingSafeEqualString } from "./auth.js";

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
const UI_BOOTSTRAP_QUERY = "uiToken";
const UI_BOOTSTRAP_COOKIE = "sapiom_studio_ui";

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
function buildBootstrapScript(bootToken?: string): string {
  const payload: { token?: string; posthog?: PosthogClientConfig } = {};
  if (bootToken) payload.token = bootToken;
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
function injectBootstrapScript(html: string, bootToken?: string): string {
  const script = buildBootstrapScript(bootToken);
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

function cookieValue(req: Request, name: string): string {
  const header = req.header("cookie") ?? "";
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function queryValue(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === "string" ? value : "";
}

export function createStaticRouter(
  webDir: string,
  credentials: { bootToken: string; uiToken: string },
): Router {
  const router = Router();
  const indexPath = join(webDir, "index.html");

  if (existsSync(indexPath)) {
    // Read index.html once at startup. The file doesn't change at runtime
    // (it's a Vite build output), so a single read is fine and avoids
    // repeated disk I/O for every page navigation request.
    const rawHtml = readFileSync(indexPath, "utf-8");
    const publicHtml = injectBootstrapScript(rawHtml);
    const privilegedHtml = injectBootstrapScript(
      rawHtml,
      credentials.bootToken,
    );

    // Serve hashed assets (JS, CSS, images) via express.static.
    // `index: false` prevents express.static from auto-serving index.html
    // on GET / — we handle that (and all SPA deep routes) in the catch-all
    // below so every HTML response always carries the injected token script.
    router.use(express.static(webDir, { index: false }));

    router.get("*", (req: Request, res: Response) => {
      const queryAuthorized = timingSafeEqualString(
        queryValue(req, UI_BOOTSTRAP_QUERY),
        credentials.uiToken,
      );
      const cookieAuthorized = timingSafeEqualString(
        cookieValue(req, UI_BOOTSTRAP_COOKIE),
        credentials.uiToken,
      );
      if (queryAuthorized) {
        res.cookie(UI_BOOTSTRAP_COOKIE, credentials.uiToken, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        });
        const cleanUrl = new URL(req.originalUrl, "http://localhost");
        cleanUrl.searchParams.delete(UI_BOOTSTRAP_QUERY);
        res
          .status(303)
          .set("Cache-Control", "no-store")
          .set("Location", `${cleanUrl.pathname}${cleanUrl.search}`)
          .send();
        return;
      }
      res
        .status(200)
        .set("Content-Type", "text/html")
        .set("Cache-Control", "no-store")
        .set("Vary", "Cookie")
        .send(cookieAuthorized ? privilegedHtml : publicHtml);
    });
  } else {
    router.get("*", (_req: Request, res: Response) => {
      res.status(200).set("Content-Type", "text/html").send(PLACEHOLDER_HTML);
    });
  }

  return router;
}
