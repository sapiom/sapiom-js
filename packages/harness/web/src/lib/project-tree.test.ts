/**
 * Behavioural spec for the Project axis.
 *
 * `workspace-tree.ts` shipped with no test file, which is how the rail
 * accumulated 40 rows for 75 agents without anything failing. Every rule the
 * design states carries the failure it prevents; each is pinned here.
 *
 * Cases ported from the reference prototype's `project-tree.test.ts` keep its
 * wording where the behaviour is identical, so a future diff between the two
 * reads as a diff and not a rewrite.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import {
  abbreviate,
  buildProjectTree,
  projectInitial,
  projectIsEmpty,
  projectRoots,
  unrootedAgents,
} from "./project-tree";

const agent = (path: string, name = path.split("/").pop() ?? path): WorkflowInfo => ({
  name,
  path,
  definitionId: null,
  definitionSlug: name,
  source: "scan",
});

const ROOT = "/Users/dev/polsia";

describe("buildProjectTree", () => {
  it("compacts unbranched runs and keeps the branch point", () => {
    const workflows = [
      agent(`${ROOT}/backend/src/agents/ads`),
      agent(`${ROOT}/backend/src/agents/outreach`),
      agent(`${ROOT}/scripts/tools/rollup`),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");

    expect(project.label).toBe("polsia");
    // The branch point earns a directory row; the run above it is one label.
    expect(project.dirs.map((d) => d.labelFull)).toEqual(["backend/src/agents"]);
    expect(project.dirs[0].agents.map((a) => a.workflow.name)).toEqual(["ads", "outreach"]);
    // The unbranched run to a lone agent collapses ONTO the agent row.
    expect(project.agents.map((a) => a.workflow.name)).toEqual(["rollup"]);
    expect(project.agents[0].prefixFull).toBe("scripts/tools");
    expect(project.agents[0].prefix).toBe("tools");
  });

  it("gives a compacted directory row the absolute path of its DEEPEST segment", () => {
    // The collapse key and the row's title are that path, so a nested project
    // opened at the same directory can be told apart from it.
    const workflows = [
      agent(`${ROOT}/backend/src/agents/ads`),
      agent(`${ROOT}/backend/src/agents/outreach`),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.dirs[0].path).toBe(`${ROOT}/backend/src/agents`);
  });

  it("names an agent row for the agent, never for its path", () => {
    const [project] = buildProjectTree([agent(`${ROOT}/a/b/c/mailer`, "mailer")], [ROOT], "name");
    expect(project.agents[0].workflow.name).toBe("mailer");
    expect(project.agents[0].prefixFull).toBe("a/b/c");
    // The ROW shows only the immediate parent; the chain lives in the title.
    expect(project.agents[0].prefix).toBe("c");
  });

  it("never abbreviates an agent row's prefix, however long the chain", () => {
    const [project] = buildProjectTree(
      [agent(`${ROOT}/packages/harness/web/src/components/mailer`, "mailer")],
      [ROOT],
      "name",
    );
    expect(project.agents[0].prefixFull).toBe("packages/harness/web/src/components");
    /* An agent row's prefix is never abbreviated because it is never more than
       one segment — abbreviating it produced a double ellipsis beside a
       truncated agent name. `abbreviate` still governs DIRECTORY labels, which
       own their whole row. */
    expect(project.agents[0].prefix).toBe("components");
    expect(project.agents[0].prefix).not.toContain("…");
  });

  it("elides a long directory label but keeps the full chain for the tooltip", () => {
    const workflows = [
      agent(`${ROOT}/packages/harness/web/src/components/mailer`, "mailer"),
      agent(`${ROOT}/packages/harness/web/src/components/sender`, "sender"),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.dirs[0].labelFull).toBe("packages/harness/web/src/components");
    expect(project.dirs[0].label).toBe("packages/…/components");
  });

  it("keeps a SHORT deep directory label whole — elision is earned", () => {
    // 3 segments but only 18 characters: over MAX_SEGMENTS, under the width
    // that makes eliding worth the context it costs.
    const workflows = [
      agent(`${ROOT}/backend/src/agents/ads`),
      agent(`${ROOT}/backend/src/agents/outreach`),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.dirs[0].label).toBe("backend/src/agents");
  });

  it("keeps an agent AND a subdirectory in the same container", () => {
    // The mixed container: `services` holds the gateway agent and the workers
    // directory. Nothing merges, because `services` branches.
    const workflows = [
      agent(`${ROOT}/services/gateway`),
      agent(`${ROOT}/services/workers/queue`),
      agent(`${ROOT}/services/workers/ads`, "ads-worker"),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    const services = project.dirs.find((d) => d.labelFull === "services");
    expect(services).toBeDefined();
    expect(services!.agents.map((a) => a.workflow.name)).toEqual(["gateway"]);
    expect(services!.dirs.map((d) => d.labelFull)).toEqual(["workers"]);
    expect(services!.dirs[0].agents.map((a) => a.workflow.name)).toEqual(["ads-worker", "queue"]);
  });

  it("names a project opened inside another by its path from the parent", () => {
    const nested = `${ROOT}/agents`;
    const [outer, inner] = buildProjectTree([agent(`${nested}/ads`)], [ROOT, nested], "name");
    expect(outer.label).toBe("polsia");
    // Not a bare "agents", which would collide with the plain subdirectory row
    // of that name inside the outer project.
    expect(inner.label).toBe("polsia/agents");
  });

  it("labels a deeply nested project by its whole path from the parent", () => {
    const nested = `${ROOT}/services/workers`;
    const [, inner] = buildProjectTree([agent(`${nested}/queue`)], [ROOT, nested], "name");
    expect(inner.label).toBe("polsia/services/workers");
  });

  it("grows a colliding label leftward until it is unique", () => {
    const a = "/Users/dev/one/agents";
    const b = "/Users/dev/two/agents";
    const [first, second] = buildProjectTree([], [a, b], "name");
    expect(first.label).toBe("one/agents");
    expect(second.label).toBe("two/agents");
  });

  it("files an agent under EVERY root that contains it, not just the deepest", () => {
    const nested = `${ROOT}/backend/src/agents`;
    const workflows = [agent(`${nested}/ads`)];
    const [outer, inner] = buildProjectTree(workflows, [ROOT, nested], "name");

    // Nothing branches under the outer root, so the whole chain compacts onto
    // the agent's own row rather than spending three rows to reach one agent.
    expect(outer.dirs).toEqual([]);
    expect(outer.agents.map((a) => a.workflow.name)).toEqual(["ads"]);
    expect(outer.agents[0].prefixFull).toBe("backend/src/agents");
    expect(outer.agents[0].prefix).toBe("agents");
    // The same agent, reached as its own project — a separate context on
    // purpose, and here it sits at the root with no prefix at all.
    expect(inner.agents.map((a) => a.workflow.name)).toEqual(["ads"]);
    expect(inner.agents[0].prefixFull).toBe("");
  });

  it("hands a root that is itself an agent to rootAgent, NOT to agents", () => {
    // The stutter guard: the project row and this agent are the same
    // directory, so it must never also earn a row of its own.
    const [project] = buildProjectTree([agent(ROOT, "polsia")], [ROOT], "name");
    expect(project.rootAgent?.workflow.name).toBe("polsia");
    expect(project.agents).toEqual([]);
    expect(project.dirs).toEqual([]);
    // …and it is NOT empty, however empty `dirs` and `agents` look.
    expect(projectIsEmpty(project)).toBe(false);
  });

  it("keeps rootAgent separate from agents nested below it", () => {
    const workflows = [agent(ROOT, "polsia"), agent(`${ROOT}/agents/ads`)];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.rootAgent?.workflow.name).toBe("polsia");
    expect(project.agents.map((a) => a.workflow.name)).toEqual(["ads"]);
    expect(project.agents[0].prefixFull).toBe("agents");
  });

  it("has no rootAgent when the root holds no sapiom.json of its own", () => {
    const [project] = buildProjectTree([agent(`${ROOT}/agents/ads`)], [ROOT], "name");
    expect(project.rootAgent).toBeNull();
  });

  it("keeps a nested agent project's own row alongside the agents beneath it", () => {
    // `pipeline` is an agent AND holds agents, so it earns a directory row
    // that carries its own agent row — never a header plus a stutter child.
    const workflows = [
      agent(`${ROOT}/pipeline`, "pipeline"),
      agent(`${ROOT}/pipeline/ingest`, "ingest"),
      agent(`${ROOT}/pipeline/emit`, "emit"),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.dirs.map((d) => d.labelFull)).toEqual(["pipeline"]);
    expect(project.dirs[0].agents.map((a) => a.workflow.name)).toEqual([
      "emit",
      "ingest",
      "pipeline",
    ]);
    expect(project.agents).toEqual([]);
  });

  it("keeps two agents in the same directory under that directory", () => {
    const workflows = [agent(`${ROOT}/agents/ads`), agent(`${ROOT}/agents/outreach`)];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.dirs.map((d) => d.labelFull)).toEqual(["agents"]);
    expect(project.dirs[0].agents).toHaveLength(2);
    expect(project.agents).toEqual([]);
  });

  it("ignores agents outside the root", () => {
    const [project] = buildProjectTree([agent("/elsewhere/ads")], [ROOT], "name");
    expect(project.dirs).toEqual([]);
    expect(project.agents).toEqual([]);
    expect(projectIsEmpty(project)).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as being inside the root", () => {
    // `/Users/dev/polsia-2` is not under `/Users/dev/polsia`.
    const [project] = buildProjectTree([agent("/Users/dev/polsia-2/ads")], [ROOT], "name");
    expect(projectIsEmpty(project)).toBe(true);
  });

  it("tolerates a trailing separator on the root", () => {
    const [project] = buildProjectTree([agent(`${ROOT}/agents/ads`)], [`${ROOT}/`], "name");
    expect(project.agents.map((a) => a.workflow.name)).toEqual(["ads"]);
    expect(project.agents[0].prefixFull).toBe("agents");
  });

  it("matches a mixed-separator Windows path against its native root", () => {
    const winRoot = "C:\\Users\\demo\\app";
    const [project] = buildProjectTree(
      [agent("C:\\Users\\demo\\app/agents/leasing", "leasing")],
      [winRoot],
      "name",
    );
    expect(project.agents.map((a) => a.workflow.name)).toEqual(["leasing"]);
    expect(project.agents[0].prefixFull).toBe("agents");
  });

  it("builds directory paths in the root's native separator", () => {
    const winRoot = "C:\\Users\\demo\\app";
    const [project] = buildProjectTree(
      [agent("C:\\Users\\demo\\app\\agents\\ads", "ads"), agent("C:\\Users\\demo\\app\\agents\\out", "out")],
      [winRoot],
      "name",
    );
    expect(project.dirs[0].path).toBe("C:\\Users\\demo\\app\\agents");
  });

  it("orders agents before directories is the RENDERER's job, but both lists are sorted", () => {
    const workflows = [
      agent(`${ROOT}/zeta`),
      agent(`${ROOT}/alpha`),
      agent(`${ROOT}/beta/one`),
      agent(`${ROOT}/beta/two`),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.agents.map((a) => a.workflow.name)).toEqual(["alpha", "zeta"]);
    expect(project.dirs.map((d) => d.labelFull)).toEqual(["beta"]);
  });

  it("sorts agent rows by path under 'recent' — WorkflowInfo carries no timestamp", () => {
    const workflows = [agent(`${ROOT}/b-dir/zeta`, "zeta"), agent(`${ROOT}/a-dir/alpha`, "alpha")];
    const byRecent = buildProjectTree(workflows, [ROOT], "recent")[0];
    expect(byRecent.agents.map((a) => a.workflow.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("projectIsEmpty", () => {
  it("is false for a project holding only a rootAgent", () => {
    const [project] = buildProjectTree([agent(ROOT, "polsia")], [ROOT], "name");
    expect(projectIsEmpty(project)).toBe(false);
  });

  it("is true only when nothing at all files under the root", () => {
    const [project] = buildProjectTree([], [ROOT], "name");
    expect(projectIsEmpty(project)).toBe(true);
  });
});

describe("unrootedAgents", () => {
  it("keeps an agent no open root contains", () => {
    const stray = agent("/elsewhere/ads");
    expect(unrootedAgents([stray], [ROOT], "name").map((a) => a.workflow.name)).toEqual(["ads"]);
  });

  it("drops an agent any root contains, however deep", () => {
    expect(unrootedAgents([agent(`${ROOT}/a/b/c/ads`)], [ROOT], "name")).toEqual([]);
  });

  it("gives an unrooted agent no prefix — there is no chain to compact", () => {
    expect(unrootedAgents([agent("/elsewhere/a/b/ads")], [ROOT], "name")[0].prefix).toBe("");
  });
});

describe("projectRoots", () => {
  const at = (cwd: string, createdAt: string): { cwd: string; createdAt: string } => ({
    cwd,
    createdAt,
  });

  it("takes every recentDirs entry AND every session cwd — there is no migration", () => {
    const roots = projectRoots({
      recentDirs: ["/a/one"],
      sessions: [at("/a/two", "2026-01-01T00:00:00.000Z")],
      pendingCwds: [],
      sort: "recent",
    });
    expect(roots).toEqual(["/a/one", "/a/two"]);
  });

  it("keeps recentDirs order under 'recent' (it is the MRU list)", () => {
    const roots = projectRoots({
      recentDirs: ["/a/three", "/a/one", "/a/two"],
      sessions: [],
      pendingCwds: [],
      sort: "recent",
    });
    expect(roots).toEqual(["/a/three", "/a/one", "/a/two"]);
  });

  it("falls back to newest session activity for folders recentDirs has not recorded", () => {
    const roots = projectRoots({
      recentDirs: [],
      sessions: [at("/a/old", "2026-01-01T00:00:00.000Z"), at("/a/new", "2026-02-01T00:00:00.000Z")],
      pendingCwds: [],
      sort: "recent",
    });
    expect(roots).toEqual(["/a/new", "/a/old"]);
  });

  it("ranks a recentDirs entry above one only session activity knows", () => {
    const roots = projectRoots({
      recentDirs: ["/a/known"],
      sessions: [at("/a/seen", "2099-01-01T00:00:00.000Z")],
      pendingCwds: [],
      sort: "recent",
    });
    expect(roots).toEqual(["/a/known", "/a/seen"]);
  });

  it("sorts A–Z by basename under 'name'", () => {
    const roots = projectRoots({
      recentDirs: ["/z/beta", "/a/alpha"],
      sessions: [],
      pendingCwds: [],
      sort: "name",
    });
    expect(roots).toEqual(["/a/alpha", "/z/beta"]);
  });

  it("floats a folder mid-creation above every real project, on either sort", () => {
    for (const sort of ["recent", "name"] as const) {
      const roots = projectRoots({
        recentDirs: ["/a/aaa"],
        sessions: [],
        pendingCwds: ["/z/zzz"],
        sort,
      });
      expect(roots[0]).toBe("/z/zzz");
    }
  });

  it("keeps several pending folders in creation order, newest first", () => {
    const roots = projectRoots({
      recentDirs: [],
      sessions: [],
      pendingCwds: ["/a/second", "/a/first"],
      sort: "name",
    });
    expect(roots).toEqual(["/a/second", "/a/first"]);
  });

  it("does not render one folder twice because two sources spell it differently", () => {
    const roots = projectRoots({
      recentDirs: ["/a/one"],
      sessions: [at("/a/one/", "2026-01-01T00:00:00.000Z")],
      pendingCwds: [],
      sort: "recent",
    });
    expect(roots).toEqual(["/a/one"]);
  });

  it("keeps a nested root alongside its parent — two roots are two contexts", () => {
    const roots = projectRoots({
      recentDirs: ["/a/one", "/a/one/services/workers"],
      sessions: [],
      pendingCwds: [],
      sort: "recent",
    });
    expect(roots).toEqual(["/a/one", "/a/one/services/workers"]);
  });
});

describe("abbreviate", () => {
  it("keeps two segments whole", () => {
    expect(abbreviate(["backend", "agents"])).toBe("backend/agents");
  });

  it("keeps a short chain whole even beyond two segments", () => {
    expect(abbreviate(["a", "b", "c"])).toBe("a/b/c");
  });

  it("keeps a 3-segment, 18-character chain whole", () => {
    expect(abbreviate(["backend", "src", "agents"])).toBe("backend/src/agents");
  });

  it("elides the middle of a long chain", () => {
    expect(abbreviate(["packages", "harness", "web", "src", "components"])).toBe(
      "packages/…/components",
    );
  });

  it("keeps two segments whole even when they are wide", () => {
    // Both conditions must hold, so a 2-segment label never elides.
    expect(abbreviate(["averyverylongdirectoryname", "anotherlongdirectory"])).toBe(
      "averyverylongdirectoryname/anotherlongdirectory",
    );
  });

  it("is empty for no segments", () => {
    expect(abbreviate([])).toBe("");
  });
});

describe("projectInitial", () => {
  it("is the folder name's first alphanumeric, upper-cased", () => {
    expect(projectInitial("/Users/dev/polsia")).toBe("P");
    expect(projectInitial("/Users/dev/.hidden-thing")).toBe("H");
    expect(projectInitial("/Users/dev/2fa-agent")).toBe("2");
  });

  it("falls back to a neutral mark rather than rendering nothing", () => {
    expect(projectInitial("/Users/dev/___")).toBe("•");
  });

  it("reads through a trailing separator", () => {
    expect(projectInitial("/Users/dev/polsia/")).toBe("P");
  });
});
