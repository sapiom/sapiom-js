import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXPERIMENT_CONFIGURATION_IDS } from "../configurations.js";
import { generateFixtures } from "../generate-fixtures.js";
import { canonicalJson } from "../fingerprint.js";
import { FIXTURE_ROOT, corpus } from "./test-helpers.js";

const REQUIRED_CASES = [
  "opaque-store-reload",
  "external-handoff",
  "dynamic-derived-routing",
  "transformed-information",
  "shared-capability-only",
  "similar-schema-only",
  "sibling-invocations-no-flow",
  "unrelated-agents",
  "unsupported-cycle",
  "invented-endpoint",
  "complete-abstention",
  "truncated-context",
  "malformed-output",
  "fabricated-support-reference",
  "prompt-injection-excerpt",
  "adversarial-validation",
  "provider-failure",
  "mixed-project-stress",
] as const;

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, item]) => [key, ...keysDeep(item)],
    );
  }
  return [];
}

describe("synthetic corpus", () => {
  it("covers every required positive, negative, resilience, and mixed case", async () => {
    const fixtures = await corpus();
    expect(fixtures.map((fixture) => fixture.input.fixtureId).sort()).toEqual(
      [...REQUIRED_CASES].sort(),
    );
    const categorySet = new Set(
      fixtures.flatMap((fixture) => fixture.input.categories),
    );
    for (const category of [
      "positive",
      "negative",
      "abstention",
      "truncated-context",
      "malformed-output",
      "fabricated-support-reference",
      "prompt-injection",
      "provider-failure",
      "mixed-project",
    ]) {
      expect(categorySet).toContain(category);
    }
    expect(
      fixtures.some((fixture) => fixture.input.role === "calibration"),
    ).toBe(true);
    expect(fixtures.some((fixture) => fixture.input.role === "holdout")).toBe(
      true,
    );
  });

  it("manifests every case directory and every configuration response", async () => {
    const fixtures = await corpus();
    const directories = (
      await readdir(resolve(FIXTURE_ROOT, "cases"), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual(
      fixtures.map((fixture) => fixture.input.fixtureId).sort(),
    );
    for (const fixture of fixtures) {
      expect(Object.keys(fixture.providerFixture.responses).sort()).toEqual(
        [...EXPERIMENT_CONFIGURATION_IDS].sort(),
      );
    }
  });

  it("contains synthetic data only and never embeds an oracle in model input", async () => {
    const fixtures = await corpus();
    for (const fixture of fixtures) {
      const input = canonicalJson(fixture.input);
      expect(input).not.toMatch(
        /SAPIOM_API_KEY|sk-[A-Za-z0-9_-]{16,}|\/Users\/|\/home\//,
      );
      expect(keysDeep(fixture.input)).not.toEqual(
        expect.arrayContaining([
          "expectedFeeds",
          "forbiddenFeeds",
          "expectedOutcome",
        ]),
      );
      expect(fixture.input.project.projectId).toBe(
        `project:${fixture.input.fixtureId}`,
      );
    }
  });

  it("regenerates the locked v1 corpus byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-graph-generated-"));
    try {
      await generateFixtures(root);
      const generatedManifest = await readFile(
        resolve(root, "corpus-manifest.json"),
        "utf8",
      );
      const committedManifest = await readFile(
        resolve(FIXTURE_ROOT, "corpus-manifest.json"),
        "utf8",
      );
      expect(generatedManifest).toBe(committedManifest);
      for (const fixtureId of REQUIRED_CASES) {
        for (const file of [
          "input.json",
          "oracle.json",
          "provider-response.json",
        ]) {
          const generated = await readFile(
            resolve(root, "cases", fixtureId, file),
            "utf8",
          );
          const committed = await readFile(
            resolve(FIXTURE_ROOT, "cases", fixtureId, file),
            "utf8",
          );
          expect(generated).toBe(committed);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
