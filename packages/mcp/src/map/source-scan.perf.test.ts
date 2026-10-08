/**
 * Perf floor for the source scan that runs when Agent Studio refreshes an
 * agent Canvas. A workspace can contribute up to 200 bounded source files;
 * the representative tree below fills that limit while only a minority of
 * files contain direct agent APIs. Every file still contains agent vocabulary
 * so the benchmark exercises the parser path rather than mostly measuring the
 * cheap prefilter.
 *
 * The threshold is intentionally generous for shared CI runners. Its purpose
 * is to catch an accidental loss of the cheap non-agent-file path or an
 * unexpectedly expensive parser integration, not to benchmark TypeScript.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanWorkflowSources } from "./source-scan.js";

const SOURCE_FILE_COUNT = 200;
const AGENT_FILE_INTERVAL = 10;
const SAMPLES = 5;
const P95_BUDGET_MS = 1_500;

const RECORDS = Array.from(
  { length: 80 },
  (_, index) =>
    `  { id: ${index}, label: "record-${index}", enabled: ${index % 2 === 0} },`,
).join("\n");

describe("workflow source scan perf (200-file workspace)", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-interconnections-perf-"),
    );
    await Promise.all(
      Array.from({ length: SOURCE_FILE_COUNT }, async (_, index) => {
        const directory = path.join(root, `module-${index % 10}`);
        await fs.mkdir(directory, { recursive: true });
        const invocation =
          index % AGENT_FILE_INTERVAL === 0
            ? `\nexport async function invoke(ctx: any) {\n  return ctx.sapiom.agents.launch({ definition: "child-${index}" });\n}\n`
            : "";
        await fs.writeFile(
          path.join(directory, `source-${String(index).padStart(3, "0")}.ts`),
          `export const agentVocabulary = "agents";\nexport const records = [\n${RECORDS}\n] as const;\n${invocation}`,
        );
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps repeated full-tree scans below the hot-path ceiling", async () => {
    const expectedInvocations = SOURCE_FILE_COUNT / AGENT_FILE_INTERVAL;
    const warm = await scanWorkflowSources(root, new Set());
    expect(warm.invocations).toHaveLength(expectedInvocations);

    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index++) {
      const start = performance.now();
      const result = await scanWorkflowSources(root, new Set());
      samples.push(performance.now() - start);
      expect(result.invocations).toHaveLength(expectedInvocations);
      expect(result.invocationWarnings).toEqual([]);
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const p95 =
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    console.info(
      `[perf] 200 parsed workflow sources · 20 direct-call files · hot p95 ${p95.toFixed(1)}ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
