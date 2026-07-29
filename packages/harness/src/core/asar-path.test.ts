/**
 * One regex, four call sites, and every one of them was written from scratch —
 * which is how `POST /api/runs/local` shipped without it and died with
 * `spawn ENOTDIR` in the packaged app. These tests pin the shared helper the
 * call sites now share.
 */
import { describe, expect, it } from "vitest";

import { unpackedPath } from "./asar-path.js";

describe("unpackedPath", () => {
  it("redirects an app.asar path to its unpacked twin", () => {
    expect(unpackedPath("/Applications/Sapiom.app/Contents/Resources/app.asar/node_modules/@sapiom/harness")).toBe(
      "/Applications/Sapiom.app/Contents/Resources/app.asar.unpacked/node_modules/@sapiom/harness",
    );
  });

  it("handles Windows separators", () => {
    expect(unpackedPath("C:\\Users\\u\\AppData\\Local\\Sapiom\\resources\\app.asar\\node_modules\\x")).toBe(
      "C:\\Users\\u\\AppData\\Local\\Sapiom\\resources\\app.asar.unpacked\\node_modules\\x",
    );
  });

  it("is a no-op for the CLI, where there is no archive", () => {
    const p = "/home/dev/repo/packages/harness/dist/core/run-local-bootstrap.js";
    expect(unpackedPath(p)).toBe(p);
  });

  it("only rewrites app.asar as a whole path segment", () => {
    // A directory that merely starts with "app.asar" is not the archive.
    expect(unpackedPath("/opt/app.asarbackup/x")).toBe("/opt/app.asarbackup/x");
  });

  it("leaves an already-unpacked path alone (idempotent)", () => {
    // Callers compose freely — translating twice must not produce
    // app.asar.unpacked.unpacked.
    const once = unpackedPath("/app/resources/app.asar/node_modules/x");
    expect(unpackedPath(once)).toBe(once);
  });
});
