import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearExtractionCache,
  extractWorkflowGraphCached,
  fingerprintWorkflowSources,
} from "./canvas-cache.js";
import type { CanvasGraph, ExtractionResult } from "./canvas-graph.js";

const GRAPH: CanvasGraph = {
  manifestName: "cached-flow",
  entry: "start",
  nodes: [{ id: "start", kind: "entry", label: "start" }],
  edges: [],
  warnings: [],
};
const OK: ExtractionResult = { ok: true, graph: GRAPH };
const FAIL: ExtractionResult = { ok: false, reason: "run npm install first" };

const tmpDirs: string[] = [];
async function tmpWorkflow(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cache-test-"));
  tmpDirs.push(dir);
  await fs.writeFile(path.join(dir, "index.ts"), "export const x = 1;\n");
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
beforeEach(() => clearExtractionCache());

/** Bump index.ts's mtime far enough that mtimeMs must change even on a
 *  coarse-granularity filesystem. */
async function touchSource(dir: string): Promise<void> {
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(path.join(dir, "index.ts"), future, future);
}

describe("extractWorkflowGraphCached", () => {
  it("runs the extraction once and serves the second call from cache — no second child process", async () => {
    const dir = await tmpWorkflow();
    const extract = vi.fn().mockResolvedValue(OK);

    const first = await extractWorkflowGraphCached(dir, extract);
    const second = await extractWorkflowGraphCached(dir, extract);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ result: OK, cached: false });
    expect(second).toEqual({ result: OK, cached: true });
  });

  it("invalidates when a source file's mtime changes", async () => {
    const dir = await tmpWorkflow();
    const extract = vi.fn().mockResolvedValue(OK);

    await extractWorkflowGraphCached(dir, extract);
    await touchSource(dir);
    const after = await extractWorkflowGraphCached(dir, extract);

    expect(extract).toHaveBeenCalledTimes(2);
    expect(after.cached).toBe(false);
  });

  it("invalidates when the source file count changes", async () => {
    const dir = await tmpWorkflow();
    const extract = vi.fn().mockResolvedValue(OK);

    await extractWorkflowGraphCached(dir, extract);
    await fs.writeFile(path.join(dir, "steps.ts"), "export const y = 2;\n");
    const after = await extractWorkflowGraphCached(dir, extract);

    expect(extract).toHaveBeenCalledTimes(2);
    expect(after.cached).toBe(false);
  });

  it("never caches a failure — 'npm install' fixes don't touch any .ts file, so a cached failure would never self-invalidate", async () => {
    const dir = await tmpWorkflow();
    const extract = vi.fn().mockResolvedValueOnce(FAIL).mockResolvedValueOnce(OK);

    const first = await extractWorkflowGraphCached(dir, extract);
    const second = await extractWorkflowGraphCached(dir, extract);

    expect(extract).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ result: FAIL, cached: false });
    expect(second).toEqual({ result: OK, cached: false });
  });

  it("caches per workflow directory — two workflows never share an entry", async () => {
    const dirA = await tmpWorkflow();
    const dirB = await tmpWorkflow();
    const extract = vi.fn().mockResolvedValue(OK);

    await extractWorkflowGraphCached(dirA, extract);
    const b = await extractWorkflowGraphCached(dirB, extract);

    expect(extract).toHaveBeenCalledTimes(2);
    expect(b.cached).toBe(false);
  });
});

describe("fingerprintWorkflowSources", () => {
  it("is stable for an unchanged tree and skips node_modules", async () => {
    const dir = await tmpWorkflow();
    await fs.mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "dep", "index.ts"), "ignored");

    const first = await fingerprintWorkflowSources(dir);
    const second = await fingerprintWorkflowSources(dir);
    expect(second).toBe(first);
    expect(first.startsWith("1:")).toBe(true); // only the workflow's own index.ts counted
  });

  it("changes when a source is edited", async () => {
    const dir = await tmpWorkflow();
    const before = await fingerprintWorkflowSources(dir);
    await touchSource(dir);
    expect(await fingerprintWorkflowSources(dir)).not.toBe(before);
  });
});
