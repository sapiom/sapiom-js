import { describe, expect, it } from "vitest";

import {
  agentProvenance,
  agentSource,
  deployErrorKind,
  initialRunFunnelState,
  localRunOutcomeKind,
  MAX_RUN_POLL_FAILURES,
  runFunnelStep,
  type RunFunnelEvent,
  newAgentPaths,
  runErrorKind,
  slugFromPath,
} from "./lifecycle";

describe("slugFromPath", () => {
  it("returns the last segment of an absolute path", () => {
    expect(slugFromPath("/Users/demo/acme-app/leasing")).toBe("leasing");
  });

  it("ignores a trailing slash", () => {
    expect(slugFromPath("/Users/demo/acme-app/leasing/")).toBe("leasing");
  });

  it("handles a single segment and Windows separators", () => {
    expect(slugFromPath("leasing")).toBe("leasing");
    expect(slugFromPath("C:\\Users\\demo\\rfq")).toBe("rfq");
  });

  it("never returns the full path", () => {
    const path = "/Users/demo/acme-app/leasing";
    expect(slugFromPath(path)).not.toContain("/");
  });
});

describe("newAgentPaths", () => {
  const wf = (path: string) => ({ path });

  it("returns nothing when everything is already seen (seeded)", () => {
    const seen = new Set(["/a", "/b"]);
    expect(newAgentPaths(seen, [wf("/a"), wf("/b")])).toEqual([]);
  });

  it("returns only genuinely new paths", () => {
    const seen = new Set(["/a"]);
    expect(newAgentPaths(seen, [wf("/a"), wf("/b"), wf("/c")])).toEqual(["/b", "/c"]);
  });

  it("does not re-report a path once it has been added to seen", () => {
    const seen = new Set<string>(["/a"]);
    const fresh = newAgentPaths(seen, [wf("/a"), wf("/b")]);
    expect(fresh).toEqual(["/b"]);
    for (const p of fresh) seen.add(p);
    // A later refresh (e.g. a removal + re-add elsewhere) with the same set
    // reports nothing new.
    expect(newAgentPaths(seen, [wf("/a"), wf("/b")])).toEqual([]);
  });

  it("a removed agent does not fire, and re-adding a removed path counts once", () => {
    const seen = new Set<string>(["/a", "/b"]);
    // /b removed from the registry — no event, and it stays in `seen`.
    expect(newAgentPaths(seen, [wf("/a")])).toEqual([]);
    // /a still seen; nothing new.
    expect(newAgentPaths(seen, [wf("/a")])).toEqual([]);
  });
});

describe("agentSource", () => {
  it("templateId → template", () => {
    expect(agentSource({ templateId: "web-research-digest" })).toBe("template");
  });

  it("templateId wins over forkId — every gallery clone writes BOTH", () => {
    expect(agentSource({ templateId: "web-research-digest", forkId: "fork-1" })).toBe(
      "template",
    );
  });

  it("a named starterId → starter", () => {
    expect(agentSource({ starterId: "coding-pause" })).toBe("starter");
  });

  it("starterId 'default' is the bare-scaffold marker → scratch", () => {
    expect(agentSource({ starterId: "default" })).toBe("scratch");
  });

  it("forkId alone (a re-clone of an existing fork) → fork", () => {
    expect(agentSource({ forkId: "fork-1" })).toBe("fork");
  });

  it("check order: a default starterId does not shadow a forkId", () => {
    expect(agentSource({ starterId: "default", forkId: "fork-1" })).toBe("fork");
  });

  it("no provenance at all → scratch (pre-provenance agents, older servers)", () => {
    expect(agentSource({})).toBe("scratch");
    // The registry's normal form: fields present but null.
    expect(agentSource({ templateId: null, forkId: null, starterId: null })).toBe(
      "scratch",
    );
  });

  it("non-string junk in the user-editable marker does not count", () => {
    expect(agentSource({ templateId: "" })).toBe("scratch");
  });
});

describe("agentProvenance", () => {
  it("returns {} when the registry entry was not found — omit, don't claim scratch", () => {
    expect(agentProvenance(undefined)).toEqual({});
    expect(agentProvenance(null)).toEqual({});
  });

  it("template carries template_id = templateId", () => {
    expect(
      agentProvenance({ templateId: "web-research-digest", forkId: "fork-1" }),
    ).toEqual({ source: "template", template_id: "web-research-digest" });
  });

  it("starter carries template_id = starterId", () => {
    expect(agentProvenance({ starterId: "coding-pause" })).toEqual({
      source: "starter",
      template_id: "coding-pause",
    });
  });

  it("fork and scratch carry source only — a fork id is a per-user record id", () => {
    expect(agentProvenance({ forkId: "fork-1" })).toEqual({ source: "fork" });
    expect(agentProvenance({ starterId: "default" })).toEqual({ source: "scratch" });
  });
});

describe("deployErrorKind", () => {
  it("maps a thrown error to exception regardless of phase", () => {
    expect(deployErrorKind("building", true)).toBe("exception");
    expect(deployErrorKind(null, true)).toBe("exception");
  });

  it("maps a terminal error after linking to link_failed", () => {
    expect(deployErrorKind("linking", false)).toBe("link_failed");
  });

  it("maps a terminal error after building (or unknown) to build_failed", () => {
    expect(deployErrorKind("building", false)).toBe("build_failed");
    expect(deployErrorKind(null, false)).toBe("build_failed");
  });
});

describe("runErrorKind", () => {
  it("distinguishes a cancellation from a failure", () => {
    expect(runErrorKind("cancelled")).toBe("cancelled");
    expect(runErrorKind("failed")).toBe("failed");
  });

  it("collapses non-terminal / successful statuses to failed rather than inventing a bucket", () => {
    // Only unsuccessful terminal statuses should ever reach here; a call site
    // bug must surface as an implausible `failed`, not a new enum value.
    expect(runErrorKind("running")).toBe("failed");
    expect(runErrorKind("completed")).toBe("failed");
  });
});

