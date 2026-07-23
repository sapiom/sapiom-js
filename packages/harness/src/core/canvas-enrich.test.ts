import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CachedExtraction } from "./canvas-cache.js";
import type { CanvasGraph } from "./canvas-graph.js";
import { readEnrichmentCacheFile, writeEnrichmentCacheFile } from "./canvas-enrichment.js";
import { enrichmentCacheFileFor, type RenderableWorkflow } from "./canvas-render.js";
import { TaskAlreadyRunningError } from "./task-manager.js";
import type { EnrichCanvasClient, EnrichCanvasRunResult } from "./enrich-canvas-client.js";
import {
  CanvasEnrichmentCoordinator,
  readWorkflowStepBodies,
  type EnrichmentSession,
} from "./canvas-enrich.js";

const GRAPH: CanvasGraph = {
  manifestName: "order-triage",
  entry: "intake",
  warnings: [],
  nodes: [
    { id: "intake", kind: "entry", label: "intake" },
    { id: "route", kind: "step", label: "route" },
  ],
  edges: [{ from: "intake", to: "route", kind: "sequential" }],
};

/** The `enrich-canvas` workflow returns the parsed enrichment object directly
 *  as its run output — the harness only has to validate it. */
const VALID_OUTPUT = { summary: "routes orders", edgeLabels: { "intake->route": "normalized" } };

// ---------------------------------------------------------------------------
// tmp dir helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-enrich-test-"));
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// readWorkflowStepBodies
// ---------------------------------------------------------------------------

