import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionProjection, StepProjection } from "@sapiom/agent-core";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

// Keep the real module but stub the networked reads so the inspect tool is
// exercised without touching the backend. The projection under test runs on the
// value these fns return, so the SDK contract stays a passthrough.
vi.mock("@sapiom/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sapiom/agent-core")>();
  return {
    ...actual,
    inspect: vi.fn(),
    waitForExecution: vi.fn(),
  };
});

import { register } from "./agents.js";
import { readCredentials } from "../credentials.js";
import { inspect, waitForExecution } from "@sapiom/agent-core";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: any, handler: ToolHandler) => {
        handlers.set(_name, handler);
      },
    ),
  } as unknown as McpServer;
  return { server, handlers };
}

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text);

/** A 3 MB step output — the pathological body the tool must never dump. */
const HUGE_OUTPUT = "X".repeat(3_000_000);

function makeStep(order: number, over: boolean): StepProjection {
  const failed = order === 4;
  return {
    stepName: `step_${order}`,
    stepOrder: order,
    attempt: 1,
    status: failed ? "failed" : "completed",
    spanId: null,
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:00:01.000Z",
    input: { order, payload: `input-for-${order}` },
    output: over ? HUGE_OUTPUT : { ok: true, order },
    sharedStateAfter: { counter: order },
    nextDirective: { kind: "continue" },
    cost: null,
    logs: [{ ts: "t", level: "info", msg: `log ${order}` }],
    events: [],
    error: failed
      ? {
          message: `step ${order} blew up`,
          trace: null,
          traceUnavailableReason: "n/a",
        }
      : null,
    dispatch: null,
  };
}

function makeExecution(): ExecutionProjection {
  const steps = Array.from({ length: 20 }, (_, i) =>
    makeStep(i + 1, i + 1 === 4),
  );
  return {
    id: "exec-1",
    name: "my-agent",
    organizationId: "org-1",
    tenantId: "t-1",
    status: "failed",
    currentStep: "step_4",
    currentStepAttempt: 1,
    version: 3,
    definitionId: "def-1",
    buildRunId: "build-1",
    idempotencyKey: null,
    pausedSignalName: null,
    pausedSignalCorrelationId: null,
    pausedUntil: null,
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:00:20.000Z",
    input: { seed: 1 },
    sharedState: { counter: 20 },
    output: null,
    error: { message: "run failed at step_4" },
    pausedStepInputSchema: null,
    pausedStepInputExample: null,
    traceRoot: "exec-1",
    rootExecutionId: "exec-1",
    traceParent: null,
    parentExecutionId: null,
    traceId: "trace-1",
    children: [],
    cost: null,
    steps,
  };
}

/** A generous char ceiling the bounded result must stay under regardless of the
 *  3 MB body in the fixture. */
const CEILING = 250_000;

describe("sapiom_dev_agents_inspect compact projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCredentials).mockResolvedValue({
      apiKey: "sk_test",
      tenantId: "t-1",
      organizationName: "Org",
      apiKeyId: "k-1",
    } as never);
  });

  it("default (executionId only) is compact and bounded — no full bodies", async () => {
    vi.mocked(inspect).mockResolvedValue(makeExecution());
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_inspect")!({
      executionId: "exec-1",
    });

    // SDK inspect() is called as a plain passthrough — no projection args leak in.
    expect(inspect).toHaveBeenCalledWith(
      { executionId: "exec-1" },
      expect.anything(),
    );

    const text = res.content[0].text;
    expect(text.length).toBeLessThan(CEILING);
    // The 3 MB body must not be dumped anywhere in the result.
    expect(text.includes("X".repeat(40_000))).toBe(false);

    const out = parse(res);
    expect(out.webappUrl).toContain("app.sapiom.ai");
    expect(out.execution.steps).toHaveLength(20);

    const failed = out.execution.steps.find(
      (s: any) => s.stepName === "step_4",
    );
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("step 4 blew up");
    // Compact steps carry hints, not bodies.
    expect(failed.has).toMatchObject({
      input: true,
      output: true,
      error: true,
    });
    expect(failed.sizes.output).toBeGreaterThan(2_900_000);
    expect(failed).not.toHaveProperty("output");
    expect(failed).not.toHaveProperty("input");
    expect(failed).not.toHaveProperty("logs");

    // Heavy top-level fields are previews, not verbatim copies.
    expect(out.execution.error.preview).toBeDefined();
    expect(out.execution.errorMessage).toBe("run failed at step_4");
  });

  it("expands only the selected step's requested fields, still bounded", async () => {
    vi.mocked(inspect).mockResolvedValue(makeExecution());
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_inspect")!({
      executionId: "exec-1",
      step: "step_4",
      include: ["input", "error"],
    });

    expect(res.content[0].text.length).toBeLessThan(CEILING);
    const out = parse(res);
    const step4 = out.execution.steps.find((s: any) => s.stepName === "step_4");
    // Requested fields are expanded verbatim (small enough to fit budget).
    expect(step4.input).toEqual({ order: 4, payload: "input-for-4" });
    expect(step4.error.message).toBe("step 4 blew up");
    // Non-requested heavy fields stay omitted, even on the selected step.
    expect(step4).not.toHaveProperty("output");
    expect(step4).not.toHaveProperty("logs");
    // Other steps are untouched (no expansion leaked to them).
    const step3 = out.execution.steps.find((s: any) => s.stepName === "step_3");
    expect(step3).not.toHaveProperty("input");
  });

  it("truncates an over-budget expanded field with a marker citing webappUrl", async () => {
    vi.mocked(inspect).mockResolvedValue(makeExecution());
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_inspect")!({
      executionId: "exec-1",
      step: 4, // by order
      include: ["output"],
    });

    expect(res.content[0].text.length).toBeLessThan(CEILING);
    const out = parse(res);
    const step4 = out.execution.steps.find((s: any) => s.stepOrder === 4);
    expect(typeof step4.output).toBe("string");
    expect(step4.output).toContain("[truncated");
    expect(step4.output).toMatch(/truncated \d+ chars/);
    expect(step4.output).toContain("app.sapiom.ai");
  });

  it("wait:true returns the same compact/budgeted shape as the snapshot branch", async () => {
    vi.mocked(waitForExecution).mockResolvedValue({
      execution: makeExecution(),
      reason: "terminal",
      done: true,
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_inspect")!({
      executionId: "exec-1",
      wait: true,
    });

    const text = res.content[0].text;
    expect(text.length).toBeLessThan(CEILING);
    expect(text.includes("X".repeat(40_000))).toBe(false);

    const out = parse(res);
    expect(out.done).toBe(true);
    expect(out.waiting).toBe(false);
    expect(out.webappUrl).toContain("app.sapiom.ai");
    expect(out.execution.steps).toHaveLength(20);
    const failed = out.execution.steps.find((s: any) => s.stepOrder === 4);
    expect(failed.has.output).toBe(true);
    expect(failed).not.toHaveProperty("output");
  });
});
