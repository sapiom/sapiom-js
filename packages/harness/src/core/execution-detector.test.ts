import { describe, it, expect, vi } from "vitest";

import { ExecutionDetector, parseExecutionIds } from "./execution-detector.js";

function makeDetector() {
  const onExecution = vi.fn();
  const detector = new ExecutionDetector({ onExecution });
  return { detector, onExecution };
}

describe("parseExecutionIds", () => {
  it("extracts the id from the CLI's start line (ignoring the check-mark prefix)", () => {
    expect(parseExecutionIds("✓ Started execution exec_0001")).toEqual([
      "exec_0001",
    ]);
  });

  it("extracts the id when embedded in surrounding output", () => {
    const line =
      "some log\nStarted execution exec_abc-123\n  inspect: sapiom agents logs exec_abc-123";
    // Only the "Started execution" announcement is a match — the inspect hint is not.
    expect(parseExecutionIds(line)).toEqual(["exec_abc-123"]);
  });

  it("stops the id at the first non-id char (bracket, ANSI reset, whitespace, ...)", () => {
    // Anything outside [A-Za-z0-9_-] terminates the id, so a colored CLI's
    // reset sequence (ESC + "[0m") after the id still yields just exec_9.
    expect(parseExecutionIds("Started execution exec_9[0m done")).toEqual([
      "exec_9",
    ]);
    expect(parseExecutionIds("Started execution exec_9 done")).toEqual([
      "exec_9",
    ]);
  });

  it("finds multiple distinct announcements in order", () => {
    expect(
      parseExecutionIds(
        "Started execution exec_a then Started execution exec_b",
      ),
    ).toEqual(["exec_a", "exec_b"]);
  });

  it("returns empty when there is no announcement", () => {
    expect(
      parseExecutionIds("Compiled successfully. Started the dev server."),
    ).toEqual([]);
  });

  it("does not match a different verb ('Starting' / 'started the')", () => {
    expect(
      parseExecutionIds("Starting execution now; started the run"),
    ).toEqual([]);
  });

  it("extracts the id from the MCP run tool's JSON result (executionId field)", () => {
    // The common path: the coding agent starts the run via the MCP tool, whose
    // result carries the id as a field — NOT the CLI's "Started execution" line.
    expect(
      parseExecutionIds('{"status":"enqueued","executionId":"47663"}'),
    ).toEqual(["47663"]);
  });

  it("extracts the id from an executionId field with assorted separators", () => {
    expect(parseExecutionIds("executionId: 47663")).toEqual(["47663"]);
    expect(parseExecutionIds("executionId=exec_9")).toEqual(["exec_9"]);
    expect(parseExecutionIds('executionId : "abc-1"')).toEqual(["abc-1"]);
  });

  it("catches both the CLI line and an executionId field in the same text", () => {
    expect(
      parseExecutionIds(
        'Started execution exec_a ... {"executionId":"exec_b"}',
      ),
    ).toEqual(["exec_a", "exec_b"]);
  });

  it("does not match the bare word 'execution' without the CLI verb or the Id field", () => {
    // Guards against over-broad matching: "execution 47663" alone (e.g. prose or
    // an inspect line) must NOT fire — only "Started execution" or "executionId".
    expect(parseExecutionIds("inspecting execution 47663 now")).toEqual([]);
  });
});

describe("ExecutionDetector.feed", () => {
  it("emits once for an id in a single chunk, tagged prod", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed(
      "some noise\nStarted execution exec_0001\nnext line\n",
      "sess-1",
    );
    expect(onExecution).toHaveBeenCalledWith("sess-1", "exec_0001", "prod");
  });

  it("does not fire when there's no announcement", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("running the agent...\n", "sess-1");
    expect(onExecution).not.toHaveBeenCalled();
  });

  it("emits for the MCP run tool's structured result (executionId field), tagged prod", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed('{"status":"enqueued","executionId":"47663"}\n', "sess-1");
    expect(onExecution).toHaveBeenCalledWith("sess-1", "47663", "prod");
  });

  it("detects an id split across two chunks", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("...Started execu", "sess-1");
    expect(onExecution).not.toHaveBeenCalled();
    detector.feed("tion exec_5150\n", "sess-1");
    expect(onExecution).toHaveBeenCalledWith("sess-1", "exec_5150", "prod");
  });

  it("dedupes repeated appearances of the same (session, id)", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed(
      "Started execution exec_1\nStarted execution exec_1\n",
      "sess-1",
    );
    detector.feed("still Started execution exec_1\n", "sess-1");
    expect(onExecution).toHaveBeenCalledTimes(1);
  });

  it("tracks ids independently per session", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_1\n", "sess-1");
    detector.feed("Started execution exec_1\n", "sess-2");
    expect(onExecution).toHaveBeenCalledTimes(2);
    expect(onExecution).toHaveBeenNthCalledWith(1, "sess-1", "exec_1", "prod");
    expect(onExecution).toHaveBeenNthCalledWith(2, "sess-2", "exec_1", "prod");
  });

  it("fires again for a genuinely different id on the same session", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_1\n", "sess-1");
    detector.feed("Started execution exec_2\n", "sess-1");
    expect(onExecution).toHaveBeenCalledTimes(2);
  });

  it("holds back an id that lands exactly at the end of a chunk, without flush()", () => {
    // A discrete tool.call payload commonly ends *exactly* on the id — the CLI
    // shape "Started execution exec_123" with no trailing character.
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_123", "sess-1");
    expect(onExecution).not.toHaveBeenCalled();
  });
});

describe("ExecutionDetector.flush", () => {
  it("finalizes an id held back at the end of a discrete, complete string", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_123", "sess-1");
    expect(onExecution).not.toHaveBeenCalled();

    detector.flush("sess-1");
    expect(onExecution).toHaveBeenCalledWith("sess-1", "exec_123", "prod");
  });

  it("is a harmless no-op when there's nothing pending", () => {
    const { detector, onExecution } = makeDetector();
    detector.flush("sess-1");
    expect(onExecution).not.toHaveBeenCalled();
  });

  it("does not re-emit an already-finalized id", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_1\n", "sess-1");
    detector.flush("sess-1");
    expect(onExecution).toHaveBeenCalledTimes(1);
  });

  it("still respects per-(session,id) dedupe across feed+flush calls", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_1", "sess-1");
    detector.flush("sess-1");
    detector.feed("Started execution exec_1", "sess-1");
    detector.flush("sess-1");
    expect(onExecution).toHaveBeenCalledTimes(1);
  });
});

describe("ExecutionDetector.reset", () => {
  it("clears dedupe state so the same id fires again", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_1\n", "sess-1");
    expect(onExecution).toHaveBeenCalledTimes(1);
    detector.reset("sess-1");
    detector.feed("Started execution exec_1\n", "sess-1");
    expect(onExecution).toHaveBeenCalledTimes(2);
  });

  it("clears a pending (held-back) match too", () => {
    const { detector, onExecution } = makeDetector();
    detector.feed("Started execution exec_9", "sess-1");
    detector.reset("sess-1");
    detector.flush("sess-1");
    expect(onExecution).not.toHaveBeenCalled();
  });
});
