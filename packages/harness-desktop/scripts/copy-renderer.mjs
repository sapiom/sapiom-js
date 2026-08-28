// Copies the renderer windows' static assets into dist/renderer.
// tsc emits only the .js from src/renderer; the .html/.css must be copied.
//
// We ALSO resolve and copy the design-system token layer for the desktop-owned
// onboarding and update windows. A normal workspace build reads the SAME source
// as the SPA. A stable rollback may instead package an older published Harness,
// whose tarball contains the bundled SPA but omits these source-only token files;
// that explicit case uses this checkout's committed neutral layer for the two
// desktop windows. The packaged smoke test verifies its tokens and fonts resolve.
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
//
// The design system's LAYOUT is preserved, not flattened: its files reference
// each other relatively — `themes/studio.css` opens with
// `@import "./agent-cloud.css"` and `fonts.css` asks for
// `./assets/fonts/*.woff2`. Both breakages are silent (a failed CSS @import
// throws nothing; a missing face just renders system-ui), so the copy keeps the
// paths those references expect.
import { cp, mkdir, stat } from "node:fs/promises";
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
async function resolveDesignSystemDir() {
  try {
    return {
      dir: dirname(require.resolve(`${DS_PACKAGE}/package.json`)),
      seam: "private package",
    };
  } catch {
    // The harness owns the committed fallback. Prefer resolving it through the
    // installed package so workspace builds keep following the exact Harness
    // source they package.
    const harnessRoot = dirname(
      require.resolve("@sapiom/harness/package.json"),
    );
    const packagedFallback = join(
      harnessRoot,
      "web",
      "src",
      "styles",
      "ds-neutral",
    );
    try {
      await stat(join(packagedFallback, "tokens.css"));
      return { dir: packagedFallback, seam: "ds-neutral fallback" };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    // Published Harness tarballs contain only dist/, so an intentionally pinned
    // desktop rollback cannot read the fallback's source files through that
    // package. Packaging still runs from this repository; use and explicitly
    // validate the token anchor in its committed neutral layer for the
    // desktop-owned windows. The packaged smoke test below this build layer is
    // what verifies the full theme and font set resolves.
    const workspaceFallback = join(
      root,
      "..",
      "harness",
      "web",
      "src",
      "styles",
      "ds-neutral",
    );
    try {
      await stat(join(workspaceFallback, "tokens.css"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      throw new Error(
        `workspace ds-neutral fallback is missing tokens.css at ${workspaceFallback}`,
        { cause: err },
      );
    }
    return {
      dir: workspaceFallback,
      seam: "workspace ds-neutral fallback",
    };
  }
}

/**
 * Copy a part of the seam that may legitimately not exist, reporting whether it
 * did. Probed with `stat` rather than try/catch'd around the `cp` itself: a
 * catch there would also swallow EACCES, a wrong file type, or a HALF-FINISHED
 * recursive copy — the exact class of silent packaging bug this script exists to
 * prevent. Only ENOENT means "the seam doesn't ship this"; anything else throws.
 */
async function copyIfPresent(from, to, options) {
  try {
    await stat(from);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  await cp(from, to, options);
  return true;
}

await mkdir(outDir, { recursive: true });
for (const file of ["setup.html", "setup.css", "update.html", "update.css"]) {
  await cp(join(srcDir, file), join(outDir, file));
}

// The update window shows the desktop app icon (the black rounded-square "S" badge)
// as its brand mark — the SAME asset electron-builder ships as the app/dock icon —
// so the two can never drift. Copy it beside the renderer so update.html can
// reference it same-origin (<img src="./icon.png">, covered by img-src 'self').
await cp(join(root, "assets", "icon.png"), join(outDir, "icon.png"));

const { dir: dsDir, seam } = await resolveDesignSystemDir();

// tokens.css is the one file flattened and renamed on the way out (the `ds-`
// prefix marks the files this window does not own). Everything else keeps its
// LAYOUT, because the design-system files reference each other relatively:
//   themes/       stays a directory — themes/studio.css opens with
//                 `@import "./agent-cloud.css"`, a sibling lookup. A flattened
//                 copy breaks that import and silently restores the old accent.
//   assets/fonts/ stays at the path ds-fonts.css asks for
//                 (`url("./assets/fonts/Geist-Variable.woff2")`, resolved
//                 relative to ds-fonts.css — i.e. dist/renderer/).
// A subdirectory is still same-origin, so setup.html's CSP-safe
// <link href="./…"> links are unaffected by the nesting.
await cp(join(dsDir, "tokens.css"), join(outDir, "ds-tokens.css"));
await cp(join(dsDir, "themes"), join(outDir, "themes"), { recursive: true });

// The font layer is OPTIONAL — but only so an OFFICIAL build cannot hard-fail on
// a file we cannot inspect from here (the private package is absent from this
// repo and its lockfile; see web/vite.config.ts). The committed ds-neutral set
// DOES ship both, and a unit test pins that, so this tolerance can never quietly
// cover the seam every build here actually resolves. Degrading to system-ui is
// what this window did before it loaded any faces at all.
const fontCss = await copyIfPresent(
  join(dsDir, "fonts.css"),
  join(outDir, "ds-fonts.css"),
);
const fontFiles = await copyIfPresent(
  join(dsDir, "assets", "fonts"),
  join(outDir, "assets", "fonts"),
  {
    recursive: true,
  },
);

console.log(
  `copied renderer assets + design-system tokens (${seam}) → dist/renderer` +
    (fontCss && fontFiles
      ? ""
      : ` — NOTE: ${seam} ships no font layer, this window falls back to system-ui`),
);
