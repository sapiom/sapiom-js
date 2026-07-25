// Copies the setup window's static assets into dist/renderer.
// tsc emits only setup.js from src/renderer; the .html/.css must be copied.
//
// We ALSO resolve and copy the design-system token layer, so the onboarding
// window reads the SAME token values as the SPA instead of carrying its own
// snapshot of them (a snapshot silently drifts the moment a token changes).
//
// The resolution mirrors `packages/harness/web/vite.config.ts`'s
// `designSystemAlias()`: prefer the private `@sapiom/design-system` package when
// it's installed (official builds, authed to the private registry), else fall
// back to the harness's committed neutral token set. The seam exists because this
// repo is public and the branded package is not: a public clone must still build
// and render legibly. Vite does this with a resolve alias because its consumer is
// a CSS `@import` inside the bundle; this window has no bundler — `setup.html`
// links plain stylesheets — so the equivalent here is to copy the resolved files
// in under fixed names and let the <link>s reference those.
//
// Keep the two in step: if the seam's probe or the file layout changes in
// vite.config.ts, it changes here too.
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src", "renderer");
const outDir = join(root, "dist", "renderer");

const DS_PACKAGE = "@sapiom/design-system";

/**
 * Root directory to copy the token layer from, plus which seam we landed on.
 *
 * Probe the private package's manifest rather than its main entry: the design
 * system is CSS-only (no JS main), so resolving the bare specifier can throw
 * ERR_PACKAGE_PATH_NOT_EXPORTED even when it IS installed — the same reason
 * vite.config.ts probes `${DS_PACKAGE}/package.json`.
 */
function resolveDesignSystemDir() {
  try {
    return { dir: dirname(require.resolve(`${DS_PACKAGE}/package.json`)), seam: "private package" };
  } catch {
    // The harness owns the committed fallback; resolve it through the package so
    // this works from the workspace build regardless of cwd.
    const harnessRoot = dirname(require.resolve("@sapiom/harness/package.json"));
    return { dir: join(harnessRoot, "web", "src", "styles", "ds-neutral"), seam: "ds-neutral fallback" };
  }
}

await mkdir(outDir, { recursive: true });
for (const file of ["setup.html", "setup.css"]) {
  await cp(join(srcDir, file), join(outDir, file));
}

// Flattened on the way out (no themes/ subdir) so setup.html's CSP-safe
// same-origin <link href="./…"> stays a single flat directory.
const { dir: dsDir, seam } = resolveDesignSystemDir();
for (const [from, to] of [
  ["tokens.css", "ds-tokens.css"],
  [join("themes", "agent-cloud.css"), "ds-agent-cloud.css"],
]) {
  await cp(join(dsDir, from), join(outDir, to));
}

console.log(`copied renderer assets + design-system tokens (${seam}) → dist/renderer`);
