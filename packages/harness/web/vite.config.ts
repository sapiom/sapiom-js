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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type AliasOptions } from "vite";
import react from "@vitejs/plugin-react";

const HARNESS_SERVER = "http://localhost:4100";

const DS_PACKAGE = "@sapiom/design-system";
const DS_NEUTRAL_DIR = fileURLToPath(new URL("./src/styles/ds-neutral", import.meta.url));

/**
 * Resolve the design-system seam: prefer the private `@sapiom/design-system`
 * package when it's actually installed (official CI, authed to the private
 * registry), and fall back to the committed neutral token set otherwise
 * (public clones, this repo's own CI without the private registry).
 *
 * The only consumer is `styles.css`'s two CSS `@import "@sapiom/design-system/*"`
 * lines, resolved through Vite's alias resolver. When the private package is
 * present we DON'T alias the bare specifier at all — Vite resolves it to the
 * real package in node_modules (branded tokens). When it's absent we alias it
 * to `ds-neutral` (unbranded tokens) so the import still resolves and the app
 * renders legibly. Either way `styles.css` is unchanged — the swap is 100% at
 * the build seam.
 *
 * Rule: the private package and the neutral fallback expose the SAME token
 * NAMES; only the values differ. Never redefine a token in `styles.css` (it
 * bridges the upstream frontend var names onto these tokens via `var()` only).
 *
 * TODO(SAP-1773, CI): the "use the private package" half needs the official
 * build to install `@sapiom/design-system` from the private registry before
 * `build:web` (an authed `.npmrc`/registry step in the release workflow). That
 * private-registry/publish infra is not set up in this repo; until it is,
 * every build here resolves to the neutral fallback. Public clones must never
 * install it — the package is `private: true`, off public npm, and no brand
 * values are committed to this repo.
 */
function designSystemAlias(): AliasOptions {
  const require = createRequire(import.meta.url);
  let privatePackagePresent = false;
  try {
    // Probe for the package's manifest rather than its main entry: the design
    // system is CSS-only (no JS main), so `resolve("@sapiom/design-system")`
    // can throw ERR_PACKAGE_PATH_NOT_EXPORTED even when it IS installed.
    require.resolve(`${DS_PACKAGE}/package.json`);
    privatePackagePresent = true;
  } catch {
    privatePackagePresent = false;
  }

  // When present, add no alias — let Vite resolve the real package. When
  // absent, redirect the bare specifier (and its subpaths) to ds-neutral.
  return privatePackagePresent ? {} : { [DS_PACKAGE]: DS_NEUTRAL_DIR };
}

export default defineConfig({
  // The config lives in web/ but is invoked from the package root via
  // `--config web/vite.config.ts`, so pin the project root to this dir.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      // The frontend imports its runtime contract from `@shared/types`. It
      // resolves to the package's own canonical shared contract
      // (packages/harness/src/shared/types.ts) so the web and server always
      // build against one source of truth — no vendored copy to drift.
      "@shared/types": fileURLToPath(new URL("../src/shared/types.ts", import.meta.url)),
      // The local-run mapper is a pure fn shared with the server (its canonical
      // home is src/core/render-local-run.ts, per the ticket). The SPA imports
      // the SAME implementation to map an offline stub run's NDJSON traces into
      // the RunView the inspector renders — one mapper, no client/server drift.
      // It pulls in only the `LocalStepTrace` *type* from agent-core (erased at
      // build), so no agent-core runtime code enters the browser bundle.
      "@shared/render-local-run": fileURLToPath(new URL("../src/core/render-local-run.ts", import.meta.url)),
      // The design system is a private package. Official builds (private
      // package installed) render branded; public clones fall back to a
      // committed neutral token set. See designSystemAlias() above.
      ...designSystemAlias(),
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
