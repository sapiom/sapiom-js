import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedVersions } from "@sapiom/agent-core";

import { SAMPLE_PROJECT_NAME, seedExampleProject } from "./example-seed.js";

// Pinned so the tests never hit npm — the real callers resolve live versions
// (or fall back offline) via @sapiom/agent-core's resolveVersions().
const VERSIONS: ResolvedVersions = { agent: "0.0.1", tools: "0.0.1", zod: "3.25.0" };

describe("seedExampleProject", () => {
  let targetRoot: string;

  beforeEach(async () => {
    targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-example-seed-"));
  });

  afterEach(async () => {
    await fs.rm(targetRoot, { recursive: true, force: true });
  });

  // installDependencies:false keeps the suite offline/fast — the pinned
  // VERSIONS don't exist on npm, and the Canvas-bundle behaviour isn't under test here.
  const seed = (force?: boolean) =>
    seedExampleProject({ targetRoot, force, versions: VERSIONS, installDependencies: false });

  it("seeds a scaffolded project into an empty root", async () => {
    const result = await seed();

    expect(result.created).toBe(true);
    expect(result.root).toBe(targetRoot);
    expect(result.projectDir).toBe(path.join(targetRoot, SAMPLE_PROJECT_NAME));

    // The workflow scanner keys on sapiom.json — this is what makes the
    // seeded project show up in the rail.
    expect(existsSync(path.join(result.projectDir, "sapiom.json"))).toBe(true);
    const indexTs = await fs.readFile(path.join(result.projectDir, "index.ts"), "utf8");
    expect(indexTs).toContain("name: 'order-triage'");
  });

  it("reuses an existing seeded copy as-is (user edits survive)", async () => {
    const first = await seed();
    const indexTsPath = path.join(first.projectDir, "index.ts");
    await fs.writeFile(indexTsPath, "// user edit\n", "utf8");

    const second = await seed();

    expect(second.created).toBe(false);
    expect(await fs.readFile(indexTsPath, "utf8")).toBe("// user edit\n");
  });

  it("force re-seeds from scratch, discarding edits (demo-prep script behavior)", async () => {
    const first = await seed();
    const indexTsPath = path.join(first.projectDir, "index.ts");
    await fs.writeFile(indexTsPath, "// user edit\n", "utf8");

    const second = await seed(true);

    expect(second.created).toBe(true);
    expect(await fs.readFile(indexTsPath, "utf8")).toContain("name: 'order-triage'");
  });
});
