import { describe, expect, it } from "vitest";

import { buildMap, systemId } from "./build.js";
import type { DescribedAgent, MapDescription } from "./types.js";

const at = (file: string, line: number, step?: string) => ({ file, line, text: "call()", ...(step ? { step } : {}) });

function describe_(agents: DescribedAgent[], extra: Partial<MapDescription> = {}): MapDescription {
  return { root: "/project", agents, ...extra };
}

describe("buildMap", () => {
  it("groups agents joined by calls, events and timers into systems and leaves the rest loose", () => {
    const map = buildMap(
      describe_([
        { slug: "intake", emits: [{ eventType: "issue.created", evidence: [at("intake/index.ts", 4, "route")] }] },
        { slug: "copilot", triggers: [{ kind: "event", eventType: "issue.created", source: "code" }] },
        { slug: "controller" },
        { slug: "escalation", calls: [{ to: "controller", kind: "timer", evidence: [at("_shared/timers.ts", 9)] }] },
        { slug: "digest", triggers: [{ kind: "schedule", cron: "0 9 * * *", source: "platform" }] },
      ]),
    );

    expect(map.systems.map((system) => system.agents)).toEqual([["controller", "escalation"], ["copilot", "intake"]]);
    expect(map.edges).toEqual([
      { from: "escalation", to: "controller", kind: "timer", evidence: [at("_shared/timers.ts", 9)] },
      {
        from: "intake",
        to: "copilot",
        kind: "event",
        eventType: "issue.created",
        evidence: [at("intake/index.ts", 4, "route")],
        fromStep: "route",
      },
    ]);
    expect(map.labels).toBe("unavailable");
  });

  it("never joins agents through a shared resource; shared resources become chips on both", () => {
    const map = buildMap(
      describe_([
        { slug: "payout", resources: ["db:office", "vault:KEY"] },
        { slug: "giftcards", resources: ["db:office", "vault:OTHER"] },
      ]),
    );

    expect(map.systems).toEqual([]);
    expect(map.agents.map((agent) => [agent.slug, agent.shared])).toEqual([
      ["giftcards", ["db:office"]],
      ["payout", ["db:office"]],
    ]);
  });

  it("reports a call to an agent that is not in the map instead of drawing it", () => {
    const map = buildMap(
      describe_([{ slug: "propose", calls: [{ to: "gone", kind: "launch", evidence: [at("propose/index.ts", 3)] }] }]),
    );

    expect(map.edges).toEqual([]);
    expect(map.unresolved).toEqual([
      { from: "propose", kind: "launch", reason: "unknown-target", to: "gone", evidence: [at("propose/index.ts", 3)] },
    ]);
  });

  it("gives the same JSON whatever order the description lists things in", () => {
    const agents: DescribedAgent[] = [
      { slug: "a", calls: [{ to: "b", kind: "launch", evidence: [at("a.ts", 2), at("a.ts", 1)] }], resources: ["x", "y"] },
      { slug: "b", calls: [{ to: "c", kind: "launch", evidence: [at("b.ts", 1)] }], resources: ["y"] },
      { slug: "c", resources: ["x"] },
      { slug: "d" },
    ];
    const reversed = [...agents].reverse().map((agent) => ({
      ...agent,
      resources: agent.resources ? [...agent.resources].reverse() : undefined,
      calls: agent.calls?.map((call) => ({ ...call, evidence: [...(call.evidence ?? [])].reverse() })),
    }));

    expect(JSON.stringify(buildMap(describe_(reversed)))).toBe(JSON.stringify(buildMap(describe_(agents))));
  });

  it("names a system from .sapiom/map.json, else after its most-connected agent", () => {
    const agents: DescribedAgent[] = [
      { slug: "hub", calls: [{ to: "one", kind: "launch" }, { to: "two", kind: "launch" }] },
      { slug: "one" },
      { slug: "two" },
    ];

    const fallback = buildMap(describe_(agents)).systems[0]!;
    expect(fallback).toEqual({ id: systemId(["hub", "one", "two"]), name: "hub", nameSource: "default", agents: ["hub", "one", "two"] });

    const named = buildMap(describe_(agents, { names: [{ agent: "two", name: "Fan-out" }] })).systems[0]!;
    expect(named.name).toBe("Fan-out");
    expect(named.nameSource).toBe("file");
    expect(named.id).toBe(fallback.id);
  });

  it("keeps an edge's fromStep only when every call site is in the same step", () => {
    const map = buildMap(
      describe_([
        { slug: "a", calls: [{ to: "b", kind: "launch", evidence: [at("a.ts", 1, "start"), at("a.ts", 9, "retry")] }] },
        { slug: "b" },
      ]),
    );

    expect(map.edges[0]!.fromStep).toBeUndefined();
  });

  it("rejects two agents with one slug", () => {
    expect(() => buildMap(describe_([{ slug: "a" }, { slug: "a" }]))).toThrow(/Duplicate agent slug "a"/);
  });
});
