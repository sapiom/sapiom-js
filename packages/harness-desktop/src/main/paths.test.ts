/**
 * A preload Electron cannot load fails silently, so sandboxed windows must point at the bundled
 * `.cjs` preloads; a wrong web dir serves a blank page (smoke's http-spa covers the packaged case).
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
