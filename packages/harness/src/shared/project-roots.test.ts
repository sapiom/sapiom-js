import { describe, expect, it } from "vitest";

import {
  preferredProjectRoot,
  projectRoots,
  projectSessionRoot,
  projectToOpen,
  type ProjectRootSources,
} from "./project-roots.js";

function sources(
  overrides: Partial<ProjectRootSources> = {},
): ProjectRootSources {
  return {
    recentDirs: [],
    sessions: [],
    pendingCwds: [],
    agentPaths: [],
    sort: "recent",
    ...overrides,
  };
}

describe("shared project-root resolution", () => {
  it("chooses the canonical outermost multi-root binding deterministically", () => {
    expect(
      preferredProjectRoot([
        "/workspace/project/packages/zeta",
        "/workspace/project",
        "/workspace/project/packages/alpha",
      ]),
    ).toBe("/workspace/project");
    expect(
      preferredProjectRoot(["/workspace/project-b", "/workspace/project-a"]),
    ).toBe("/workspace/project-a");
  });

  it("maps a descendant project session to its nearest durable root", () => {
    expect(
      projectSessionRoot(
        { cwd: "/workspace/project/packages/app", projectId: "project-1" },
        [
          { projectId: "project-1", cwd: "/workspace/project" },
          { projectId: "project-1", cwd: "/workspace/project/packages" },
          { projectId: "project-2", cwd: "/workspace/project/packages/app" },
        ],
      ),
    ).toBe("/workspace/project/packages");
  });

  it("keeps an evicted durable root instead of promoting its session cwd", () => {
    const root = projectSessionRoot(
      { cwd: "/workspace/project/packages/app", projectId: "project-1" },
      [{ projectId: "project-1", cwd: "/workspace/project" }],
    );

    expect(
      projectRoots(
        sources({
          sessions: [
            {
              cwd: root!,
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "running",
            },
          ],
          pinnedRoots: ["/workspace/project"],
          agentPaths: ["/workspace/project/packages/app/agent"],
        }),
      ),
    ).toEqual(["/workspace/project"]);
  });

  it("deduplicates equivalent separator forms and keeps the first trusted spelling", () => {
    const pending = "C:\\work\\property-ops\\";

    expect(
      projectRoots(
        sources({
          pendingCwds: [pending],
          recentDirs: ["C:/work/property-ops"],
          sessions: [
            {
              cwd: "C:\\work\\property-ops",
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "running",
            },
          ],
        }),
      ),
    ).toEqual([pending]);
  });

  it("uses a lexical path tie-break when session recency is identical", () => {
    expect(
      projectRoots(
        sources({
          sessions: [
            {
              cwd: "/workspace/zeta",
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "exited",
            },
            {
              cwd: "/workspace/alpha",
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "exited",
            },
          ],
          agentPaths: [
            "/workspace/zeta/zeta-agent",
            "/workspace/alpha/alpha-agent",
          ],
        }),
      ),
    ).toEqual(["/workspace/alpha", "/workspace/zeta"]);
  });

  it("recognizes an agent root across separator forms before promoting it", () => {
    expect(
      projectToOpen(
        "C:/work/property-ops/tenant-screening",
        sources({
          recentDirs: ["C:\\work\\property-ops\\tenant-screening"],
          agentPaths: ["C:\\work\\property-ops\\tenant-screening"],
        }),
      ),
    ).toBe("C:/work/property-ops");
  });

  it("preserves a durable project root when later discovery marks it as an agent", () => {
    expect(
      projectRoots(
        sources({
          recentDirs: ["/workspace/property-ops"],
          pinnedRoots: ["/workspace/property-ops"],
          agentPaths: ["/workspace/property-ops"],
        }),
      ),
    ).toEqual(["/workspace/property-ops"]);
  });

  it("does not resurrect a durable nested root from an exited session alone", () => {
    expect(
      projectRoots(
        sources({
          recentDirs: ["/workspace"],
          pinnedRoots: ["/workspace/removed-project"],
          sessions: [
            {
              cwd: "/workspace/removed-project",
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "exited",
            },
          ],
          agentPaths: ["/workspace/removed-project/agent"],
        }),
      ),
    ).toEqual(["/workspace"]);
  });
});
