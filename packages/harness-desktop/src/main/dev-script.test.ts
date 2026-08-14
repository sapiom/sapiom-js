import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop development build", () => {
  it("builds the Harness server and web bundle before Electron", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.predev).toBe(
      "pnpm --filter @sapiom/harness build",
    );
    expect(packageJson.scripts?.dev).toContain("electron . --dev");
  });
});
