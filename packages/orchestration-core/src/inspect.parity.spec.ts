/**
 * REST parity + graceful-decode contract for the inspection surface.
 *
 * The canonical fixture is a checked-in REST `ExecutionProjection`. `inspect()`
 * is a thin passthrough: decoding that body must return the SAME shape, same
 * nesting, same fields — no divergent SDK model. A separate pre-seam fixture
 * (no lineage, no cost, reduced steps) asserts the SDK degrades exactly how the
 * REST DTO does rather than throwing on older executions.
 */
import type { GatewayClient } from "./client.js";
import { decodeExecutionProjection } from "./decode.js";
import { inspect, listExecutions } from "./inspect.js";
import type { ExecutionProjection } from "./types.js";
import projectionFixture from "./__tests__/execution-projection.fixture.json";
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

describe("inspect() REST parity", () => {
  it("decodes the checked-in REST projection to the identical shape (parity)", async () => {
    const { client, paths } = clientReturning(projectionFixture);

    const result = await inspect({ executionId: "exec_0001" }, client);

    // Same fields, same nesting as the REST fixture — no reshape SDK-side.
    expect(result).toEqual(projectionFixture as unknown as ExecutionProjection);
    expect(paths).toEqual(["/executions/exec_0001"]);
  });

  it("carries the full tree + trace identity", async () => {
    const { client } = clientReturning(projectionFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    expect(result.traceRoot).toBe("exec_0001");
    expect(result.rootExecutionId).toBe("exec_0001");
    expect(result.traceId).toBe("trace_0001");
    expect(result.traceParent).toBeNull();
    expect(result.parentExecutionId).toBeNull();
    expect(result.children).toEqual([
      {
        executionId: "exec_0002",
        traceRoot: "exec_0001",
        name: "render-child",
        status: "completed",
      },
    ]);
    expect(result.steps[1]?.spanId).toBe("span_0002");
  });

  it("never collapses authorized vs captured; carries settleState at every node", async () => {
    const { client } = clientReturning(projectionFixture);
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
    expect(result.steps[1]?.cost.authorizedUsd).toBe("1.00");
    expect(result.steps[1]?.cost.capturedUsd).toBe("0.70");
  });

  it("exposes typed DispatchRef and StepError", async () => {
    const { client } = clientReturning(projectionFixture);
    const result = await inspect({ executionId: "exec_0001" }, client);

    expect(result.steps[1]?.dispatch).toEqual({
      dispatchId: "dispatch_0001",
      childExecutionId: "exec_0002",
      targetType: "orchestration",
      status: "resolved",
      correlationId: "exec_0002",
    });
    expect(result.steps[1]?.error).toEqual({
      message: "template not found",
      trace: "Error: template not found\n    at render (src/steps/render.ts:12:11)",
      traceUnavailableReason: null,
    });
    expect(result.steps[0]?.dispatch).toBeNull();
    expect(result.steps[0]?.error).toBeNull();
    expect(result.steps[0]?.events[0]?.kind).toBe("tool_use");
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

  it("falls back to a flat zeroed cost that still keeps the two legs distinct", async () => {
    const result = decodeExecutionProjection(preseamFixture);

    expect(result.cost).toEqual({
      authorizedUsd: "0",
      capturedUsd: "0",
      settleState: "final",
    });
    // Missing per-step cost/events/dispatch/error are filled, not dropped.
    const step = result.steps[0];
    expect(step?.cost).toEqual({
      authorizedUsd: "0",
      capturedUsd: "0",
      settleState: "final",
    });
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

describe("listExecutions() is tree-aware", () => {
  it("maps summary rows to ExecutionRef[] with traceRoot degrading to the row id", async () => {
    const { client, paths } = clientReturning([
      { id: "exec_0001", name: "daily-digest", status: "completed", rootExecutionId: "exec_0001" },
      { id: "exec_0003", name: "adhoc", status: "running" },
    ]);

    const refs = await listExecutions(client);

    expect(paths).toEqual(["/executions"]);
    expect(refs).toEqual([
      { executionId: "exec_0001", traceRoot: "exec_0001", name: "daily-digest", status: "completed" },
      { executionId: "exec_0003", traceRoot: "exec_0003", name: "adhoc", status: "running" },
    ]);
  });

  it("returns [] for a non-array body rather than throwing", async () => {
    const { client } = clientReturning(null);
    expect(await listExecutions(client)).toEqual([]);
  });
});
