import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop development build", () => {
  it("checks the pinned Harness version before Electron", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.predev).toBe(
      "node scripts/assert-harness-version.mjs",
    );
    expect(packageJson.scripts?.dev).toContain("electron . --dev");
  });
});
