/**
 * Unit tests for the zod version a scaffolded project pins (SAP-4718).
 *
 * Fully offline: global.fetch rejects, so `resolveVersions` takes the generated
 * fallback, which is where the pnpm catalog's zod reaches new projects.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveVersions, scaffold } from "./scaffold";

const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");

/** Lowest zod the repo accepts, same floor as scripts/zod-floor.test.mjs. */
const PATCHED_ZOD = [4, 6, 6];

function atLeast(version: string, floor: number[]): boolean {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

describe("scaffolded zod version", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "scaffold-zod-"));
    jest
      .spyOn(global, "fetch" as never)
      .mockRejectedValue(new Error("offline") as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a zod at or above the floor when the registry is unreachable", async () => {
    const { zod } = await resolveVersions();
    expect(zod).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(zod, PATCHED_ZOD)).toBe(true);
  });

  it("stamps that zod into the default template's package.json", async () => {
    const { zod } = await resolveVersions();
    const targetDir = path.join(dir, "proj");
    await scaffold({ targetDir, templatesDir: TEMPLATES_DIR });

    const raw = readFileSync(path.join(targetDir, "package.json"), "utf8");
    expect(raw).not.toContain("__ZOD_VERSION__");
    expect(JSON.parse(raw).dependencies.zod).toBe(zod);
  });
});
