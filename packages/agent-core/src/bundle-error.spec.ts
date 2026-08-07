/**
 * Unit tests for describeBundleFailure — the mapping that turns esbuild's raw
 * "Could not resolve …" (by far the most common cause: a project whose deps
 * were never installed) into a one-line "run npm install" instruction, while
 * leaving every other bundle failure's message untouched.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeBundleFailure } from "./bundle-error";

describe("describeBundleFailure", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bundle-error-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps an unresolved import in a project with no node_modules to a run-npm-install hint", () => {
    const esbuildErr = new Error(
      "Build failed with 2 errors:\n" +
        'index.ts:1:31: ERROR: Could not resolve "@sapiom/agent"\n' +
        'index.ts:2:18: ERROR: Could not resolve "zod"',
    );

    const hint = describeBundleFailure(dir, esbuildErr);

    // Actionable instruction naming the directory the user must install in.
    expect(hint).toContain("Dependencies are not installed");
    expect(hint).toContain("npm install");
    expect(hint).toContain(dir);
    // Raw esbuild detail is preserved for anyone who needs it.
    expect(hint).toContain('Could not resolve "@sapiom/agent"');
  });

  it("leaves the raw message untouched when node_modules exists (a genuine bad import)", () => {
    mkdirSync(path.join(dir, "node_modules"));
    const esbuildErr = new Error(
      'index.ts:1:31: ERROR: Could not resolve "not-a-real-pkg"',
    );

    const hint = describeBundleFailure(dir, esbuildErr);

    // Deps are installed, so this is a real unresolved import — don't misdirect
    // the user to `npm install`.
    expect(hint).not.toContain("Dependencies are not installed");
    expect(hint).toBe(
      'index.ts:1:31: ERROR: Could not resolve "not-a-real-pkg"',
    );
  });

  it("leaves a non-resolution failure (syntax error) untouched even without node_modules", () => {
    const esbuildErr = new Error(
      'index.ts:3:5: ERROR: Expected ";" but found "const"',
    );

    const hint = describeBundleFailure(dir, esbuildErr);

    expect(hint).not.toContain("Dependencies are not installed");
    expect(hint).toBe('index.ts:3:5: ERROR: Expected ";" but found "const"');
  });

  it("stringifies a non-Error thrown value", () => {
    expect(describeBundleFailure(dir, "boom")).toBe("boom");
  });
});
