import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentNeedsOwnProject,
  applyProjectRemoval,
  describeProjectRemoval,
  closedProjectsHolding,
  hiddenByClosedProject,
  planProjectRemoval,
  reopenedClosedProjects,
} from "./project-membership";

/**
 * SAP-2932 — the accumulation, at its CAUSE.
 *
 * Read the two describe blocks below as a pair, because the ticket is explicit
 * about the trap:
 *
 *  - **`agentNeedsOwnProject` covers the CAUSE.** It is the decision
 *    `connectWorkflow` makes before it remembers anything, and getting it
 *    wrong is what minted a project per agent.
 *  - **The SYMPTOM — no project row is a single agent wearing its own
 *    folder's name — is covered in `e2e/accumulation-guard.spec.ts`**, by
 *    sweeping every fixture in a browser. It has to live there: the rendered
 *    rows are the symptom, and asserting them here would pass while
 *    `connectWorkflow` was never called at all.
 *
 * A test whose name promises the cause while checking only the symptom reads
 * as coverage in every future audit. Hence the split, stated in both files.
 */

const HOME = "/Users/demo";
const ACME = `${HOME}/acme-app`;
const AGENT_IN_ACME = `${ACME}/sales-outreach`;

describe("agentNeedsOwnProject: THE CAUSE — an agent's own folder is not a project", () => {
  it("says NO for an agent an open project already contains", () => {
    // The whole bug in one line: registering this agent used to remember its
    // own folder too, so the rail grew `acme-app` AND `acme-app/sales-outreach`.
    expect(agentNeedsOwnProject(AGENT_IN_ACME, [ACME])).toBe(false);
  });

  it("says NO for an agent several levels down", () => {
    // Depth is irrelevant — containment is the only question.
    expect(agentNeedsOwnProject(`${ACME}/backend/src/agents/ads`, [ACME])).toBe(false);
  });

  it("says NO when the open project IS the agent's folder", () => {
    // A root that is itself an agent project is one row and one context; it
    // must not re-remember itself on every reconnect.
    expect(agentNeedsOwnProject(ACME, [ACME])).toBe(false);
  });

  it("says YES for an agent outside every open project — it must not become invisible", () => {
    // The other half of the rule. Dropping this agent would hide something
    // that exists, so it earns a root of its own.
    expect(agentNeedsOwnProject(`${HOME}/stray-agent`, [ACME])).toBe(true);
  });

  it("says YES with no open projects at all (a first agent on a fresh install)", () => {
    expect(agentNeedsOwnProject(`${HOME}/stray-agent`, [])).toBe(true);
  });

  it("does not mistake a sibling with a shared prefix for a container", () => {
    // `~/acme-app-old` is not inside `~/acme-app`. A bare string prefix here
    // would file the agent under a project it has nothing to do with — the
    // reason containment has exactly one implementation (paths.isWithinDir).
    expect(agentNeedsOwnProject(`${HOME}/acme-app-old/mailer`, [ACME])).toBe(true);
  });

  it("ignores an empty root, which would otherwise swallow every agent", () => {
    expect(agentNeedsOwnProject(AGENT_IN_ACME, ["", "   "])).toBe(true);
  });

  it("counts a SESSION cwd as an open project, not just recentDirs", () => {
    // recentDirs is capped at 8 and session cwds are not, so a project can
    // outlive its entry in the list. Checking recentDirs alone would mint a
    // second row for an agent the rail is already showing.
    expect(agentNeedsOwnProject(AGENT_IN_ACME, [`${HOME}/other`, ACME])).toBe(false);
  });

  it("treats a trailing separator as the same place", () => {
    expect(agentNeedsOwnProject(AGENT_IN_ACME, [`${ACME}/`])).toBe(false);
  });
});
describe("hiddenByClosedProject: a removal closes the whole subtree", () => {
  it("hides the closed root itself", () => {
    expect(hiddenByClosedProject(ACME, [ACME], [])).toBe(true);
  });

  it("hides the agents inside it — otherwise removal just makes them strays", () => {
    expect(hiddenByClosedProject(AGENT_IN_ACME, [ACME], [])).toBe(true);
  });

  it("hides a session cwd under it, so the row cannot come back as a child", () => {
    // Session cwds are project roots too (there is no migration). Left alone,
    // removing `acme-app` would replace one row with a row per subfolder a
    // session had ever run in.
    expect(hiddenByClosedProject(`${ACME}/scratch`, [ACME], [])).toBe(true);
  });

  it("leaves everything outside it alone", () => {
    expect(hiddenByClosedProject(`${HOME}/rfq-agent`, [ACME], [])).toBe(false);
    expect(hiddenByClosedProject(`${HOME}/acme-app-old`, [ACME], [])).toBe(false);
  });

  it("KEEPS a project opened separately inside it, and its agents", () => {
    // `~/polsia` and `~/polsia/services/workers` are two real contexts;
    // closing the outer one must not take the inner one with it.
    const outer = `${HOME}/polsia`;
    const inner = `${outer}/services/workers`;
    expect(hiddenByClosedProject(inner, [outer], [inner])).toBe(false);
    expect(hiddenByClosedProject(`${inner}/queue`, [outer], [inner])).toBe(false);
    // Its siblings under the closed root are still gone.
    expect(hiddenByClosedProject(`${outer}/services/gateway`, [outer], [inner])).toBe(true);
  });

  it("is NOT un-closed by an openRoots entry equal to the closed root", () => {
    // This is what makes a removal survive a reload. The stored directory list
    // can name the folder again — the CLI records its launch dir at every
    // boot, and a fixture or a merge can put it back — and an equal entry must
    // not read as "the user reopened it". Only a deliberate reopen does that
    // (see reopenedClosedProjects).
    expect(hiddenByClosedProject(ACME, [ACME], [ACME])).toBe(true);
    expect(hiddenByClosedProject(AGENT_IN_ACME, [ACME], [ACME])).toBe(true);
  });

  it("hides nothing when nothing is closed — an upgrade changes no row", () => {
    // Existing installs keep every directory they had: no migration, no purge.
    expect(hiddenByClosedProject(ACME, [], [ACME])).toBe(false);
    expect(hiddenByClosedProject(AGENT_IN_ACME, [], [])).toBe(false);
  });
});

