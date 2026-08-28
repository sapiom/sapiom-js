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
  growLeftward,
  projectInitial,
  projectIsEmpty,
  holdingProjectFor,
  projectRoots,
  projectToOpen,
  unrootedAgents,
} from "./project-tree";
import type { SessionStatus } from "@shared/types";
import type { RailSort } from "./project-tree";

const agent = (
  path: string,
  name = path.split("/").pop() ?? path,
): WorkflowInfo => ({
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
    expect(project.dirs.map((d) => d.labelFull)).toEqual([
      "backend/src/agents",
    ]);
    expect(project.dirs[0].agents.map((a) => a.workflow.name)).toEqual([
      "ads",
      "outreach",
    ]);
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
    const [project] = buildProjectTree(
      [agent(`${ROOT}/a/b/c/mailer`, "mailer")],
      [ROOT],
      "name",
    );
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
    expect(project.agents[0].prefixFull).toBe(
      "packages/harness/web/src/components",
    );
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
    expect(project.dirs[0].labelFull).toBe(
      "packages/harness/web/src/components",
    );
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
    expect(services!.dirs[0].agents.map((a) => a.workflow.name)).toEqual([
      "ads-worker",
      "queue",
    ]);
  });

  it("names a project opened inside another by its path from the parent", () => {
    const nested = `${ROOT}/agents`;
    const [outer, inner] = buildProjectTree(
      [agent(`${nested}/ads`)],
      [ROOT, nested],
      "name",
    );
    expect(outer.label).toBe("polsia");
    // Not a bare "agents", which would collide with the plain subdirectory row
    // of that name inside the outer project.
    expect(inner.label).toBe("polsia/agents");
  });

  it("labels a deeply nested project by its whole path from the parent", () => {
    const nested = `${ROOT}/services/workers`;
    const [, inner] = buildProjectTree(
      [agent(`${nested}/queue`)],
      [ROOT, nested],
      "name",
    );
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
    const [project] = buildProjectTree(
      [agent(`${ROOT}/agents/ads`)],
      [ROOT],
      "name",
    );
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
    const workflows = [
      agent(`${ROOT}/agents/ads`),
      agent(`${ROOT}/agents/outreach`),
    ];
    const [project] = buildProjectTree(workflows, [ROOT], "name");
    expect(project.dirs.map((d) => d.labelFull)).toEqual(["agents"]);
    expect(project.dirs[0].agents).toHaveLength(2);
    expect(project.agents).toEqual([]);
  });

  it("ignores agents outside the root", () => {
    const [project] = buildProjectTree(
      [agent("/elsewhere/ads")],
      [ROOT],
      "name",
    );
    expect(project.dirs).toEqual([]);
    expect(project.agents).toEqual([]);
    expect(projectIsEmpty(project)).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as being inside the root", () => {
    // `/Users/dev/polsia-2` is not under `/Users/dev/polsia`.
    const [project] = buildProjectTree(
      [agent("/Users/dev/polsia-2/ads")],
      [ROOT],
      "name",
    );
    expect(projectIsEmpty(project)).toBe(true);
  });

  it("tolerates a trailing separator on the root", () => {
    const [project] = buildProjectTree(
      [agent(`${ROOT}/agents/ads`)],
      [`${ROOT}/`],
      "name",
    );
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
      [
        agent("C:\\Users\\demo\\app\\agents\\ads", "ads"),
        agent("C:\\Users\\demo\\app\\agents\\out", "out"),
      ],
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
    expect(project.agents.map((a) => a.workflow.name)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(project.dirs.map((d) => d.labelFull)).toEqual(["beta"]);
  });

  it("sorts agent rows by path under 'recent' — WorkflowInfo carries no timestamp", () => {
    const workflows = [
      agent(`${ROOT}/b-dir/zeta`, "zeta"),
      agent(`${ROOT}/a-dir/alpha`, "alpha"),
    ];
    const byRecent = buildProjectTree(workflows, [ROOT], "recent")[0];
    expect(byRecent.agents.map((a) => a.workflow.name)).toEqual([
      "alpha",
      "zeta",
    ]);
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
    expect(
      unrootedAgents([stray], [ROOT], "name").map((a) => a.workflow.name),
    ).toEqual(["ads"]);
  });

  it("drops an agent any root contains, however deep", () => {
    expect(
      unrootedAgents([agent(`${ROOT}/a/b/c/ads`)], [ROOT], "name"),
    ).toEqual([]);
  });

  /* RE-POINTED IN ROUND 2. This used to assert `prefix === ""` — "there is no
     chain to compact". On a real install that produced an "Outside your
     projects" section of six rows all reading `ari-grade-repo`, with nothing
     on screen telling them apart. An unrooted agent has no project to give it
     context, which makes the parent directory MORE load-bearing here than in
     the tree, not less. */
  it("gives an unrooted agent its immediate parent as the prefix", () => {
    expect(
      unrootedAgents([agent("/elsewhere/a/b/ads")], [ROOT], "name")[0].prefix,
    ).toBe("b");
  });

  it("carries the ABSOLUTE parent directory as prefixFull — there is no root to be relative to", () => {
    expect(
      unrootedAgents([agent("/elsewhere/a/b/ads")], [ROOT], "name")[0]
        .prefixFull,
    ).toBe("/elsewhere/a/b");
  });

  /* THE REAL INSTALL'S SHAPE: six git worktrees, one agent name, one identical
     immediate parent. One segment cannot tell them apart, so the prefix grows
     leftward until it can — the same rule `projectLabeller` states for two
     roots that share a basename. */
  it("grows the prefix leftward until same-named rows differ", () => {
    const worktrees = [
      "design-eng",
      "design-eng-fix",
      "design-eng-ij",
      "design-eng-main",
      "worktrees/design-agent-port-pin",
      "worktrees/design-agent-terminology",
    ];
    const rows = unrootedAgents(
      worktrees.map((w) =>
        agent(`/Users/dev/${w}/ari/orchestration`, "ari-grade-repo"),
      ),
      [ROOT],
      "name",
    );
    expect(
      rows.map((row) => `${row.prefix}/${row.workflow.name}`).sort(),
    ).toEqual([
      "design-agent-port-pin/ari/ari-grade-repo",
      "design-agent-terminology/ari/ari-grade-repo",
      "design-eng-fix/ari/ari-grade-repo",
      "design-eng-ij/ari/ari-grade-repo",
      "design-eng-main/ari/ari-grade-repo",
      "design-eng/ari/ari-grade-repo",
    ]);
    expect(
      new Set(rows.map((row) => `${row.prefix}/${row.workflow.name}`)).size,
    ).toBe(6);
  });

  it("only the colliding rows pay: a uniquely-named neighbour keeps one segment", () => {
    const rows = unrootedAgents(
      [
        agent("/Users/dev/design-eng/ari/orchestration", "ari-grade-repo"),
        agent("/Users/dev/design-eng-fix/ari/orchestration", "ari-grade-repo"),
        agent("/Users/dev/misc/pkg1/agent", "filler-1"),
      ],
      [ROOT],
      "name",
    );
    expect(rows.find((row) => row.workflow.name === "filler-1")?.prefix).toBe(
      "pkg1",
    );
  });

  it("a name that collides only with itself at the SAME parent still differs by the grown chain", () => {
    // Two `slack-notifier` folders under different containers: one segment is
    // already enough, so the rule stops there.
    const rows = unrootedAgents(
      [
        agent(
          "/Users/dev/team-tools/slack-notifier",
          "@sapiom/example-slack-notifier",
        ),
        agent(
          "/Users/dev/other-tools/slack-notifier",
          "@sapiom/example-slack-notifier",
        ),
      ],
      [ROOT],
      "name",
    );
    expect(rows.map((row) => row.prefix).sort()).toEqual([
      "other-tools",
      "team-tools",
    ]);
  });
});

