import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop development build", () => {
  it("prepares and checks Harness inline before building Electron", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.predev).toBeUndefined();
    expect(packageJson.scripts?.dev).toBe(
      "node scripts/assert-harness-version.mjs --build && pnpm run build && electron . --dev",
    );
  });
});
