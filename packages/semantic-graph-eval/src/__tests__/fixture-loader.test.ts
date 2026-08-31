import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fixtureInputSchema } from "../contracts.js";
import { getConfiguration } from "../configurations.js";
import { loadCorpus, normalizeFixtureInput } from "../fixture-loader.js";
import { canonicalJson } from "../fingerprint.js";
import { buildSemanticGraphPacket } from "../packet.js";
import { FIXTURE_ROOT, corpus, fixtureById } from "./test-helpers.js";

describe("immutable fixture loading", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("loads every manifest entry with exact public Protocol-1 identities", async () => {
    const fixtures = await corpus();
    expect(fixtures).toHaveLength(18);
    for (const fixture of fixtures) {
      expect(fixture.input.phaseAEvidence.scope).toEqual(
        fixture.input.inventory.version,
      );
      expect(fixture.input.agentCards.map((card) => card.agentId)).toEqual(
        fixture.input.inventory.agents.map((agent) => agent.agentKey).sort(),
      );
      expect(fixture.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("fails closed when even non-semantic fixture bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-graph-fixtures-"));
    temporaryRoots.push(root);
    await cp(FIXTURE_ROOT, root, { recursive: true });
    const path = resolve(root, "cases/complete-abstention/input.json");
    await writeFile(path, `${await readFile(path, "utf8")} `, "utf8");
    await expect(loadCorpus(root)).rejects.toThrow(
      "Immutable fixture hash mismatch: complete-abstention",
    );
  });

  it("refuses an unmanifested fixture directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-graph-unmanifested-"));
    temporaryRoots.push(root);
    await cp(FIXTURE_ROOT, root, { recursive: true });
    await mkdir(resolve(root, "cases/not-in-manifest"));
    await expect(loadCorpus(root)).rejects.toThrow(
      "unmanifested or missing fixture directory",
    );
  });

  it("rejects answer-key leakage through strict input parsing", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "opaque-store-reload");
    expect(() =>
      fixtureInputSchema.parse({
        ...fixture.input,
        oracle: fixture.oracle,
      }),
    ).toThrow();
    expect(canonicalJson(fixture.input)).not.toContain("expectedFeeds");
  });

  it("rejects cross-snapshot evidence and duplicate visible references", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "opaque-store-reload");
    const mismatched = structuredClone(fixture.input);
    mismatched.phaseAEvidence.scope = {
      kind: "bundle",
      bundleDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    // The public Protocol-1 schema may reject the now-noncanonical result ID
    // before our explicit inventory/evidence scope guard; either way it cannot run.
    expect(() => normalizeFixtureInput(mismatched)).toThrow();

    const duplicate = structuredClone(fixture.input);
    duplicate.sharedContext.push({
      ...duplicate.agentCards[0].facts[0],
      kind: "shared-context",
    });
    expect(() => normalizeFixtureInput(duplicate)).toThrow(
      "Duplicate model-visible reference",
    );
  });

  it("keeps the oracle outside the packet builder's input and output", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "opaque-store-reload");
    const packet = buildSemanticGraphPacket(
      fixture.input,
      getConfiguration("bounded-source.v1"),
    );
    const serialized = canonicalJson(packet);
    expect(serialized).not.toContain("expectedFeeds");
    expect(serialized).not.toContain("forbiddenFeeds");
    expect(serialized).not.toContain("expectedOutcome");
  });
});