describe("growLeftward", () => {
  it("stops at the shortest trailing run nothing else shares", () => {
    expect(growLeftward(["a", "b", "c"], [["x", "y", "c"]])).toEqual([
      "b",
      "c",
    ]);
  });

  it("keeps one segment when nothing collides", () => {
    expect(growLeftward(["a", "b", "c"], [["x", "y", "z"]])).toEqual(["c"]);
  });

  it("honours a minimum, so a caller that already proved one segment collides skips it", () => {
    expect(growLeftward(["a", "b", "c"], [], 2)).toEqual(["b", "c"]);
  });

  it("returns the whole chain when it never becomes unique", () => {
    expect(growLeftward(["a", "b"], [["a", "b"]])).toEqual(["a", "b"]);
  });
});

/**
 * The one sentence this block exists to pin:
 *
 *     A PROJECT IS A DIRECTORY YOU CHOSE THAT HOLDS AGENTS.
 *
 * Each case names the row it stops the rail from drawing, because a test called
 * "filters correctly" is one nobody can audit on a later pass. Every clause here
 * is mutation-verified: stub it out and these fail.
 */
/**
 * ONE ANSWER, two callers. These are asserted on the helper directly rather than
 * only through `projectRoots`, because the second caller (`openProject`) is what
 * shipped a copy of this hop WITHOUT these guards: it would have opened a user's
 * home directory as a project, un-closed every removed project under it, and
 * scanned the whole tree.
 */
