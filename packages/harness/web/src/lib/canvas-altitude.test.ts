import { describe, expect, it } from "vitest";

import type { WorkspaceScopeSummary } from "@shared/system-graph";

import {
  canvasView,
  studioCanvasView,
  projectRefForRoot,
  stepsDisabledReason,
} from "./canvas-altitude";

describe("studioCanvasView", () => {
  it("uses durable project and agent ids without a root or WorkspaceKey", () => {
    expect(
      studioCanvasView({ kind: "agent-map", projectId: "project-a" }),
    ).toEqual({
      altitude: "map",
      projectId: "project-a",
    });
    expect(
      studioCanvasView({
        kind: "agent",
        projectId: "project-a",
        agentId: "agent-a",
      }),
    ).toEqual({
      altitude: "board",
      projectId: "project-a",
      agentId: "agent-a",
    });
  });
});

/**
 * E3.7–E3.9: one selection, two altitudes, always agreeing.
 *
 * The browser spec covers what a click does; these pin the rules themselves,
 * because "the rail and the canvas disagree about what you are looking at" is a
 * bug you can only see by measuring, and by then it has shipped.
 */
const HOME = "/Users/demo";
const POLSIA = `${HOME}/polsia`;
const ADS = `${POLSIA}/backend/src/agents/ads`;

const scopes: WorkspaceScopeSummary[] = [
  { workspaceKey: "ws-polsia", cwd: POLSIA },
];

const polsia = { workspaceKey: "ws-polsia", root: POLSIA, label: "polsia" };

describe("canvasView: the project wins, and that is stated once", () => {
  it("is map altitude for a selected project", () => {
    expect(canvasView(polsia, null)).toEqual({
      altitude: "map",
      project: polsia,
    });
  });

  it("is board altitude for a selected agent", () => {
    expect(canvasView(null, ADS)).toEqual({
      altitude: "board",
      agentPath: ADS,
    });
  });

  it("still resolves to ONE altitude when a door forgets to clear the other half", () => {
    // The two are mutually exclusive by construction. This is the case where
    // that construction has a hole: the answer must be a project's map, never
    // an agent's board drawn under a project's name.
    expect(canvasView(polsia, ADS)).toEqual({
      altitude: "map",
      project: polsia,
    });
  });

  it("is board altitude with nothing selected at all", () => {
    expect(canvasView(null, null)).toEqual({
      altitude: "board",
      agentPath: null,
    });
  });
});

describe("projectRefForRoot: the browser joins, it never invents a key", () => {
  it("joins an exact root to the key the server issued", () => {
    expect(projectRefForRoot(POLSIA, "polsia", scopes)).toEqual(polsia);
  });

  it("matches on segment boundaries, so a trailing separator still joins", () => {
    expect(
      projectRefForRoot(`${POLSIA}/`, "polsia", scopes)?.workspaceKey,
    ).toBe("ws-polsia");
  });

  it("never joins a neighbouring project by string prefix", () => {
    // `~/polsia-old` is not inside `~/polsia`, and a bare prefix compare would
    // hand it the wrong project's graph.
    expect(projectRefForRoot(`${POLSIA}-old`, "polsia-old", scopes)).toBeNull();
  });

  it("names itself from the root when the caller has no label", () => {
    expect(projectRefForRoot(POLSIA, null, scopes)?.label).toBe("polsia");
  });

  it("is null with no root and null for a root the server issued no key for", () => {
    expect(projectRefForRoot(null, null, scopes)).toBeNull();
    expect(projectRefForRoot(`${HOME}/scratch`, null, scopes)).toBeNull();
  });
});

describe("stepsDisabledReason: a disabled tab says why", () => {
  it("gives the sentence at map altitude, not a bare boolean", () => {
    // A tab that silently shows the last agent's steps under a project's name
    // is the failure; a disabled control with no reason is merely mute.
    expect(stepsDisabledReason("map")).toBe(
      "Steps belong to one agent — select an agent to see them",
    );
  });

  it("is null at board altitude", () => {
    expect(stepsDisabledReason("board")).toBeNull();
  });
});
