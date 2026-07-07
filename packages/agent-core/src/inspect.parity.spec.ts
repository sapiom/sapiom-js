/**
 * REST parity + graceful-decode contract for the inspection surface.
 *
 * The fixtures mirror the shape the engine execution endpoints actually emit —
 * the authoritative `ExecutionDetailDto` wire (structured `error.trace`, dispatch
 * edges keyed by `target_id`, cost-agnostic detail read). They are derived from
 * that DTO contract rather than hand-drawn to match the SDK types, so the
 * assertions below verify the SDK decodes the REAL wire correctly — not that
 * `decode` is idempotent on a shape written to please it. (A live prod capture
 * can't be committed to a public repo; the code-authoritative DTO is the honest
 * stand-in — engine `apps/workflows-engine/.../http/dto/execution.dto.ts`.)
 *
 * Because `decode` never throws and back-fills missing fields, drift between the
 * SDK shape and the wire must surface as an assertion on real-wire values, which
 * is what these tests do.
 */
import type { GatewayClient } from "./client.js";
import { decodeExecutionProjection } from "./decode.js";
import { inspect, listExecutions } from "./inspect.js";
import wireFixture from "./__tests__/execution-detail.wire.fixture.json";
import withCostFixture from "./__tests__/execution-projection.with-cost.fixture.json";
import preseamFixture from "./__tests__/execution-projection.preseam.fixture.json";

/** A GatewayClient that returns `body` for any GET, recording the path. */
function clientReturning(body: unknown): { client: GatewayClient; paths: string[] } {
  const paths: string[] = [];
  const client = {
    get: async (path: string) => {
      paths.push(path);
      return body;
    },
  } as unknown as GatewayClient;
  return { client, paths };
}

describe("inspect() decodes the real execution-detail wire", () => {
  it("hits the by-id endpoint and carries identity + status through", async () => {
    const { client, paths } = clientReturning(wireFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    expect(paths).toEqual(["/executions/exec_0001"]);
    expect(result.id).toBe("exec_0001");
    expect(result.name).toBe("daily-digest");
    expect(result.status).toBe("failed");
    expect(result.currentStep).toBe("render");
  });

  it("carries the full tree + trace identity", async () => {
    const { client } = clientReturning(wireFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    expect(result.traceRoot).toBe("exec_0001");
    expect(result.rootExecutionId).toBe("exec_0001");
    expect(result.traceId).toBe("trace_0001");
    expect(result.traceParent).toBeNull();
    expect(result.parentExecutionId).toBeNull();
    expect(result.steps[1]?.spanId).toBe("span_0002");
  });

  it("reports cost as null when the detail read is cost-agnostic (no fabricated $0)", async () => {
    const { client } = clientReturning(wireFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    // The by-id endpoint carries no cost — decode must NOT invent a zeroed node.
    expect(result.cost).toBeNull();
    expect(result.steps[0]?.cost).toBeNull();
    expect(result.steps[1]?.cost).toBeNull();
  });

  it("preserves the structured, source-mapped error trace (not a dropped null)", async () => {
    const { client } = clientReturning(wireFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    const err = result.steps[1]?.error;
    expect(err?.message).toBe("template not found");
    expect(err?.traceUnavailableReason).toBeNull();
    expect(err?.trace?.sourceMapped).toBe(true);
    expect(err?.trace?.frames).toEqual([
      { function: "render", file: "src/steps/render.ts", line: 12, column: 11 },
      { function: "run", file: "src/engine/runner.ts", line: 88, column: 5 },
    ]);
    expect(err?.trace?.raw).toContain("template not found");
    // A successful step has no error.
    expect(result.steps[0]?.error).toBeNull();
  });

  it("maps the dispatch edge from the wire's target_id (no phantom dispatchId)", async () => {
    const { client } = clientReturning(wireFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    expect(result.steps[1]?.dispatch).toEqual({
      childExecutionId: "exec_0002",
      targetType: "orchestration",
      correlationId: "exec_0002",
      status: "resolved",
    });
    expect(result.steps[0]?.dispatch).toBeNull();
  });

  it("passes step logs and events through", async () => {
    const { client } = clientReturning(wireFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    // logs is the wire array, not silently coerced to null.
    expect(result.steps[0]?.logs).toEqual([
      { ts: "2026-01-01T00:00:05.000Z", level: "info", msg: "fetched 12 items" },
    ]);
    expect(result.steps[0]?.events[0]?.kind).toBe("tool_use");
    expect(result.steps[1]?.logs).toBeNull();
  });
});

describe("inspect() cost decoding when the projection carries cost", () => {
  it("never collapses authorized vs captured; carries settleState at every node", async () => {
    const { client } = clientReturning(withCostFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    expect(result.cost).toEqual({
      authorizedUsd: "1.50",
      capturedUsd: "1.20",
      settleState: "settling",
    });
    // Per-step cost is present and distinct — not a single rolled-up number.
    expect(result.steps[0]?.cost).toEqual({
      authorizedUsd: "0.50",
      capturedUsd: "0.50",
      settleState: "final",
    });
  });
});

describe("inspect() graceful decode of pre-seam runs", () => {
  it("decodes an older run (no traceParent/cost) without throwing", async () => {
    const { client } = clientReturning(preseamFixture);
    const result = await inspect({ executionId: "exec_legacy_0001" }, client);

    // Tree degrades to self: the run is its own single-node tree.
    expect(result.traceRoot).toBe("exec_legacy_0001");
    expect(result.rootExecutionId).toBe("exec_legacy_0001");
    expect(result.traceParent).toBeNull();
    expect(result.parentExecutionId).toBeNull();
    expect(result.traceId).toBeNull();
    expect(result.children).toEqual([]);
  });

  it("reports null cost (honest absence) for a pre-seam run and its steps", async () => {
    const result = decodeExecutionProjection(preseamFixture);

    expect(result.cost).toBeNull();
    const step = result.steps[0];
    expect(step?.cost).toBeNull();
    // Missing per-step fields are filled, not dropped.
    expect(step?.spanId).toBeNull();
    expect(step?.events).toEqual([]);
    expect(step?.dispatch).toBeNull();
    expect(step?.error).toBeNull();
  });

  it("does not throw on an empty/garbage body", () => {
    expect(() => decodeExecutionProjection(undefined)).not.toThrow();
    expect(() => decodeExecutionProjection({})).not.toThrow();
    expect(decodeExecutionProjection({ id: "x" }).traceRoot).toBe("x");
  });
});

describe("listExecutions() is tree-aware (with documented server-side degrade)", () => {
  it("maps summary rows to ExecutionRef[]; traceRoot uses lineage when present, else the row id", async () => {
    const { client, paths } = clientReturning([
      // A row carrying lineage groups correctly...
      { id: "exec_0002", name: "render-child", status: "completed", rootExecutionId: "exec_0001" },
      // ...while a lineage-less row degrades to self-rooted (tracked server-side gap).
      { id: "exec_0003", name: "adhoc", status: "running" },
    ]);

    const refs = await listExecutions(client);

    expect(paths).toEqual(["/executions"]);
    expect(refs).toEqual([
      { executionId: "exec_0002", traceRoot: "exec_0001", name: "render-child", status: "completed" },
      { executionId: "exec_0003", traceRoot: "exec_0003", name: "adhoc", status: "running" },
    ]);
  });

  it("returns [] for a non-array body rather than throwing", async () => {
    const { client } = clientReturning(null);
    expect(await listExecutions(client)).toEqual([]);
  });
});
