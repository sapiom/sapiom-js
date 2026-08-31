import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getConfiguration } from "../configurations.js";
import { executeFixtureEvaluation } from "../evaluate.js";
import { canonicalJson } from "../fingerprint.js";
import { MockSemanticGraphProvider } from "../providers/mock.js";
import { corpus, fixtureById } from "./test-helpers.js";

describe("accepted semantic snapshots", () => {
  it("matches the committed adversarial snapshot golden exactly", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "adversarial-validation");
    const evaluation = await executeFixtureEvaluation(
      fixture,
      getConfiguration("bounded-source.v1"),
      new MockSemanticGraphProvider(fixtures),
    );
    const golden = await readFile(
      resolve(
        __dirname,
        "goldens/adversarial-validation.bounded-source.snapshot.json",
      ),
      "utf8",
    );
    expect(`${JSON.stringify(evaluation.snapshot, null, 2)}\n`).toBe(golden);
  });

  it("is deterministic and remains independent from oracle correctness", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "unsupported-cycle");
    const first = await executeFixtureEvaluation(
      fixture,
      getConfiguration("context-pressure.v1"),
      new MockSemanticGraphProvider(fixtures),
    );
    const second = await executeFixtureEvaluation(
      fixture,
      getConfiguration("context-pressure.v1"),
      new MockSemanticGraphProvider(fixtures),
    );
    expect(canonicalJson(first.snapshot)).toBe(canonicalJson(second.snapshot));
    expect(first.snapshot.accepted).toHaveLength(2);
    expect(first.metrics.falsePositives).toBe(2);
    expect(first.snapshot).not.toHaveProperty("correct");
  });
});