describe("holdingProjectFor", () => {
  const of = (
    dir: string,
    agentPaths: string[],
    projects: string[] = [],
  ): string | null => holdingProjectFor(dir, { agentPaths, projects });

  it("answers the folder that holds the agent", () => {
    expect(of("/w/loose/one", ["/w/loose/one"])).toBe("/w/loose");
  });

  it("walks past an agent nested inside another agent", () => {
    expect(of("/w/outer/inner", ["/w/outer", "/w/outer/inner"])).toBe("/w");
  });

  it("REFUSES a filesystem root: `parentOf('/solo')` is `/`, not null, so the naive hop opens the whole disk", () => {
    expect(of("/solo", ["/solo"])).toBeNull();
  });

  it("REFUSES a home directory that holds another project, which is opening HOME as a project", () => {
    expect(
      of(
        "/Users/demo/my-agent",
        ["/Users/demo/my-agent"],
        ["/Users/demo/acme-app"],
      ),
    ).toBeNull();
  });

  it("allows the hop when the parent holds no other project", () => {
    expect(
      of(
        "/Users/demo/proj/my-agent",
        ["/Users/demo/proj/my-agent"],
        ["/elsewhere"],
      ),
    ).toBe("/Users/demo/proj");
  });
});

/**
 * THE ARGUMENT, not the rule.
 *
 * Two review rounds found a bug in this hop and neither was in
 * `holdingProjectFor`: the first passed no guards, the second passed
 * `recentDirs` alone while the rail passes its derived roots. Both were the
 * question being narrower than the one the rail asks, and the answer is acted
 * on by `rememberProjectDir`, which takes an explicit choice at its word. So
 * these assert the CALLER's own function, which the previous five cases,
 * hand-building `projects`, could not have caught.
 */
describe("projectToOpen", () => {
  const open = (
    requested: string,
    over: {
      agentPaths?: string[];
      recentDirs?: string[];
      pendingCwds?: string[];
      sessionCwds?: string[];
    },
  ): string =>
    projectToOpen(requested, {
      agentPaths: over.agentPaths ?? [],
      recentDirs: over.recentDirs ?? [],
      pendingCwds: over.pendingCwds ?? [],
      sessionCwds: over.sessionCwds ?? [],
    });

  it("leaves an ordinary folder alone", () => {
    expect(
      open("/Users/demo/acme", { agentPaths: ["/Users/demo/acme/leasing"] }),
    ).toBe("/Users/demo/acme");
  });

  it("opens the folder that HOLDS an agent, rather than doing nothing", () => {
    expect(
      open("/Users/demo/proj/my-agent", {
        agentPaths: ["/Users/demo/proj/my-agent"],
      }),
    ).toBe("/Users/demo/proj");
  });

  it("counts a project the rail knows only from a SESSION CWD, which recentDirs alone would miss and which is how opening one agent could have opened HOME", () => {
    expect(
      open("/Users/demo/my-agent", {
        agentPaths: ["/Users/demo/my-agent"],
        recentDirs: [],
        sessionCwds: ["/Users/demo/acme-app"],
      }),
    ).toBe("/Users/demo/my-agent");
  });

  it("counts a folder mid-creation too", () => {
    expect(
      open("/Users/demo/my-agent", {
        agentPaths: ["/Users/demo/my-agent"],
        pendingCwds: ["/Users/demo/acme-app"],
      }),
    ).toBe("/Users/demo/my-agent");
  });

  it("refuses a filesystem root rather than opening the whole disk", () => {
    expect(open("/solo", { agentPaths: ["/solo"] })).toBe("/solo");
  });
});