describe("readWorkflowStepBodies", () => {
  it("reads the workflow's source files keyed by workflow-relative path", async () => {
    const dir = await tmpCwd();
    await fs.writeFile(path.join(dir, "index.ts"), "export const agent = defineAgent({});\n");
    const bodies = await readWorkflowStepBodies(dir);
    expect(bodies["index.ts"]).toContain("export const agent");
  });

  it("returns an empty map for a directory with no readable sources", async () => {
    const dir = await tmpCwd();
    expect(await readWorkflowStepBodies(dir)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

const WORKFLOW: RenderableWorkflow = { path: "/proj/order-triage", name: "order-triage", definitionId: null };

function makeSession(cwd: string): EnrichmentSession {
  return { cwd, boundWorkflowPath: WORKFLOW.path };
}

function extraction(fingerprint: string): (dir: string) => Promise<CachedExtraction> {
  return async () => ({ result: { ok: true, graph: GRAPH }, cached: true, fingerprint });
}

/** A fake client whose single `run` is a vi.fn — tests set its resolution
 *  (ok/output, a failure, or a never-settling promise for the in-flight guard). */
interface FakeClient extends EnrichCanvasClient {
  run: ReturnType<typeof vi.fn>;
}
function makeClient(result: EnrichCanvasRunResult = { ok: true, executionId: "exec_1", output: VALID_OUTPUT }): FakeClient {
  return { run: vi.fn().mockResolvedValue(result) };
}

function makeCoordinator(cwd: string, overrides: Record<string, unknown> = {}) {
  const client = (overrides.client as FakeClient) ?? makeClient();
  const rerender = vi.fn().mockResolvedValue(undefined);
  const readStepBodies = vi.fn().mockResolvedValue({ "index.ts": "export const agent = defineAgent({});" });
  const onError = vi.fn();
  const coordinator = new CanvasEnrichmentCoordinator({
    client,
    definitionId: "def_enrich",
    rerender,
    readStepBodies,
    extractCached: extraction("fp-1"),
    now: () => "2026-01-02T00:00:00.000Z",
    onError,
    ...overrides,
  });
  return { coordinator, client, rerender, readStepBodies, onError, session: makeSession(cwd) };
}

describe("CanvasEnrichmentCoordinator.forceRefresh — no auto-fire; the visualize macro is the ONLY trigger", () => {
  it("runs enrich-canvas on our account with graph + stepBodies, persists the validated output, and re-renders", async () => {
    const cwd = await tmpCwd();
    const { coordinator, client, rerender, session } = makeCoordinator(cwd);

    await coordinator.forceRefresh(session, [WORKFLOW]);

    await vi.waitFor(async () => {
      const entry = await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path));
      expect(entry).toEqual({
        graph: GRAPH,
        enrichment: VALID_OUTPUT,
        sourceFingerprint: "fp-1",
        enrichedAt: "2026-01-02T00:00:00.000Z",
      });
    });
    expect(client.run).toHaveBeenCalledWith("def_enrich", {
      graph: GRAPH,
      stepBodies: { "index.ts": expect.any(String) },
    });
    expect(rerender).toHaveBeenCalledWith(cwd, WORKFLOW);
  });

  it("drops even a FRESH cache and re-renders the Tier-1 base BEFORE the enrichment lands", async () => {
    const cwd = await tmpCwd();
    // A never-settling run: the base re-render must be observable before it.
    const client = { run: vi.fn().mockReturnValue(new Promise<never>(() => {})) } as unknown as FakeClient;
    const { coordinator, rerender, session } = makeCoordinator(cwd, { client });
    const cacheFile = enrichmentCacheFileFor(cwd, WORKFLOW.path);
    await writeEnrichmentCacheFile(cacheFile, {
      graph: GRAPH,
      enrichment: { summary: "even a FRESH cache is dropped — the user asked for a redo" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });

    await coordinator.forceRefresh(session, [WORKFLOW]);

    expect(await readEnrichmentCacheFile(cacheFile)).toBeNull();
    expect(rerender).toHaveBeenCalledTimes(1); // the base render, before any annotations
    expect(rerender).toHaveBeenCalledWith(cwd, WORKFLOW);
    expect(client.run).toHaveBeenCalledTimes(1);
  });

  it("discards invalid output whole — logs, no cache write, base render stands", async () => {
    const cwd = await tmpCwd();
    // Valid JSON, structurally invalid enrichment (beyond bounds/nulls repair).
    const client = makeClient({ ok: true, executionId: "exec_1", output: { nodeDetails: "not an object" } });
    const { coordinator, onError, session } = makeCoordinator(cwd, { client });

    await coordinator.forceRefresh(session, [WORKFLOW]);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("invalid output"));
    });
    expect(await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path))).toBeNull();
  });

  it("degrades silently when the workflow run does not complete — logged, base stands, no cache", async () => {
    const cwd = await tmpCwd();
    const client = makeClient({ ok: false, status: 504, error: "timed out waiting for the run to finish" });
    const { coordinator, onError, session } = makeCoordinator(cwd, { client });

    await coordinator.forceRefresh(session, [WORKFLOW]);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("did not complete"));
    });
    expect(await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path))).toBeNull();
  });

  it("skips the annotation pass entirely when no definition id is configured — Tier-1 renders, workflow never runs", async () => {
    const cwd = await tmpCwd();
    const { coordinator, client, rerender, session } = makeCoordinator(cwd, { definitionId: "" });

    await coordinator.forceRefresh(session, [WORKFLOW]);

    expect(client.run).not.toHaveBeenCalled();
    expect(rerender).toHaveBeenCalledWith(cwd, WORKFLOW); // base render still happens
    expect(await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path))).toBeNull();
  });

  it("re-renders the base but does not run the workflow when extraction fails", async () => {
    const cwd = await tmpCwd();
    const { coordinator, client, rerender, session } = makeCoordinator(cwd, {
      extractCached: async (): Promise<CachedExtraction> => ({
        result: { ok: false, reason: "run npm install first" },
        cached: false,
        fingerprint: "fp-1",
      }),
    });

    await coordinator.forceRefresh(session, [WORKFLOW]);

    expect(rerender).toHaveBeenCalledWith(cwd, WORKFLOW);
    expect(client.run).not.toHaveBeenCalled();
  });

  it("double-click guard: a second forceRefresh while one is in flight rejects with TaskAlreadyRunningError before touching the cache or re-rendering", async () => {
    const cwd = await tmpCwd();
    // First run never settles, so the workflow stays in flight.
    const client = { run: vi.fn().mockReturnValue(new Promise<never>(() => {})) } as unknown as FakeClient;
    const { coordinator, rerender, session } = makeCoordinator(cwd, { client });
    const cacheFile = enrichmentCacheFileFor(cwd, WORKFLOW.path);

    await coordinator.forceRefresh(session, [WORKFLOW]);
    expect(client.run).toHaveBeenCalledTimes(1);

    // Simulate the cache present mid-run; the second call must leave it intact.
    await writeEnrichmentCacheFile(cacheFile, {
      graph: GRAPH,
      enrichment: { summary: "mid-run annotations" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });
    const rerenderCallsBefore = rerender.mock.calls.length;

    await expect(coordinator.forceRefresh(session, [WORKFLOW])).rejects.toBeInstanceOf(TaskAlreadyRunningError);

    expect(await readEnrichmentCacheFile(cacheFile)).not.toBeNull();
    expect(rerender.mock.calls.length).toBe(rerenderCallsBefore);
    expect(client.run).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an unbound session — no render, no workflow", async () => {
    const cwd = await tmpCwd();
    const { coordinator, client, rerender } = makeCoordinator(cwd);

    await coordinator.forceRefresh({ cwd, boundWorkflowPath: null }, [WORKFLOW]);

    expect(rerender).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
  });
});
