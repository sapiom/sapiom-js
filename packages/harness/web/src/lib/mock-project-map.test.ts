import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import { mockProjectMap } from "./mock-project-map";

const ACME = "/Users/demo/acme-app";
const workflow = (path: string, definitionSlug?: string, definitionId?: string): WorkflowInfo =>
  ({ path, name: path, definitionSlug, definitionId }) as unknown as WorkflowInfo;
const acme = (ref: string | null = null, query = "") =>
  mockProjectMap({
    projectId: "p1",
    displayName: "acme-app",
    root: ACME,
    workflows: [workflow(`${ACME}/leasing`, "leasing", "def-1")],
    ref,
    params: new URLSearchParams(query),
  });
const populated = (response: ReturnType<typeof acme>) => {
  if (response === "empty") throw new Error("expected a map");
  return response;
};

describe("mockProjectMap", () => {
  it("gives acme-app one system of leasing, screening and the notifier", () => {
    const { map, projectId, displayName } = populated(acme());
    expect(projectId).toBe("p1");
    expect(displayName).toBe("acme-app");
    expect(map.root).toBe(ACME);
    expect(map.systems).toHaveLength(1);
    expect([...map.systems[0]!.agents].sort()).toEqual([
      "applicant-notifier",
      "leasing",
      "screening",
    ]);
    expect(map.agents.map(({ slug }) => slug)).toEqual([
      "applicant-notifier",
      "leasing",
      "rent-reminder",
      "screening",
    ]);
    expect(map.edges.map(({ from, to, kind }) => `${from}>${to}:${kind}`)).toEqual([
      "leasing>screening:launch",
      "screening>applicant-notifier:event",
    ]);
  });

  it("leaves rent-reminder loose and shares the vault key between leasing and screening", () => {
    const { map } = populated(acme());
    const members = new Set(map.systems.flatMap((s) => s.agents));
    expect(members.has("rent-reminder")).toBe(false);
    const by = Object.fromEntries(map.agents.map((a) => [a.slug, a]));
    expect(by["leasing"]!.shared).toEqual(["vault:APPLICANT_DB_URL"]);
    expect(by["screening"]!.shared).toEqual(["vault:APPLICANT_DB_URL"]);
    expect(by["leasing"]!.deployed).toBe(true);
  });

  it("reports git branches for acme-app", () => {
    expect(populated(acme()).git).toEqual({
      branch: "main",
      branches: ["feature/screening", "main"],
    });
  });

  it("marks screening changed at Working copy (against HEAD) and at a ref", () => {
    const working = populated(acme());
    expect(working.map.ref).toBeUndefined();
    expect(working.map.agents.filter((a) => a.changedSinceRef).map((a) => a.slug)).toEqual([
      "screening",
    ]);
    const onRef = populated(acme("main"));
    expect(onRef.map.ref).toBe("main");
    expect(onRef.map.agents.filter((a) => a.changedSinceRef).map((a) => a.slug)).toEqual([
      "screening",
    ]);
  });

  it("draws any other project's agents loose and outside git", () => {
    const response = populated(
      mockProjectMap({
        projectId: "p2",
        displayName: "other",
        root: "/Users/demo/other",
        workflows: [
          workflow("/Users/demo/other/one", "one"),
          workflow("/Users/demo/other/two"),
          workflow("/Users/demo/elsewhere/three", "three"),
        ],
        ref: "main",
        params: null,
      }),
    );
    expect(response.git).toBeNull();
    expect(response.map.systems).toEqual([]);
    expect(response.map.edges).toEqual([]);
    expect(response.map.ref).toBeUndefined();
    expect(response.map.agents.map((a) => [a.slug, a.path])).toEqual([
      ["one", "one"],
      ["two", "two"],
    ]);
  });

  it("returns 'empty' for mockProjectMap=empty", () => {
    expect(acme(null, "mockProjectMap=empty")).toBe("empty");
  });

  it("drops the deploy state for mockProjectMapDeployed=0", () => {
    const { map } = populated(acme(null, "mockProjectMapDeployed=0"));
    expect(map.agents.length).toBeGreaterThan(0);
    expect(map.agents.every((a) => a.deployed === null)).toBe(true);
    expect(populated(acme()).map.agents.some((a) => a.deployed !== null)).toBe(true);
  });
});
