import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// The bootstrap runs a workflow via @sapiom/agent-core's runLocalFromDir; mock
// it so these unit tests exercise the NDJSON framing + error handling without
// esbuild-bundling a real project or spawning anything. `vi.hoisted` lets the
// mock fn be referenced inside the (hoisted) vi.mock factory.
const { runLocalFromDir } = vi.hoisted(() => ({ runLocalFromDir: vi.fn() }));
vi.mock("@sapiom/agent-core", () => ({ runLocalFromDir }));

import {
  parseRunLocalRequest,
  runBootstrap,
  type RunLocalSummaryLine,
} from "./run-local-bootstrap.js";

/** Collect everything written to a sink stream as decoded NDJSON objects. */
function collect(): {
  sink: PassThrough;
  lines: () => Array<Record<string, unknown>>;
} {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return {
    sink,
    lines: () =>
      Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

afterEach(() => {
  runLocalFromDir.mockReset();
});

describe("parseRunLocalRequest", () => {
  it("parses a full request, coercing a non-number maxAttemptsPerStep away", () => {
    const req = parseRunLocalRequest(
      JSON.stringify({
        sourceDir: "/proj/agent",
        input: { name: "x" },
        stubs: { version: 1, steps: {} },
        maxAttemptsPerStep: "3", // wrong type — dropped
      }),
    );
    expect(req).toEqual({
      sourceDir: "/proj/agent",
      input: { name: "x" },
      stubs: { version: 1, steps: {} },
      maxAttemptsPerStep: undefined,
    });
  });

  it("keeps a numeric maxAttemptsPerStep", () => {
    const req = parseRunLocalRequest(
      JSON.stringify({ sourceDir: "/proj/agent", maxAttemptsPerStep: 5 }),
    );
    expect(req.maxAttemptsPerStep).toBe(5);
  });

  it("throws a caller-safe error on non-JSON input", () => {
    expect(() => parseRunLocalRequest("not json")).toThrow(
      "run-local request is not valid JSON",
    );
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseRunLocalRequest("42")).toThrow(
      "run-local request must be a JSON object",
    );
    expect(() => parseRunLocalRequest("null")).toThrow(
      "run-local request must be a JSON object",
    );
  });

  it("throws when sourceDir is missing or blank", () => {
    expect(() => parseRunLocalRequest(JSON.stringify({}))).toThrow(
      "requires a non-empty sourceDir",
    );
    expect(() =>
      parseRunLocalRequest(JSON.stringify({ sourceDir: "   " })),
    ).toThrow("requires a non-empty sourceDir");
  });
});

describe("runBootstrap", () => {
  it("streams one line per step then a terminal summary, exit 0", async () => {
    runLocalFromDir.mockResolvedValue({
      outcome: "completed",
      executionId: "exec_1",
      output: { greeting: "hi" },
      error: undefined,
      steps: [
        {
          step: "greet",
          attempt: 0,
          input: { name: "x" },
          status: "succeeded",
          output: { greeting: "hi" },
          logs: [],
        },
      ],
      unusedStubs: [{ step: "greet", key: "web.search" }],
      stubWarnings: ["greet: models.coding.run stub had the wrong shape"],
    });

    const { sink, lines } = collect();
    const code = await runBootstrap({ sourceDir: "/proj/agent" }, sink);

    expect(code).toBe(0);
    const out = lines();
    // The mock does not invoke the onStepTrace callback, so only the summary is
    // emitted here. Integration coverage in agent-core proves live callbacks.
    // Terminal summary carries the run outcome + both stub-hygiene signals.
    const summary = out[0] as unknown as RunLocalSummaryLine;
    expect(summary.kind).toBe("summary");
    expect(summary.outcome).toBe("completed");
    expect(summary.unusedStubs).toEqual([{ step: "greet", key: "web.search" }]);
    expect(summary.stubWarnings).toEqual([
      "greet: models.coding.run stub had the wrong shape",
    ]);
  });

  it("surfaces unusedStubs/stubWarnings even for a failed run (still exit 0)", async () => {
    runLocalFromDir.mockResolvedValue({
      outcome: "failed",
      executionId: "exec_2",
      error: { message: "step threw" },
      steps: [],
      unusedStubs: [{ step: "a", key: "b" }],
      stubWarnings: ["w"],
    });

    const { sink, lines } = collect();
    const code = await runBootstrap({ sourceDir: "/proj/agent" }, sink);

    // A failed *run* is a successful *invocation* — exit 0, summary in-band.
    expect(code).toBe(0);
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "summary",
      outcome: "failed",
      unusedStubs: [{ step: "a", key: "b" }],
      stubWarnings: ["w"],
    });
  });

  it("emits a terminal error line and exit 1 when the run cannot be invoked", async () => {
    runLocalFromDir.mockRejectedValue(new Error("No index.ts found in /proj."));

    const { sink, lines } = collect();
    const code = await runBootstrap({ sourceDir: "/proj" }, sink);

    expect(code).toBe(1);
    const out = lines();
    expect(out).toEqual([
      { kind: "error", outcome: "failed", error: "No index.ts found in /proj." },
    ]);
  });

  it("forwards input/stubs/maxAttemptsPerStep through to runLocalFromDir", async () => {
    runLocalFromDir.mockResolvedValue({
      outcome: "completed",
      executionId: "e",
      steps: [],
      unusedStubs: [],
      stubWarnings: [],
    });

    const { sink } = collect();
    await runBootstrap(
      {
        sourceDir: "/proj/agent",
        input: { a: 1 },
        stubs: { version: 1, steps: {} },
        maxAttemptsPerStep: 2,
      },
      sink,
    );

    expect(runLocalFromDir).toHaveBeenCalledWith({
      sourceDir: "/proj/agent",
      input: { a: 1 },
      stubs: { version: 1, steps: {} },
      maxAttemptsPerStep: 2,
      onStepTrace: expect.any(Function),
    });
  });

  it("streams started and settled events as the dispatcher emits them", async () => {
    runLocalFromDir.mockImplementation(async (opts) => {
      opts.onStepTrace("started", {
        step: "greet",
        attempt: 1,
        input: { name: "Ada" },
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        logs: [],
      });
      opts.onStepTrace("settled", {
        step: "greet",
        attempt: 1,
        input: { name: "Ada" },
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.010Z",
        output: { greeting: "hi" },
        directive: { kind: "terminate" },
        sharedStateAfter: { greeted: true },
        logs: [],
      });
      return {
        outcome: "completed",
        executionId: "exec_1",
        output: { greeting: "hi" },
        steps: [],
        unusedStubs: [],
        stubWarnings: [],
      };
    });

    const { sink, lines } = collect();
    await runBootstrap({ sourceDir: "/proj/agent" }, sink);

    expect(lines()).toEqual([
      expect.objectContaining({
        kind: "step",
        phase: "started",
        trace: expect.objectContaining({ step: "greet", status: "running" }),
      }),
      expect.objectContaining({
        kind: "step",
        phase: "settled",
        trace: expect.objectContaining({
          step: "greet",
          status: "succeeded",
          sharedStateAfter: { greeted: true },
        }),
      }),
      expect.objectContaining({ kind: "summary", outcome: "completed" }),
    ]);
  });
});
