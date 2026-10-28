/**
 * These paths look trivial and have each broken the app once:
 *  - the preload's extension: the windows are sandboxed, so each preload is the
 *    single CommonJS bundle `.cjs` that scripts/build-preloads.mjs writes. A
 *    preload Electron cannot load fails silently: `window.sapiomSetup` never
 *    existed and onboarding hung on a frozen window with no error anywhere.
 *  - the web dir: pointed at the wrong place, the app boots and serves a blank
 *    page (the smoke check's http-spa covers the packaged case).
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  desktopPreloadPath,
  resolveWebDir,
  setupHtmlPath,
  setupPreloadPath,
  updatePreloadPath,
} from "./paths.js";

describe("preload paths", () => {
  it("point at the bundled .cjs files: a sandboxed preload cannot be ESM", () => {
    expect(setupPreloadPath().endsWith(path.join("preload", "setup.cjs"))).toBe(true);
    expect(desktopPreloadPath().endsWith(path.join("preload", "desktop.cjs"))).toBe(true);
    expect(updatePreloadPath().endsWith(path.join("preload", "update.cjs"))).toBe(true);
  });

  it("is absolute (a relative preload path is resolved against an unpredictable cwd)", () => {
    expect(path.isAbsolute(setupPreloadPath())).toBe(true);
  });
});

describe("setupHtmlPath", () => {
  it("points at the renderer asset the build copies into dist", () => {
    expect(setupHtmlPath().endsWith(path.join("renderer", "setup.html"))).toBe(true);
    expect(path.isAbsolute(setupHtmlPath())).toBe(true);
  });
});

describe("resolveWebDir", () => {
  it("resolves the harness's own built SPA, not a path relative to this app", () => {
    const webDir = resolveWebDir();
    expect(path.isAbsolute(webDir)).toBe(true);
    expect(webDir.endsWith(path.join("dist", "web"))).toBe(true);
    // Must live inside the @sapiom/harness package: resolving it relative to
    // this app would break the moment packaging moves either one.
    expect(webDir).toContain(path.join("harness"));
  });
});
