import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BackgroundTask } from "../shared/types.js";
import type { CachedExtraction } from "./canvas-cache.js";
import type { CanvasGraph } from "./canvas-graph.js";
import { readEnrichmentCacheFile, writeEnrichmentCacheFile } from "./canvas-enrichment.js";
import { enrichmentCacheFileFor, type RenderableWorkflow } from "./canvas-render.js";
import { TaskAlreadyRunningError, TaskNotSupportedError, type RunTaskRequest } from "./task-manager.js";
import {
  CanvasEnrichmentCoordinator,
  buildEnrichmentPrompt,
  enrichmentModel,
  extractEnrichmentJson,
  type EnrichmentSession,
  type EnrichmentTaskRunner,
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

describe("buildEnrichmentPrompt", () => {
  it("carries the graph inline, points at the workflow dir, and states the JSON-only / no-file-writes contract", () => {
    const prompt = buildEnrichmentPrompt(GRAPH, "/proj/order-triage");
    expect(prompt).toContain('"manifestName": "order-triage"');
    expect(prompt).toContain("run() bodies in /proj/order-triage");
    expect(prompt).toMatch(/RETURN ONLY a JSON object/);
    expect(prompt).toMatch(/DO NOT write or modify any files/);
    // The hard caps ride in the prompt so a well-behaved run needs no retry.
    expect(prompt).toContain("max 160 chars");
    expect(prompt).toContain("max 48 chars");
  });
});

describe("enrichmentModel", () => {
  it("defaults to sonnet and honors the env override", () => {
    expect(enrichmentModel({} as NodeJS.ProcessEnv)).toBe("sonnet");
    expect(enrichmentModel({ SAPIOM_HARNESS_VISUALIZE_MODEL: "haiku" } as unknown as NodeJS.ProcessEnv)).toBe("haiku");
  });
});

describe("extractEnrichmentJson", () => {
  it("parses a raw JSON object", () => {
    expect(extractEnrichmentJson('{"summary":"hi"}')).toEqual({ summary: "hi" });
  });
  it("parses a fenced block, with or without the json tag", () => {
    expect(extractEnrichmentJson('```json\n{"summary":"hi"}\n```')).toEqual({ summary: "hi" });
    expect(extractEnrichmentJson('```\n{"summary":"hi"}\n```')).toEqual({ summary: "hi" });
  });
  it("recovers the outermost object from surrounding prose", () => {
    expect(extractEnrichmentJson('Here you go:\n{"summary":"hi"}\nHope that helps!')).toEqual({ summary: "hi" });
  });
  it("returns null for text with no parsable object", () => {
    expect(extractEnrichmentJson("I could not analyze the workflow.")).toBeNull();
    expect(extractEnrichmentJson("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

interface FakeRunner extends EnrichmentTaskRunner {
  requests: RunTaskRequest[];
  emit(task: BackgroundTask): void;
  lastTask(): BackgroundTask;
}

function makeRunner(): FakeRunner {
  const listeners = new Set<(task: BackgroundTask) => void>();
  const requests: RunTaskRequest[] = [];
  const running = new Map<string, BackgroundTask>(); // keyed by task id
  let n = 0;
  let last: BackgroundTask | undefined;
  return {
    requests,
    async run(req) {
      requests.push(req);
      last = {
        id: `task-${++n}`,
        macroId: req.macroId,
        label: req.label,
        harnessSessionId: req.harnessSessionId,
        cwd: req.cwd,
        workflowPath: req.workflowPath ?? null,
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        exitCode: null,
        statusLines: [],
        resultText: null,
        errorTail: null,
      };
      running.set(last.id, last);
      return last;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRunning(macroId: string, workflowPath: string): boolean {
      for (const task of running.values()) {
        if (task.status === "running" && task.macroId === macroId && task.workflowPath === workflowPath) {
          return true;
        }
      }
      return false;
    },
    emit(task) {
      // Mirror real TaskManager: update status in running map when emitting
      const existing = running.get(task.id);
      if (existing) {
        existing.status = task.status;
        if (task.status !== "running") running.delete(task.id);
      }
      for (const listener of [...listeners]) listener(task);
    },
    lastTask() {
      if (!last) throw new Error("no task spawned");
      return last;
    },
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-enrich-test-"));
  tmpDirs.push(dir);
  return dir;
}

const WORKFLOW: RenderableWorkflow = { path: "/proj/order-triage", name: "order-triage", definitionId: null };

function makeSession(cwd: string): EnrichmentSession {
  return { id: "sess-1", cwd, harness: "claude-code", boundWorkflowPath: WORKFLOW.path };
}

function extraction(fingerprint: string): (dir: string) => Promise<CachedExtraction> {
  return async () => ({ result: { ok: true, graph: GRAPH }, cached: true, fingerprint });
}

function makeCoordinator(runner: FakeRunner, cwd: string, overrides: Record<string, unknown> = {}) {
  const rerender = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const coordinator = new CanvasEnrichmentCoordinator({
    tasks: runner,
    rerender,
    extractCached: extraction("fp-1"),
    env: {} as NodeJS.ProcessEnv,
    now: () => "2026-01-02T00:00:00.000Z",
    onError,
    ...overrides,
  });
  return { coordinator, rerender, onError, session: makeSession(cwd) };
}

const VALID_RESULT = '```json\n{"summary":"routes orders","edgeLabels":{"intake->route":"normalized"}}\n```';

describe("CanvasEnrichmentCoordinator.ensureFresh", () => {
  it("spawns one enrichment task with the visualize macro identity, sonnet, the turn cap and the workflowPath", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, session } = makeCoordinator(runner, cwd);

    await coordinator.ensureFresh(session, [WORKFLOW]);

    expect(runner.requests).toHaveLength(1);
    const req = runner.requests[0];
    expect(req.macroId).toBe("visualize");
    expect(req.harnessSessionId).toBe("sess-1");
    expect(req.workflowPath).toBe(WORKFLOW.path);
    expect(req.model).toBe("sonnet");
    expect(req.maxTurns).toBe(8);
    expect(req.prompt).toContain('"manifestName": "order-triage"');
  });

  it("persists the validated enrichment to the cache file and re-renders on completion", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, rerender, session } = makeCoordinator(runner, cwd);

    await coordinator.ensureFresh(session, [WORKFLOW]);
    runner.emit({ ...runner.lastTask(), status: "completed", resultText: VALID_RESULT });
    await vi.waitFor(async () => {
      expect(rerender).toHaveBeenCalledWith(cwd, WORKFLOW);
    });

    const entry = await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path));
    expect(entry).toEqual({
      graph: GRAPH,
      enrichment: { summary: "routes orders", edgeLabels: { "intake->route": "normalized" } },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("skips the spawn when the cached enrichment's fingerprint matches the current sources", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, session } = makeCoordinator(runner, cwd);
    await writeEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path), {
      graph: GRAPH,
      enrichment: { summary: "already fresh" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });

    await coordinator.ensureFresh(session, [WORKFLOW]);
    expect(runner.requests).toHaveLength(0);
  });

  it("re-spawns when the cached fingerprint is stale", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, session } = makeCoordinator(runner, cwd, { extractCached: extraction("fp-2") });
    await writeEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path), {
      graph: GRAPH,
      enrichment: { summary: "from older sources" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });

    await coordinator.ensureFresh(session, [WORKFLOW]);
    expect(runner.requests).toHaveLength(1);
  });

  it("discards invalid output whole — no cache write, no re-render, base render stands", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, rerender, onError, session } = makeCoordinator(runner, cwd);

    await coordinator.ensureFresh(session, [WORKFLOW]);
    runner.emit({
      ...runner.lastTask(),
      status: "completed",
      // Valid JSON, structurally invalid enrichment — beyond what the
      // bounds/nulls normalization repairs.
      resultText: JSON.stringify({ nodeDetails: "not an object" }),
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("invalid output"));
    });

    expect(await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path))).toBeNull();
    expect(rerender).not.toHaveBeenCalled();
  });

  it("persists nothing when the task fails — the pane's failure state owns that path", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, rerender, session } = makeCoordinator(runner, cwd);

    await coordinator.ensureFresh(session, [WORKFLOW]);
    runner.emit({ ...runner.lastTask(), status: "failed", errorTail: "exploded" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path))).toBeNull();
    expect(rerender).not.toHaveBeenCalled();
  });

  it("is silent for unbound sessions, failed extractions, and expected spawn refusals", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, onError } = makeCoordinator(runner, cwd);

    await coordinator.ensureFresh({ ...makeSession(cwd), boundWorkflowPath: null }, [WORKFLOW]);
    expect(runner.requests).toHaveLength(0);

    const failing = makeCoordinator(runner, cwd, {
      extractCached: async (): Promise<CachedExtraction> => ({
        result: { ok: false, reason: "run npm install first" },
        cached: false,
        fingerprint: "fp-1",
      }),
    });
    await failing.coordinator.ensureFresh(failing.session, [WORKFLOW]);
    expect(runner.requests).toHaveLength(0);

    for (const refusal of [new TaskAlreadyRunningError("Visualize"), new TaskNotSupportedError("codex", "Visualize")]) {
      const refusing = makeCoordinator(
        { ...runner, run: vi.fn().mockRejectedValue(refusal) } as unknown as FakeRunner,
        cwd,
      );
      await expect(refusing.coordinator.ensureFresh(refusing.session, [WORKFLOW])).resolves.toBeUndefined();
      expect(refusing.onError).not.toHaveBeenCalled();
    }
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("CanvasEnrichmentCoordinator.forceRefresh", () => {
  it("drops the enrichment cache, re-renders the base immediately, then re-spawns the task", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, rerender, session } = makeCoordinator(runner, cwd);
    await writeEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path), {
      graph: GRAPH,
      enrichment: { summary: "even a FRESH cache is dropped — the user asked for a redo" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });

    await coordinator.forceRefresh(session, [WORKFLOW]);

    expect(await readEnrichmentCacheFile(enrichmentCacheFileFor(cwd, WORKFLOW.path))).toBeNull();
    expect(rerender).toHaveBeenCalledWith(cwd, WORKFLOW); // base render, before the task lands
    expect(runner.requests).toHaveLength(1);
  });

  it("propagates TaskAlreadyRunningError — the macros router turns it into a 409", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const refusing = { ...runner, run: vi.fn().mockRejectedValue(new TaskAlreadyRunningError("Visualize")) };
    const { coordinator, session } = makeCoordinator(refusing as unknown as FakeRunner, cwd);

    await expect(coordinator.forceRefresh(session, [WORKFLOW])).rejects.toBeInstanceOf(TaskAlreadyRunningError);
  });

  it("double-click guard: second forceRefresh while a task is running rejects BEFORE touching the cache or re-rendering", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, rerender, session } = makeCoordinator(runner, cwd);

    // Write an enrichment cache file that should survive the second call.
    const cacheFile = enrichmentCacheFileFor(cwd, WORKFLOW.path);
    await writeEnrichmentCacheFile(cacheFile, {
      graph: GRAPH,
      enrichment: { summary: "cached annotations" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });

    // First forceRefresh: starts the task (cache is cleared, rerender called once).
    await coordinator.forceRefresh(session, [WORKFLOW]);
    expect(runner.requests).toHaveLength(1);
    // The running task is still in flight (never emitted a terminal status).

    // Write the cache back, simulating the state mid-run where the cache has
    // been partially repopulated (or was never cleared yet by the second call).
    await writeEnrichmentCacheFile(cacheFile, {
      graph: GRAPH,
      enrichment: { summary: "mid-run annotations" },
      sourceFingerprint: "fp-1",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });

    // Second forceRefresh while the task is still running: must reject with
    // TaskAlreadyRunningError and be a true no-op — cache untouched, no
    // additional rerender, no additional spawn.
    const rerenderCallsBefore = rerender.mock.calls.length;
    await expect(coordinator.forceRefresh(session, [WORKFLOW])).rejects.toBeInstanceOf(TaskAlreadyRunningError);

    // Cache survives the second call (the running enrichment still needs it).
    expect(await readEnrichmentCacheFile(cacheFile)).not.toBeNull();
    // No additional rerender was triggered.
    expect(rerender.mock.calls.length).toBe(rerenderCallsBefore);
    // No additional task was spawned.
    expect(runner.requests).toHaveLength(1);
  });

  it("is a no-op for an unbound session — matching the deterministic render's unbound contract", async () => {
    const runner = makeRunner();
    const cwd = await tmpCwd();
    const { coordinator, rerender } = makeCoordinator(runner, cwd);

    await coordinator.forceRefresh({ ...makeSession(cwd), boundWorkflowPath: null }, [WORKFLOW]);
    expect(rerender).not.toHaveBeenCalled();
    expect(runner.requests).toHaveLength(0);
  });
});
