import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/assert-harness-version.mjs", import.meta.url),
);
const desktopPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { desktopHarnessVersion?: string };
const workspaceHarnessPackage = JSON.parse(
  readFileSync(
    new URL("../../../harness/package.json", import.meta.url),
    "utf8",
  ),
) as { version: string };
const expectedVersion =
  desktopPackage.desktopHarnessVersion ?? workspaceHarnessPackage.version;
const differentVersion = expectedVersion === "0.9.0" ? "0.8.9" : "0.9.0";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manifestWith(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sapiom-harness-version-"));
  tempDirs.push(dir);
  const manifest = join(dir, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "@sapiom/harness", version }));
  return manifest;
}

describe("desktop Harness version guard", () => {
  it("resolves the installed Harness manifest without build side effects", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`@sapiom/harness ${expectedVersion}`);
  });

  it("accepts the explicitly expected Harness version", () => {
    const result = spawnSync(
      process.execPath,
      [script, manifestWith(expectedVersion)],
      {
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`@sapiom/harness ${expectedVersion}`);
  });

  it("fails before packaging a different Harness version", () => {
    const result = spawnSync(
      process.execPath,
      [script, manifestWith(differentVersion)],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `must use @sapiom/harness ${expectedVersion}, resolved ${differentVersion}`,
    );
  });
});
