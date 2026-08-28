import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/assert-harness-version.mjs", import.meta.url),
);
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
  it("accepts the explicitly expected Harness version", () => {
    const result = spawnSync(
      process.execPath,
      [script, manifestWith("0.8.9")],
      {
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("@sapiom/harness 0.8.9");
  });

  it("fails before packaging a different Harness version", () => {
    const result = spawnSync(
      process.execPath,
      [script, manifestWith("0.9.0")],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "must use @sapiom/harness 0.8.9, resolved 0.9.0",
    );
  });
});