describe("projectRoots", () => {
  const at = (
    cwd: string,
    createdAt: string,
    status: SessionStatus = "exited",
  ): { cwd: string; createdAt: string; status: SessionStatus } => ({
    cwd,
    createdAt,
    status,
  });
  const roots = (over: {
    recentDirs?: string[];
    sessions?: { cwd: string; createdAt: string; status?: SessionStatus }[];
    pendingCwds?: string[];
    agentPaths?: string[];
    sort?: RailSort;
  }): string[] =>
    projectRoots({
      recentDirs: over.recentDirs ?? [],
      sessions: over.sessions ?? [],
      pendingCwds: over.pendingCwds ?? [],
      agentPaths: over.agentPaths ?? [],
      sort: over.sort ?? "recent",
    });

  describe("a directory you CHOSE", () => {
    it("keeps a chosen folder that holds agents", () => {
      expect(
        roots({ recentDirs: ["/a/acme"], agentPaths: ["/a/acme/leasing"] }),
      ).toEqual(["/a/acme"]);
    });

    it("keeps a chosen folder with NO agents: opening an empty folder to build the first agent in it is the whole point of that row", () => {
      expect(roots({ recentDirs: ["/a/blank"] })).toEqual(["/a/blank"]);
    });

    it("keeps a folder mid-creation, which has no agent yet by definition", () => {
      expect(roots({ pendingCwds: ["/a/new"] })).toEqual(["/a/new"]);
    });

    it("drops a folder known only because a session ran there and holding no agent", () => {
      expect(
        roots({ sessions: [at("/a/visited", "2026-01-01T00:00:00.000Z")] }),
      ).toEqual([]);
    });

    /* THE LIVE CLAUSE. A bare scaffold session, a live session in a folder with
       no agent yet, is exactly how you start an agent in an empty folder, and
       dropping its row makes a running session unreachable from the rail. Both
       halves are asserted because only the pair pins the distinction: "a
       session ran here once" and "something is running here now" are different
       claims about the same cwd. */
    it("keeps a folder with no agent when a session is LIVE in it", () => {
      expect(
        roots({
          sessions: [at("/a/bare", "2026-01-01T00:00:00.000Z", "running")],
        }),
      ).toEqual(["/a/bare"]);
    });

    it("drops that same folder once its session has exited", () => {
      expect(
        roots({
          sessions: [at("/a/bare", "2026-01-01T00:00:00.000Z", "exited")],
        }),
      ).toEqual([]);
    });

    it("keeps a session-only folder once it actually holds an agent", () => {
      expect(
        roots({
          sessions: [at("/a/real", "2026-01-01T00:00:00.000Z")],
          agentPaths: ["/a/real/ads"],
        }),
      ).toEqual(["/a/real"]);
    });

    it("drops a session-only folder whose agents a chosen project already shows, rather than printing them twice", () => {
      expect(
        roots({
          recentDirs: ["/a/acme"],
          sessions: [at("/a/acme/services", "2026-01-01T00:00:00.000Z")],
          agentPaths: ["/a/acme/services/ads"],
        }),
      ).toEqual(["/a/acme"]);
    });

    it("takes the OUTERMOST session folder that explains an agent, whatever order the candidates arrive in", () => {
      expect(
        roots({
          sessions: [
            at("/a/repo/deep/inner", "2026-02-01T00:00:00.000Z"),
            at("/a/repo", "2026-01-01T00:00:00.000Z"),
          ],
          agentPaths: ["/a/repo/deep/inner/ads"],
        }),
      ).toEqual(["/a/repo"]);
    });
  });

  describe("an agent's own directory is not a project", () => {
    it("drops an agent-rooted entry an open project already contains, the row that renders the agent TWICE", () => {
      expect(
        roots({
          recentDirs: ["/a/acme", "/a/acme/leasing"],
          agentPaths: ["/a/acme/leasing"],
        }),
      ).toEqual(["/a/acme"]);
    });

    it("promotes an agent-rooted entry nothing else contains, so its siblings gather into one project", () => {
      expect(
        roots({
          recentDirs: ["/a/loose/one"],
          agentPaths: ["/a/loose/one", "/a/loose/two"],
        }),
      ).toEqual(["/a/loose"]);
    });

    it("walks past an agent nested inside another agent rather than promoting into one", () => {
      expect(
        roots({
          recentDirs: ["/a/outer/inner"],
          agentPaths: ["/a/outer", "/a/outer/inner"],
        }),
      ).toEqual(["/a"]);
    });

    /* The exact shape of a clean demo fixture, which is how this was found: an
       ordinary project beside two agent folders under one home directory.
       Promoting either produced a single project called `demo` holding every
       other project, with the agents inside it rendered twice. Written from the
       fixture rather than simplified, because the simplified version (no
       ordinary project present) does NOT reproduce it and passes either way. */
    it("REFUSES a promotion that would swallow another project", () => {
      const out = roots({
        recentDirs: [
          "/Users/demo/acme-app",
          "/Users/demo/rfq",
          "/Users/demo/onboarding",
        ],
        agentPaths: [
          "/Users/demo/acme-app/leasing",
          "/Users/demo/rfq",
          "/Users/demo/onboarding",
        ],
      });
      expect(out).not.toContain("/Users/demo");
      expect(out).toHaveLength(3);
    });

    /* Stated because it is a real limit, not a covered case. The guard asks
       "would this swallow a project", so a directory holding only agent folders
       and no other project DOES become the project. Right everywhere except a
       home directory, and a home directory in practice always holds another
       project, which is what makes the guard fire. A depth floor was considered
       and rejected: every threshold that saves `/Users/demo` also breaks a
       legitimate two-segment root. */
    it("does promote into a bare parent when there is no project to swallow, the known limit of the guard", () => {
      expect(
        roots({ recentDirs: ["/a/x", "/a/y"], agentPaths: ["/a/x", "/a/y"] }),
      ).toEqual(["/a"]);
    });

    it("keeps an agent at the filesystem root: an agent that exists and nothing shows is the worse answer", () => {
      expect(roots({ recentDirs: ["/solo"], agentPaths: ["/solo"] })).toEqual([
        "/solo",
      ]);
    });
  });

  describe("order", () => {
    it("keeps recentDirs order under 'recent' (it is the MRU list)", () => {
      expect(
        roots({
          recentDirs: ["/a/three", "/a/one", "/a/two"],
          agentPaths: ["/a/three/x", "/a/one/x", "/a/two/x"],
        }),
      ).toEqual(["/a/three", "/a/one", "/a/two"]);
    });

    it("falls back to newest session activity for folders recentDirs has not recorded", () => {
      expect(
        roots({
          sessions: [
            at("/a/old", "2026-01-01T00:00:00.000Z"),
            at("/a/new", "2026-02-01T00:00:00.000Z"),
          ],
          agentPaths: ["/a/old/x", "/a/new/x"],
        }),
      ).toEqual(["/a/new", "/a/old"]);
    });

    it("ranks a recentDirs entry above one only session activity knows", () => {
      expect(
        roots({
          recentDirs: ["/a/known"],
          sessions: [at("/a/seen", "2099-01-01T00:00:00.000Z")],
          agentPaths: ["/a/known/x", "/a/seen/x"],
        }),
      ).toEqual(["/a/known", "/a/seen"]);
    });

    it("sorts A-Z by basename under 'name'", () => {
      expect(
        roots({
          recentDirs: ["/z/beta", "/a/alpha"],
          agentPaths: ["/z/beta/x", "/a/alpha/x"],
          sort: "name",
        }),
      ).toEqual(["/a/alpha", "/z/beta"]);
    });

    it("floats a folder mid-creation above every real project, on either sort", () => {
      for (const sort of ["recent", "name"] as const) {
        expect(
          roots({
            recentDirs: ["/a/aaa"],
            pendingCwds: ["/z/zzz"],
            agentPaths: ["/a/aaa/x"],
            sort,
          })[0],
        ).toBe("/z/zzz");
      }
    });

    it("keeps several pending folders in creation order, newest first", () => {
      expect(
        roots({ pendingCwds: ["/a/second", "/a/first"], sort: "name" }),
      ).toEqual(["/a/second", "/a/first"]);
    });

    it("a PROMOTED row inherits the recency of the entry that produced it", () => {
      expect(
        roots({
          recentDirs: ["/a/newer/agent", "/a/older"],
          agentPaths: ["/a/newer/agent", "/a/older/x"],
        }),
      ).toEqual(["/a/newer", "/a/older"]);
    });

    it("does not render one folder twice because two sources spell it differently", () => {
      expect(
        roots({
          recentDirs: ["/a/one"],
          sessions: [at("/a/one/", "2026-01-01T00:00:00.000Z")],
          agentPaths: ["/a/one/x"],
        }),
      ).toEqual(["/a/one"]);
    });

    it("keeps a nested root alongside its parent when BOTH were chosen: two contexts", () => {
      expect(
        roots({
          recentDirs: ["/a/one", "/a/one/services/workers"],
          agentPaths: ["/a/one/x", "/a/one/services/workers/y"],
        }),
      ).toEqual(["/a/one", "/a/one/services/workers"]);
    });
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
    expect(
      abbreviate(["packages", "harness", "web", "src", "components"]),
    ).toBe("packages/…/components");
  });

  it("keeps two segments whole even when they are wide", () => {
    // Both conditions must hold, so a 2-segment label never elides.
    expect(
      abbreviate(["averyverylongdirectoryname", "anotherlongdirectory"]),
    ).toBe("averyverylongdirectoryname/anotherlongdirectory");
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
