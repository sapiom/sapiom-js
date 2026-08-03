import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageMetadata {
  name: string;
  description: string;
  keywords?: string[];
  bin?: Record<string, string>;
}

const harnessPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageMetadata;
const desktopPackage = JSON.parse(
  readFileSync(
    new URL("../../../harness-desktop/package.json", import.meta.url),
    "utf8",
  ),
) as PackageMetadata;
const desktopBuilder = readFileSync(
  new URL("../../../harness-desktop/electron-builder.yml", import.meta.url),
  "utf8",
);

describe("Agent Studio public metadata", () => {
  it("uses Agent Studio and Agent terminology in package metadata", () => {
    expect(harnessPackage.description).toMatch(/^Agent Studio —/);
    expect(harnessPackage.description).toContain("agents tracked");
    expect(harnessPackage.keywords).toContain("agents");
    expect(harnessPackage.keywords).not.toContain("workflows");
    expect(desktopPackage.description).toMatch(/^Agent Studio desktop app/);
    expect(desktopBuilder).toContain("synopsis: Agent Studio —");
  });

  it("preserves package, binary, desktop, artifact, and updater identities", () => {
    expect(harnessPackage.name).toBe("@sapiom/harness");
    expect(harnessPackage.bin).toEqual({
      "sapiom-harness": "./dist/cli/bin.js",
    });
    expect(desktopPackage.name).toBe("@sapiom/harness-desktop");
    expect(desktopBuilder).toContain("appId: ai.sapiom.harness");
    expect(desktopBuilder).toContain("productName: Sapiom");
    expect(desktopBuilder).toContain(
      "artifactName: sapiom-${version}-${arch}.${ext}",
    );
    expect(desktopBuilder).toContain("executableName: sapiom");
  });
});