describe("planProjectRemoval", () => {
  const sessions = [
    { id: "live-1", cwd: ACME, status: "running" as const },
    { id: "live-2", cwd: `${ACME}/scratch`, status: "starting" as const },
    { id: "dead-1", cwd: ACME, status: "exited" as const },
    { id: "elsewhere", cwd: `${HOME}/rfq-agent`, status: "running" as const },
  ];

  it("takes the project out of recentDirs", () => {
    const plan = planProjectRemoval({
      root: ACME,
      recentDirs: [ACME, `${HOME}/rfq-agent`],
      sessions: [],
    });
    expect(plan.nextRecentDirs).toEqual([`${HOME}/rfq-agent`]);
  });

  it("matches the stored entry through a trailing separator", () => {
    const plan = planProjectRemoval({
      root: ACME,
      recentDirs: [`${ACME}/`],
      sessions: [],
    });
    expect(plan.nextRecentDirs).toEqual([]);
  });

  it("KEEPS a nested project's own recentDirs entry", () => {
    const inner = `${ACME}/services/workers`;
    const plan = planProjectRemoval({ root: ACME, recentDirs: [ACME, inner], sessions: [] });
    expect(plan.nextRecentDirs).toEqual([inner]);
  });

  it("ends the LIVE sessions rooted in it and nothing else", () => {
    const plan = planProjectRemoval({ root: ACME, recentDirs: [ACME], sessions });
    expect(plan.endSessionIds).toEqual(["live-1", "live-2"]);
  });

  it("does not end a session belonging to a project opened inside it", () => {
    // Same predicate as the rows: the confirm can never promise to end a
    // session the rail then keeps showing.
    const inner = `${ACME}/scratch`;
    const plan = planProjectRemoval({ root: ACME, recentDirs: [ACME, inner], sessions });
    expect(plan.endSessionIds).toEqual(["live-1"]);
  });
});

describe("describeProjectRemoval: the confirm names the count", () => {
  it("names the number of running sessions", () => {
    expect(describeProjectRemoval(3)).toBe("Ends 3 running sessions.");
  });

  it("says one session in the singular", () => {
    expect(describeProjectRemoval(1)).toBe("Ends 1 running session.");
  });

  it("says plainly when there is nothing to end", () => {
    expect(describeProjectRemoval(0)).toBe("No running sessions to end.");
  });
});

