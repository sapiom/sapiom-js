import { describe, expect, it } from "vitest";

import {
  emptyAgentRunIndex,
  moveAgentRuns,
  moveRunAttribution,
  pickAgentRun,
  recordAgentRun,
  runIdsForAgent,
  shownRunIdByAgent,
} from "./agent-run-store";

const A = "/work/proj/agents/intake";
const B = "/work/proj/agents/triage";

describe("agent run store: runs keyed by agent path", () => {
  it("files a run under the agent it ran, with no session anywhere", () => {
    const index = recordAgentRun(emptyAgentRunIndex(), A, "local-1");
    expect(runIdsForAgent(index, A)).toEqual(["local-1"]);
    expect(runIdsForAgent(index, B)).toEqual([]);
    expect(shownRunIdByAgent(index).get(A)).toBe("local-1");
  });

  it("keeps each agent's runs apart and in start order", () => {
    let index = emptyAgentRunIndex();
    index = recordAgentRun(index, A, "r1");
    index = recordAgentRun(index, B, "r2");
    index = recordAgentRun(index, A, "r3");
    expect(runIdsForAgent(index, A)).toEqual(["r1", "r3"]);
    expect(runIdsForAgent(index, B)).toEqual(["r2"]);
    expect(shownRunIdByAgent(index)).toEqual(
      new Map([
        [A, "r3"],
        [B, "r2"],
      ]),
    );
  });

  it("a repeat announcement of the same run changes nothing", () => {
    const once = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    expect(recordAgentRun(once, A, "r1")).toBe(once);
  });

  it("one agent spelled two ways is one key (trailing separator)", () => {
    let index = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    index = recordAgentRun(index, `${A}/`, "r2");
    expect([...index.idsByAgent.keys()]).toEqual([A]);
    expect(runIdsForAgent(index, `${A}/`)).toEqual(["r1", "r2"]);
  });

  it("a pick shows a past run until a fresh run starts", () => {
    let index = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    index = recordAgentRun(index, A, "r2");
    index = pickAgentRun(index, A, "r1");
    expect(shownRunIdByAgent(index).get(A)).toBe("r1");
    index = recordAgentRun(index, A, "r3");
    expect(index.pickedByAgent.has(A)).toBe(false);
    expect(shownRunIdByAgent(index).get(A)).toBe("r3");
  });

  it("a fresh run of one agent leaves another agent's pick alone", () => {
    let index = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    index = recordAgentRun(index, B, "r2");
    index = recordAgentRun(index, B, "r3");
    index = pickAgentRun(index, B, "r2");
    index = recordAgentRun(index, A, "r4");
    expect(shownRunIdByAgent(index).get(B)).toBe("r2");
  });

  it("a pick of a run not filed under the agent falls back to its latest", () => {
    let index = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    index = pickAgentRun(index, A, "someone-elses");
    expect(shownRunIdByAgent(index).get(A)).toBe("r1");
  });

  it("Change location carries the agent's runs and pick to its new path", () => {
    const moved = "/work/proj/flows/intake";
    let index = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    index = recordAgentRun(index, A, "r2");
    index = pickAgentRun(index, A, "r1");
    index = moveAgentRuns(index, A, moved);
    expect(runIdsForAgent(index, A)).toEqual([]);
    expect(runIdsForAgent(index, moved)).toEqual(["r1", "r2"]);
    expect(shownRunIdByAgent(index).get(moved)).toBe("r1");
  });

  it("moving an agent with no runs returns the same index", () => {
    const index = recordAgentRun(emptyAgentRunIndex(), A, "r1");
    expect(moveAgentRuns(index, B, "/elsewhere/triage")).toBe(index);
  });
});

describe("moveRunAttribution: a moved agent's run snapshots follow it", () => {
  const observed = (workflowPath: string | null) => ({ workflowPath, observedAt: 1 });

  it("re-attributes every snapshot of the moved agent, any spelling", () => {
    const moved = "/work/proj/flows/intake";
    const runs = new Map([
      ["r1", observed(A)],
      ["r2", observed(`${A}/`)],
      ["r3", observed(B)],
      ["r4", observed(null)],
    ]);
    const next = moveRunAttribution(runs, A, moved);
    expect(next.get("r1")?.workflowPath).toBe(moved);
    expect(next.get("r2")?.workflowPath).toBe(moved);
    expect(next.get("r3")?.workflowPath).toBe(B);
    expect(next.get("r4")?.workflowPath).toBeNull();
    expect(runs.get("r1")?.workflowPath).toBe(A);
  });

  it("returns the same map when no snapshot names the agent", () => {
    const runs = new Map([["r1", observed(B)]]);
    expect(moveRunAttribution(runs, A, "/elsewhere/intake")).toBe(runs);
  });
});
