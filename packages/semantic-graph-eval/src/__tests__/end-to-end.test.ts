import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli } from "../cli.js";
import { MockSemanticGraphProvider } from "../providers/mock.js";
import { FIXTURE_ROOT, corpus } from "./test-helpers.js";

describe("evaluation CLI end to end", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("runs all 72 mock identities with zero network calls and byte-stable output", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-graph-cli-"));
    temporaryRoots.push(root);
    const firstPath = resolve(root, "first.json");
    const secondPath = resolve(root, "second.json");
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("mock mode must never access the network");
    };
    try {
      const lines: string[] = [];
      const first = await runCli(
        [
          "--",
          "--provider",
          "mock",
          "--fixtures",
          FIXTURE_ROOT,
          "--output",
          firstPath,
        ],
        { stdout: (line) => lines.push(line) },
      );
      const second = await runCli(
        [
          "--provider",
          "mock",
          "--fixtures",
          FIXTURE_ROOT,
          "--output",
          secondPath,
        ],
        { stdout: () => undefined },
      );
      expect(first.invocationCount).toBe(72);
      expect(second.invocationCount).toBe(72);
      expect(networkCalls).toBe(0);
      expect(await readFile(firstPath, "utf8")).toBe(
        await readFile(secondPath, "utf8"),
      );
      expect(lines[0]).toContain("runs=72");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails non-zero semantics when the committed mock baseline drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-graph-drift-"));
    temporaryRoots.push(root);
    await cp(FIXTURE_ROOT, root, { recursive: true });
    await writeFile(
      resolve(root, "mock-baseline.json"),
      `${JSON.stringify(
        {
          protocol: "semantic-graph-eval.mock-baseline/1",
          aggregateFingerprint:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      runCli(["--provider", "mock", "--fixtures", root], {
        stdout: () => undefined,
      }),
    ).rejects.toThrow("Deterministic mock baseline drift");
  });

  it("refuses unguarded Luna runs and enforces the frozen holdout configuration", async () => {
    await expect(
      runCli(
        [
          "--provider",
          "luna",
          "--configuration",
          "bounded-source.v2",
          "--set",
          "holdout",
          "--fixtures",
          FIXTURE_ROOT,
        ],
        { environment: {}, stdout: () => undefined },
      ),
    ).rejects.toThrow("RUN_REAL_SEMANTIC_GRAPH_EVAL=1");
    await expect(
      runCli(
        [
          "--provider",
          "luna",
          "--configuration",
          "facts-only.v1",
          "--set",
          "holdout",
          "--fixtures",
          FIXTURE_ROOT,
        ],
        {
          environment: {
            RUN_REAL_SEMANTIC_GRAPH_EVAL: "1",
            SAPIOM_API_KEY: "test-only-key",
          },
          stdout: () => undefined,
        },
      ),
    ).rejects.toThrow("Holdout is frozen to bounded-source.v2");
  });

  it("runs the frozen holdout selection exactly once per fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-graph-holdout-"));
    temporaryRoots.push(root);
    const fixtures = await corpus();
    const provider = new MockSemanticGraphProvider(fixtures);
    const result = await runCli(
      [
        "--provider",
        "luna",
        "--configuration",
        "bounded-source.v2",
        "--set",
        "holdout",
        "--fixtures",
        FIXTURE_ROOT,
        "--output",
        resolve(root, "holdout.json"),
      ],
      {
        environment: {
          RUN_REAL_SEMANTIC_GRAPH_EVAL: "1",
          SAPIOM_API_KEY: "test-only-key",
        },
        provider,
        stdout: () => undefined,
      },
    );
    expect(result.report.provider).toBe("sapiom-luna");
    expect(result.report.fixtureSet).toBe("holdout");
    expect(result.report.configurationIds).toEqual(["bounded-source.v2"]);
    const holdoutCount = fixtures.filter(
      (fixture) => fixture.input.role === "holdout",
    ).length;
    expect(result.report.metrics.runs).toBe(holdoutCount);
    expect(provider.totalInvocationCount).toBe(holdoutCount);
  });
});