describe("reopenedClosedProjects", () => {
  it("clears the tombstone for the folder that was reopened", () => {
    expect(reopenedClosedProjects([ACME, `${HOME}/other`], [ACME])).toEqual([`${HOME}/other`]);
  });

  it("matches through a trailing separator", () => {
    expect(reopenedClosedProjects([ACME], [`${ACME}/`])).toEqual([]);
  });

  it("does NOT reopen a parent because something inside it was opened", () => {
    // Opening `acme-app/sub` opens the subfolder — the nested-project rule
    // already shows it — and says nothing about the parent the user closed.
    expect(reopenedClosedProjects([ACME], [`${ACME}/sub`])).toEqual([ACME]);
  });

  it("leaves the list alone when nothing was reopened", () => {
    expect(reopenedClosedProjects([ACME], [])).toEqual([ACME]);
  });
});

describe("closedProjectsHolding: an agent registered inside a removed project", () => {
  it("names the closed project that would hide the agent", () => {
    // Neither filing it into a hidden project nor giving it a root of its own
    // is acceptable — the first hides an agent that exists, the second mints
    // `acme-app/sales-outreach`. Reopening the folder is the honest answer.
    expect(closedProjectsHolding([ACME], AGENT_IN_ACME)).toEqual([ACME]);
  });

  it("names nothing for an agent outside every closed project", () => {
    expect(closedProjectsHolding([ACME], `${HOME}/rfq-agent/x`)).toEqual([]);
    expect(closedProjectsHolding([], AGENT_IN_ACME)).toEqual([]);
  });
});

describe("applyProjectRemoval", () => {
  it("ends every session, then stores the shorter directory list", async () => {
    const calls: string[] = [];
    const outcome = await applyProjectRemoval(
      { root: ACME, nextRecentDirs: [`${HOME}/rfq-agent`], endSessionIds: ["a", "b"] },
      {
        endSession: async (id) => {
          calls.push(`end:${id}`);
        },
        saveRecentDirs: async (dirs) => {
          calls.push(`save:${dirs.join(",")}`);
        },
      },
    );
    expect(calls).toEqual(["end:a", "end:b", `save:${HOME}/rfq-agent`]);
    expect(outcome).toEqual({ endedCount: 2, failedSessionIds: [] });
  });

  it("still removes the project when a session refuses to die, and reports which", async () => {
    const saved: string[][] = [];
    const outcome = await applyProjectRemoval(
      { root: ACME, nextRecentDirs: [], endSessionIds: ["ok", "stuck"] },
      {
        endSession: async (id) => {
          if (id === "stuck") throw new Error("PTY would not die");
        },
        saveRecentDirs: async (dirs) => {
          saved.push([...dirs]);
        },
      },
    );
    // The user asked for the folder to go. Leaving it in the rail because one
    // PTY survived would answer a different question.
    expect(saved).toEqual([[]]);
    expect(outcome).toEqual({ endedCount: 1, failedSessionIds: ["stuck"] });
  });

  /**
   * "Remove" must never read as "delete my code" — and the copy that says so
   * is only as good as this assertion.
   *
   * A real directory, shaped like a project (marker file, source, a `.git`),
   * is snapshotted by relative path AND content around a removal that names
   * that directory as its root. The port is the complete set of things a
   * removal asks of the world, so a future step that wrote, moved or deleted
   * anything under the project would have to arrive as a third port method or
   * a direct write — and either one changes this snapshot.
   */
  it("creates, moves and deletes NOTHING on disk", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sapiom-remove-"));
    try {
      const root = path.join(tmp, "acme-app");
      await fs.mkdir(path.join(root, "leasing"), { recursive: true });
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.writeFile(path.join(root, "sapiom.json"), '{"name":"acme-app"}\n');
      await fs.writeFile(path.join(root, "leasing", "sapiom.json"), '{"name":"leasing"}\n');
      await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

      const snapshot = async (dir: string): Promise<string[]> => {
        const out: string[] = [];
        const walk = async (at: string): Promise<void> => {
          for (const entry of (await fs.readdir(at, { withFileTypes: true })).sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            const full = path.join(at, entry.name);
            const rel = path.relative(dir, full);
            if (entry.isDirectory()) {
              out.push(`dir  ${rel}`);
              await walk(full);
            } else {
              out.push(`file ${rel} ${await fs.readFile(full, "utf8")}`);
            }
          }
        };
        await walk(dir);
        return out;
      };

      const before = await snapshot(tmp);
      const plan = planProjectRemoval({
        root,
        recentDirs: [root],
        sessions: [{ id: "live", cwd: root, status: "running" }],
      });
      expect(plan.endSessionIds).toEqual(["live"]);
      await applyProjectRemoval(plan, {
        endSession: async () => {},
        saveRecentDirs: async () => {},
      });

      expect(await snapshot(tmp)).toEqual(before);
      // And the project itself is still exactly where it was.
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
