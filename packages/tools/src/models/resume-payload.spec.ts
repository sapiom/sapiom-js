/**
 * The coding-run resume-payload contract: the shape a step resumed from
 * `pauseUntilSignal(codingHandle, …)` receives as input.
 *
 * Pins three things to one shape so they can't drift apart silently:
 *   - `codingResultSchema` accepts a real resume payload and rejects a payload
 *     missing `executionEnvironment`.
 *   - `toResumePayload` maps a live result to that shape (no live handles).
 *   - the stub client registers exactly that shape for a paused step to resume on.
 */
import {
  codingResultSchema,
  CodingResultSchemaError,
  toResumePayload,
  EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
  type CodingResultPayload,
  type CodingRunResult,
} from "./index.js";
import { createStubClient } from "../stub/index.js";

/** A representative payload as delivered to a resumed step. */
const RESUME_PAYLOAD: CodingResultPayload = {
  runId: "run-1",
  status: "completed",
  summary: "Created CHANGELOG.md with a dated section and committed it.",
  result: {
    success: true,
    turns: 5,
    modelUsed: null,
    durationMs: 25442,
    toolCallCount: 4,
    usage: {
      inputTokens: 7,
      outputTokens: 581,
      cacheReadTokens: 522283,
      cacheCreateTokens: 8566,
      thinkingTokens: 0,
    },
  },
  error: null,
  executionEnvironment: {
    type: EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
    id: "agents-run-1",
  },
};

describe("codingResultSchema", () => {
  it("accepts a well-formed resume payload and returns it", () => {
    expect(codingResultSchema.parse(RESUME_PAYLOAD)).toEqual(RESUME_PAYLOAD);
  });

  it("accepts a null executionEnvironment (no environment provisioned)", () => {
    expect(() =>
      codingResultSchema.parse({
        ...RESUME_PAYLOAD,
        executionEnvironment: null,
      }),
    ).not.toThrow();
  });

  it("rejects a payload missing executionEnvironment", () => {
    const withoutEnv: Record<string, unknown> = { ...RESUME_PAYLOAD };
    delete withoutEnv.executionEnvironment;
    expect(() => codingResultSchema.parse(withoutEnv)).toThrow(
      CodingResultSchemaError,
    );
  });

  it("rejects a payload carrying a sandbox handle shape instead of executionEnvironment", () => {
    const sandboxShape = {
      runId: "run-1",
      status: "completed",
      summary: null,
      result: null,
      error: null,
      sandbox: { name: "agents-run-1", workspaceRoot: "/workspace" },
    };
    expect(() => codingResultSchema.parse(sandboxShape)).toThrow(
      CodingResultSchemaError,
    );
  });

  it("rejects an unknown status", () => {
    expect(() =>
      codingResultSchema.parse({ ...RESUME_PAYLOAD, status: "done" }),
    ).toThrow(CodingResultSchemaError);
  });
});

describe("toResumePayload", () => {
  it("maps a live result to the wire shape (executionEnvironment, no live handle)", () => {
    const live = {
      runId: "r",
      status: "completed",
      summary: "s",
      result: null,
      error: null,
      sandbox: { name: "sb-1" },
    } as unknown as CodingRunResult;

    const payload = toResumePayload(live);

    expect(payload.executionEnvironment).toEqual({
      type: EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
      id: "sb-1",
    });
    expect(
      (payload as unknown as Record<string, unknown>).sandbox,
    ).toBeUndefined();
    expect(() => codingResultSchema.parse(payload)).not.toThrow();
  });
});

describe("stub client resume payload", () => {
  it("registers a payload matching the schema for a paused step to resume on", async () => {
    const signals = new Map<string, unknown>();
    const client = createStubClient({ signals });

    const handle = await client.models.coding.launch({ task: "do a thing" });
    const payload = signals.get(handle.dispatch.correlationId);

    // The stub must hand back exactly the wire shape — schema-valid, an
    // executionEnvironment reference, and no live sandbox handle.
    const parsed = codingResultSchema.parse(payload);
    expect(parsed.executionEnvironment).not.toBeNull();
    expect(parsed.executionEnvironment?.type).toBe(
      EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
    );
    expect((payload as Record<string, unknown>).sandbox).toBeUndefined();
  });
});