describe("localRunOutcomeKind", () => {
  it("maps the two terminal outcomes", () => {
    expect(localRunOutcomeKind("completed")).toBe("succeeded");
    expect(localRunOutcomeKind("failed")).toBe("failed");
  });

  it("treats a paused or unfinished run as pending, NOT as a failure", () => {
    // A paused run is waiting on a signal and is still alive. Counting it as
    // failed would understate the success rate by every signal-using agent.
    expect(localRunOutcomeKind("paused")).toBe("pending");
    expect(localRunOutcomeKind("running")).toBe("pending");
    expect(localRunOutcomeKind(undefined)).toBe("pending");
  });
});

describe("runFunnelStep", () => {
  /** Drive a sequence of events, collecting every emitted event name. */
  function drive(events: RunFunnelEvent[], maxFailures = MAX_RUN_POLL_FAILURES): string[] {
    let state = initialRunFunnelState();
    const emitted: string[] = [];
    for (const event of events) {
      const step = runFunnelStep(state, event, maxFailures);
      state = step.state;
      if (step.emit.event !== null) {
        emitted.push(
          step.emit.event === "agent.run_failed"
            ? `agent.run_failed:${step.emit.error_kind}`
            : step.emit.event,
        );
      }
    }
    return emitted;
  }

  it("the happy path is one start and one success", () => {
    expect(
      drive([
        { kind: "announced", duplicate: false },
        { kind: "polled", status: "running" },
        { kind: "polled", status: "completed" },
      ]),
    ).toEqual(["agent.run_started", "agent.run_succeeded"]);
  });

  it("maps a terminal failure and a cancellation to their own kinds", () => {
    expect(drive([{ kind: "polled", status: "failed" }])).toEqual(["agent.run_failed:failed"]);
    expect(drive([{ kind: "polled", status: "cancelled" }])).toEqual(["agent.run_failed:cancelled"]);
  });

  // ---- the two bugs review round 1 found, pinned ------------------------

  it("a REDELIVERED announcement suppresses the start but NOT the terminal", () => {
    // The bug: seeding the outcome latch from the dedupe flag. A replayed
    // execution.started then yielded a start with no terminal, ever.
    expect(
      drive([
        { kind: "announced", duplicate: true },
        { kind: "polled", status: "completed" },
      ]),
    ).toEqual(["agent.run_succeeded"]);
  });

  it("never emits two starts for the same run", () => {
    expect(
      drive([
        { kind: "announced", duplicate: false },
        { kind: "announced", duplicate: false },
        { kind: "announced", duplicate: true },
      ]),
    ).toEqual(["agent.run_started"]);
  });

  it("emits at most ONE terminal even if two polls both see it", () => {
    // Two in-flight polls can both observe the terminal status before either
    // stops the timer.
    expect(
      drive([
        { kind: "polled", status: "completed" },
        { kind: "polled", status: "completed" },
        { kind: "polled", status: "failed" },
      ]),
    ).toEqual(["agent.run_succeeded"]);
  });

  it("stays silent until the failure threshold, then emits exactly once", () => {
    // The bug: giving up on the first error, which books a false failure for a
    // healthy run whenever /api/runs/:id/state answers 503 or 502.
    const beforeThreshold = Array.from({ length: MAX_RUN_POLL_FAILURES - 1 }, () => ({
      kind: "poll_failed" as const,
    }));
    expect(drive(beforeThreshold)).toEqual([]);
    expect(drive([...beforeThreshold, { kind: "poll_failed" }])).toEqual([
      "agent.run_failed:unobservable",
    ]);
    // …and not again on the next failure.
    expect(
      drive([...beforeThreshold, { kind: "poll_failed" }, { kind: "poll_failed" }]),
    ).toEqual(["agent.run_failed:unobservable"]);
  });

  it("a success RESETS the failure count", () => {
    // The subtlest of the three: without the reset, blips accumulate across an
    // otherwise healthy run and trip the threshold later, showing up only as
    // runs declared unobservable slightly too eagerly.
    const blips = Array.from({ length: MAX_RUN_POLL_FAILURES - 1 }, () => ({
      kind: "poll_failed" as const,
    }));
    expect(
      drive([
        ...blips,
        { kind: "polled", status: "running" },
        ...blips,
        { kind: "polled", status: "completed" },
      ]),
    ).toEqual(["agent.run_succeeded"]);
  });

  it("distinguishes losing a watched run from never seeing it", () => {
    const fail = Array.from({ length: MAX_RUN_POLL_FAILURES }, () => ({
      kind: "poll_failed" as const,
    }));
    // Never observed → the endpoint is probably absent.
    expect(drive(fail)).toEqual(["agent.run_failed:unobservable"]);
    // Observed once, then lost → a real exception.
    expect(drive([{ kind: "polled", status: "running" }, ...fail])).toEqual([
      "agent.run_failed:exception",
    ]);
  });

  it("does not emit a terminal after one already fired, however it failed", () => {
    const fail = Array.from({ length: MAX_RUN_POLL_FAILURES }, () => ({
      kind: "poll_failed" as const,
    }));
    expect(drive([{ kind: "polled", status: "completed" }, ...fail])).toEqual([
      "agent.run_succeeded",
    ]);
  });

  it("is pure — the input state is never mutated", () => {
    const state = initialRunFunnelState();
    runFunnelStep(state, { kind: "announced", duplicate: false });
    runFunnelStep(state, { kind: "poll_failed" });
    expect(state).toEqual({ started: false, settled: false, observed: false, failures: 0 });
  });
});
