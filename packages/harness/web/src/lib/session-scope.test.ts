import { describe, expect, it } from "vitest";

import {
  canvasSourceFor,
  canvasSubject,
  lifecycleVerbGate,
  liveSessionsForFocus,
  mergeSubjectRuns,
  OBSERVED_RUN_WINDOW,
  projectRootForAgent,
  rootContains,
  runsForSubject,
  selectedRunForSubject,
  sessionForFocus,
  sessionStripSubject,
  shownRunForSubject,
  type AttributedRun,
  type GatedWorkflow,
  type ScopedSession,
} from "./session-scope";

/**
 * SAP-2927 / criterion 18: a new session's cwd is the project root.
 *
 * Every case here is a bug that shipped or a bug one character away. The e2e
 * spec (`e2e/session-scope.spec.ts`) covers the same ground through a browser,
 * because a unit test on a pure function cannot show that `App.tsx` calls it;
 * these exist so a regression fails in a second, in the file that caused it.
 */

const HOME = "/Users/dave";
const POLSIA = `${HOME}/polsia`;
const ADS = `${POLSIA}/backend/src/agents/ads`;

describe("projectRootForAgent: a session boots at the project root", () => {
  it("returns the root that contains the agent, not the agent's folder", () => {
    // The rule the whole change exists for: rooted in the agent's folder, the
    // booting agent never sees the project's CLAUDE.md, .claude/ or skills.
    expect(projectRootForAgent(ADS, [POLSIA])).toBe(POLSIA);
  });

  it("picks the LONGEST containing root, whatever order the roots arrive in", () => {
    // recentDirs is ordered by recency, which says nothing about depth. Both
    // orders must land on the nearer root, which is the context the user chose
    // when they opened it.
    const nested = `${POLSIA}/backend/src/agents`;
    expect(projectRootForAgent(ADS, [POLSIA, nested])).toBe(nested);
    expect(projectRootForAgent(ADS, [nested, POLSIA])).toBe(nested);
  });

  it("treats a root that IS the agent as containing it", () => {
    // A project root that is itself an agent project is one row and one
    // context; it must not fall through to the fallback.
    expect(projectRootForAgent(ADS, [ADS])).toBe(ADS);
  });

  it("falls back to the agent's own folder when no known root contains it", () => {
    // Honest degradation: an agent discovered outside every opened project
    // still opens rather than failing to start.
    expect(projectRootForAgent(ADS, [])).toBe(ADS);
    expect(projectRootForAgent(ADS, [`${HOME}/unrelated`, `${HOME}/other`])).toBe(ADS);
  });

  it("matches on segment boundaries, so a same-prefix sibling root never wins", () => {
    // `~/polsia-old` is not a parent of anything under `~/polsia`. A bare
    // startsWith(root) says otherwise and boots the session in a project the
    // agent has nothing to do with. The longest-root sort makes the wrong
    // answer WIN when it is present, so this is the case that must hold.
    expect(projectRootForAgent(ADS, [`${POLSIA}-old`])).toBe(ADS);
    expect(projectRootForAgent(ADS, [`${POLSIA}-old`, POLSIA])).toBe(POLSIA);
    expect(projectRootForAgent(`${POLSIA}-old/agents/x`, [POLSIA])).toBe(
      `${POLSIA}-old/agents/x`,
    );
  });

  it("ignores empty roots and trailing slashes", () => {
    // An empty string prefixes every path, and a root recorded with a trailing
    // slash is the same place as one without — including in the length sort,
    // where the extra character must not outrank a genuinely deeper root.
    expect(projectRootForAgent(ADS, [""])).toBe(ADS);
    expect(projectRootForAgent(ADS, ["   "])).toBe(ADS);
    expect(projectRootForAgent(ADS, [`${POLSIA}/`])).toBe(POLSIA);
    expect(projectRootForAgent(`${ADS}/`, [POLSIA])).toBe(POLSIA);
    expect(projectRootForAgent(ADS, [`${POLSIA}/`, `${POLSIA}/backend`])).toBe(
      `${POLSIA}/backend`,
    );
  });

  it("keeps the filesystem root usable as a root", () => {
    expect(projectRootForAgent(ADS, ["/"])).toBe("/");
    // ...but never at the expense of a real project that also contains it.
    expect(projectRootForAgent(ADS, ["/", POLSIA])).toBe(POLSIA);
  });

  it("resolves Windows paths, in whatever separator form they were recorded", () => {
    // The server hands the SPA native paths and the SPA holds whatever
    // recentDirs recorded, so the two spellings of one directory must resolve
    // to the same project (paths.ts's mixed-form contract).
    expect(projectRootForAgent("C:\\Users\\dave\\polsia\\agents\\ads", ["C:\\Users\\dave\\polsia"]))
      .toBe("C:\\Users\\dave\\polsia");
    expect(projectRootForAgent("C:\\Users\\dave\\polsia\\agents\\ads", ["C:/Users/dave/polsia"]))
      .toBe("C:/Users/dave/polsia");
    expect(projectRootForAgent("C:\\Users\\dave\\polsia-old\\ads", ["C:\\Users\\dave\\polsia"]))
      .toBe("C:\\Users\\dave\\polsia-old\\ads");
  });
});

describe("rootContains", () => {
  it("counts equality and true descent, nothing else", () => {
    expect(rootContains(POLSIA, POLSIA)).toBe(true);
    expect(rootContains(POLSIA, ADS)).toBe(true);
    expect(rootContains(ADS, POLSIA)).toBe(false);
    expect(rootContains(`${POLSIA}-old`, ADS)).toBe(false);
    // A partial segment is not a segment: `.../agent` does not contain
    // `.../agents/ads`.
    expect(rootContains(`${POLSIA}/backend/src/agent`, ADS)).toBe(false);
  });

  it("refuses an empty root, which would otherwise contain everything", () => {
    expect(rootContains("", ADS)).toBe(false);
    expect(rootContains("   ", ADS)).toBe(false);
  });

  it("ignores a trailing slash on either side", () => {
    expect(rootContains(`${POLSIA}/`, ADS)).toBe(true);
    expect(rootContains(POLSIA, `${ADS}/`)).toBe(true);
    expect(rootContains(`${POLSIA}/`, `${POLSIA}/`)).toBe(true);
  });

  it("lets the filesystem root contain every absolute path", () => {
    expect(rootContains("/", ADS)).toBe(true);
    expect(rootContains("/", "/")).toBe(true);
  });
});

/**
 * SAP-2931 / criteria 19–22: the canvas, the lifecycle verbs and the run
 * evidence follow the rail SELECTION, not the active session's binding.
 *
 * Three of these rules were reported met while broken in the reference
 * prototype — verb gating, run evidence, and the merge's bound — each because
 * the code existed and had never been exercised. So each case below is either a
 * bug that shipped or a bug one character away, and the browser spec
 * (`e2e/selection-canvas.spec.ts`) covers the same ground where the claim is
 * visual: a unit test on a pure function cannot show that `App.tsx` calls it.
 */

const TROPEE = `${HOME}/tropee`;
const OUTREACH = `${POLSIA}/backend/src/agents/outreach`;

const session = (over: Partial<ScopedSession> = {}): ScopedSession => ({
  id: "s1",
  cwd: POLSIA,
  status: "running",
  boundWorkflowPath: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  ...over,
});

describe("liveSessionsForFocus", () => {
  const bound = session({ id: "b", boundWorkflowPath: ADS, cwd: POLSIA });
  const inFolder = session({ id: "f", cwd: ADS });
  const elsewhere = session({ id: "e", boundWorkflowPath: `${POLSIA}/other`, cwd: POLSIA });
  const dead = session({ id: "d", boundWorkflowPath: ADS, status: "exited" });

  it("claims bound sessions and unbound sessions sitting in the folder", () => {
    expect(liveSessionsForFocus([bound, inFolder, elsewhere, dead], ADS).map((s) => s.id)).toEqual([
      "b",
      "f",
    ]);
  });

  it("never claims a session bound elsewhere just because the cwd matches", () => {
    // A session bound to another agent belongs to that agent's strip, whatever
    // folder it happens to sit in.
    const boundElsewhereInFolder = session({ id: "x", boundWorkflowPath: POLSIA, cwd: ADS });
    expect(liveSessionsForFocus([boundElsewhereInFolder], ADS)).toEqual([]);
  });

  it("orders oldest first, the order Cmd/Ctrl+1..9 selects, and stably on a tie", () => {
    const older = session({ id: "z", cwd: ADS, createdAt: "2026-08-01T09:00:00.000Z" });
    const newer = session({ id: "a", cwd: ADS, createdAt: "2026-08-01T11:00:00.000Z" });
    expect(liveSessionsForFocus([newer, older], ADS).map((s) => s.id)).toEqual(["z", "a"]);
    // Same timestamp, ordered by id, so the strip never reorders between renders.
    expect(
      liveSessionsForFocus([session({ id: "m", cwd: ADS }), session({ id: "k", cwd: ADS })], ADS).map(
        (s) => s.id,
      ),
    ).toEqual(["k", "m"]);
  });

  it("compares paths, not strings, so a trailing separator still matches", () => {
    // The server resolve()s the cwd it stores while the selection is whatever
    // recentDirs kept — a raw === hid the session the user had just created.
    expect(liveSessionsForFocus([session({ id: "t", cwd: `${ADS}/` })], ADS).map((s) => s.id)).toEqual(
      ["t"],
    );
  });

  it("is empty for no subject", () => {
    expect(liveSessionsForFocus([bound, inFolder], null)).toEqual([]);
  });
});

describe("sessionStripSubject: the strip follows the ACTIVE session", () => {
  it("takes the active session's bound agent, not the rail selection", () => {
    // Selecting F while B's session runs must leave B's tabs on screen. Keyed
    // to the selection, the strip emptied itself under the session still
    // running in the pane below it.
    expect(sessionStripSubject(session({ boundWorkflowPath: ADS }), OUTREACH)).toBe(ADS);
  });

  it("falls back to the session's own folder when it is unbound", () => {
    expect(sessionStripSubject(session({ cwd: POLSIA }), ADS)).toBe(POLSIA);
  });

  it("names the rail selection only when there is no live active session", () => {
    expect(sessionStripSubject(null, ADS)).toBe(ADS);
    expect(
      sessionStripSubject(session({ status: "exited", boundWorkflowPath: POLSIA }), ADS),
    ).toBe(ADS);
    expect(sessionStripSubject(null, null)).toBeNull();
  });
});

describe("sessionForFocus: selection moves the session across projects, never within one", () => {
  const at = (over: Partial<ScopedSession>): ScopedSession => session(over);
  const polsiaSession = at({ id: "p", cwd: POLSIA, lastActiveAt: "2026-08-02T10:00:00.000Z" });
  const otherSession = at({ id: "o", cwd: TROPEE, lastActiveAt: "2026-08-02T09:00:00.000Z" });
  const roots = [POLSIA, TROPEE];

  it("keeps the session when the selected agent is in its project", () => {
    // The whole point of the decoupling: read F's board while still talking to
    // B. One session has context on every agent in its project.
    expect(
      sessionForFocus({ focusPath: ADS, active: polsiaSession, sessions: [polsiaSession], roots }),
    ).toEqual({ kind: "keep" });
    expect(
      sessionForFocus({
        focusPath: OUTREACH,
        active: polsiaSession,
        sessions: [polsiaSession],
        roots,
      }),
    ).toEqual({ kind: "keep" });
  });

  it("switches to the other project's session when the selection leaves the scope", () => {
    // Sessions are project-scoped, so staying put would leave the user typing
    // into a project that does not contain the agent on screen.
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: otherSession,
        sessions: [otherSession, polsiaSession],
        roots,
      }),
    ).toEqual({ kind: "switch", to: polsiaSession });
  });

  it("switches to none when the selected project has no live session", () => {
    expect(
      sessionForFocus({ focusPath: ADS, active: otherSession, sessions: [otherSession], roots }),
    ).toEqual({ kind: "switch", to: null });
  });

  it("ignores exited sessions on both sides of the question", () => {
    const deadPolsia = at({ id: "dead", cwd: POLSIA, status: "exited" });
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: otherSession,
        sessions: [otherSession, deadPolsia],
        roots,
      }),
    ).toEqual({ kind: "switch", to: null });
    // A dead ACTIVE session holds nothing, so the selection is free to adopt
    // its own project's session.
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: at({ id: "x", cwd: TROPEE, status: "exited" }),
        sessions: [polsiaSession],
        roots,
      }),
    ).toEqual({ kind: "switch", to: polsiaSession });
  });

  it("adopts the selected project's session when nothing is active", () => {
    // Reachable after closing the last tab: the pane said "no running session
    // for F" while F's project had one, which was a false absence.
    expect(
      sessionForFocus({ focusPath: ADS, active: null, sessions: [polsiaSession], roots }),
    ).toEqual({ kind: "switch", to: polsiaSession });
    expect(sessionForFocus({ focusPath: ADS, active: null, sessions: [], roots })).toEqual({
      kind: "switch",
      to: null,
    });
  });

  it("prefers a session belonging to the agent over another in the same project", () => {
    // Runs and history are observed per session, so the agent's own session is
    // the one that can answer for it — even when it is the older one.
    const own = at({
      id: "own",
      cwd: POLSIA,
      boundWorkflowPath: ADS,
      lastActiveAt: "2026-08-01T08:00:00.000Z",
    });
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: otherSession,
        sessions: [otherSession, polsiaSession, own],
        roots,
      }),
    ).toEqual({ kind: "switch", to: own });
  });

  it("takes the most recently WORKED IN session, not the most recently made", () => {
    const older = at({
      id: "a",
      cwd: POLSIA,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastActiveAt: "2026-08-05T00:00:00.000Z",
    });
    const newer = at({
      id: "b",
      cwd: POLSIA,
      createdAt: "2026-08-04T00:00:00.000Z",
      lastActiveAt: "2026-08-04T00:00:00.000Z",
    });
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: otherSession,
        sessions: [otherSession, newer, older],
        roots,
      }),
    ).toEqual({ kind: "switch", to: older });
    // With no lastActiveAt anywhere, createdAt is the fallback ordering.
    const c1 = at({ id: "c1", cwd: POLSIA, createdAt: "2026-07-01T00:00:00.000Z" });
    const c2 = at({ id: "c2", cwd: POLSIA, createdAt: "2026-08-04T00:00:00.000Z" });
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: otherSession,
        sessions: [otherSession, c1, c2],
        roots,
      }),
    ).toEqual({ kind: "switch", to: c2 });
  });

  it("keeps the session when an outer root's session already reaches a nested project's agent", () => {
    // Overlapping roots, and the answer is deliberately asymmetric. Both
    // ~/polsia and ~/polsia/services/workers are open, so an agent under
    // workers/ resolves to the NESTED project (longest root wins) — but a
    // session at the outer root plainly contains it, and selecting that row
    // must not look like a project jump for a row the session can work on.
    const nested = `${POLSIA}/services/workers`;
    const worker = `${nested}/ads`;
    const outer = at({ id: "outer", cwd: POLSIA });
    expect(
      sessionForFocus({
        focusPath: worker,
        active: outer,
        sessions: [outer],
        roots: [POLSIA, nested],
      }),
    ).toEqual({ kind: "keep" });
    // Not symmetric, and deliberately: a session rooted at the NESTED project
    // cannot reach up to an agent outside it, so that one hands over — to the
    // outer project's own most-recently-worked-in session.
    const inner = at({ id: "inner", cwd: nested, lastActiveAt: "2026-08-01T00:00:00.000Z" });
    const outerRecent = at({ id: "outer", cwd: POLSIA, lastActiveAt: "2026-08-09T00:00:00.000Z" });
    expect(
      sessionForFocus({
        focusPath: ADS,
        active: inner,
        sessions: [inner, outerRecent],
        roots: [POLSIA, nested],
      }),
    ).toEqual({ kind: "switch", to: outerRecent });
  });

  it("keeps a session left rooted in an agent's own folder when a sibling is selected", () => {
    // Older builds rooted sessions at the agent. That session still belongs to
    // the project around it, so a sibling selection must not read as a jump.
    const legacy = at({ id: "legacy", cwd: ADS });
    expect(
      sessionForFocus({ focusPath: OUTREACH, active: legacy, sessions: [legacy], roots }),
    ).toEqual({ kind: "keep" });
  });

  it("does not throw for an agent under no known root", () => {
    const orphan = `${HOME}/scratch/rollup`;
    // Its own folder is the fallback project, so only sessions inside it can
    // claim it.
    expect(
      sessionForFocus({ focusPath: orphan, active: polsiaSession, sessions: [polsiaSession], roots }),
    ).toEqual({ kind: "switch", to: null });
    const inOrphan = at({ id: "orphan", cwd: orphan });
    expect(
      sessionForFocus({ focusPath: orphan, active: polsiaSession, sessions: [inOrphan], roots }),
    ).toEqual({ kind: "switch", to: inOrphan });
    expect(sessionForFocus({ focusPath: orphan, active: null, sessions: [], roots: [] })).toEqual({
      kind: "switch",
      to: null,
    });
  });

  it("keeps the session when the selection is the project root itself", () => {
    expect(
      sessionForFocus({ focusPath: POLSIA, active: polsiaSession, sessions: [polsiaSession], roots }),
    ).toEqual({ kind: "keep" });
  });
});

describe("canvasSubject: the board is the selection, full stop", () => {
  const selection = { path: ADS, name: "ads" };

  it("is the rail selection", () => {
    // Binding stopped being how the board is chosen: select F while the
    // terminal is mid-sentence with B and F's board is what draws.
    expect(canvasSubject({ selection })).toBe(selection);
  });

  it("has no subject when the selection is not an agent", () => {
    // A project or bare-folder row is not a subject. Falling back to the
    // binding here would draw the last agent's board as though it had been
    // asked for.
    expect(canvasSubject({ selection: null })).toBeNull();
  });

  it("projects nothing while suppressed", () => {
    // The create-new draft or a review owns the centre: an absence must not
    // have another agent's board sitting behind it.
    expect(canvasSubject({ selection, suppressed: true })).toBeNull();
  });
});

describe("canvasSourceFor: which entry point serves the subject's board", () => {
  it("uses the session-keyed board when the active session is bound to the subject", () => {
    // That route is the one canvas.reload addresses and the run-state bridge
    // posts into; reaching for the workflow-keyed one here would trade a live
    // board for a snapshot.
    expect(canvasSourceFor({ subjectPath: ADS, bindingPath: ADS, sessionId: "s1" })).toEqual({
      kind: "session",
      sessionId: "s1",
    });
    // Separator/trailing-slash spellings are the same place.
    expect(canvasSourceFor({ subjectPath: ADS, bindingPath: `${ADS}/`, sessionId: "s1" })).toEqual({
      kind: "session",
      sessionId: "s1",
    });
  });

  it("uses the workflow-keyed route whenever the session is bound elsewhere", () => {
    // /canvas/:sessionId/ resolves by the BINDING, so it would serve the wrong
    // agent's board — this is the mis-draw the route exists to prevent.
    expect(canvasSourceFor({ subjectPath: ADS, bindingPath: OUTREACH, sessionId: "s1" })).toEqual({
      kind: "workflow",
      path: ADS,
    });
  });

  it("uses the workflow-keyed route for an agent with no session at all", () => {
    // The criterion IA-01 landed for: an agent that has never hosted a session
    // still has a board.
    expect(canvasSourceFor({ subjectPath: ADS, bindingPath: null, sessionId: null })).toEqual({
      kind: "workflow",
      path: ADS,
    });
    // A live but unbound session is the same case.
    expect(canvasSourceFor({ subjectPath: ADS, bindingPath: null, sessionId: "s1" })).toEqual({
      kind: "workflow",
      path: ADS,
    });
  });

  it("has no source without a subject", () => {
    expect(canvasSourceFor({ subjectPath: null, bindingPath: ADS, sessionId: "s1" })).toEqual({
      kind: "none",
    });
  });
});

describe("lifecycleVerbGate: the verbs are gated BY the selection, not aimed at it", () => {
  const agent = (over: Partial<GatedWorkflow> = {}): GatedWorkflow => ({
    path: ADS,
    name: "ads",
    definitionId: null,
    activeBuildRunStatus: null,
    ...over,
  });
  const deployed = agent({ definitionId: 4821, activeBuildRunStatus: "ready" });
  const draft = agent();
  const signedIn = { authenticated: true, deployError: null };

  it("returns the SELECTION as the subject of every verb", () => {
    // The prototype's bug in one assertion: subject and enabled-state came from
    // different agents. One call returns both, so they cannot drift apart.
    for (const verb of ["prod", "test", "run", "deploy"] as const) {
      expect(lifecycleVerbGate(verb, { ...signedIn, subject: draft }).subjectPath).toBe(ADS);
    }
  });

  it("disables Prod and Run for an undeployed agent, with the reason", () => {
    // The exact mis-target: selecting the undeployed agent left Prod and Run
    // live against the deployed one the session was bound to.
    expect(lifecycleVerbGate("prod", { ...signedIn, subject: draft }).reason).toBe(
      "Not deployed yet",
    );
    expect(lifecycleVerbGate("run", { ...signedIn, subject: draft }).reason).toBe(
      "Not deployed yet",
    );
  });

  it("leaves Test and Deploy available on an undeployed agent", () => {
    // They are precisely what you CAN do to it; disabling the verbs that fix
    // the state you are being told about would be honest about nothing.
    expect(lifecycleVerbGate("test", { ...signedIn, subject: draft }).reason).toBeNull();
    expect(lifecycleVerbGate("deploy", { ...signedIn, subject: draft }).reason).toBeNull();
  });

  it("enables Prod and Run on a deployed agent", () => {
    expect(lifecycleVerbGate("prod", { ...signedIn, subject: deployed }).reason).toBeNull();
    expect(lifecycleVerbGate("run", { ...signedIn, subject: deployed }).reason).toBeNull();
  });

  it("puts the auth gate ahead of the deployment gate on the cloud verbs", () => {
    // Signed out, "Not deployed yet" would send the user to Deploy, which is
    // also blocked — the reason has to name the thing they can act on.
    expect(
      lifecycleVerbGate("run", { subject: draft, authenticated: false, deployError: null }).reason,
    ).toBe("Connect your account first");
    expect(
      lifecycleVerbGate("deploy", { subject: draft, authenticated: false, deployError: null })
        .reason,
    ).toBe("Connect your account first");
    // Prod is a read, not a cloud call: it needs a definition, not a session.
    expect(
      lifecycleVerbGate("prod", { subject: deployed, authenticated: false, deployError: null })
        .reason,
    ).toBeNull();
  });

  it("reports the SUBJECT's deploy failure, and only through Run", () => {
    // Passed the binding's error, a healthy selection was disabled by another
    // agent's failure.
    expect(
      lifecycleVerbGate("run", {
        subject: agent({ definitionId: 4821 }),
        authenticated: true,
        deployError: "boom",
      }).reason,
    ).toBe("Last deploy failed — retry Deploy");
    // A ready build outlives a stale failure (workflow-deployment's rule).
    expect(
      lifecycleVerbGate("run", { subject: deployed, authenticated: true, deployError: "boom" })
        .reason,
    ).toBeNull();
    // Prod only asks whether there is a page to open.
    expect(
      lifecycleVerbGate("prod", {
        subject: agent({ definitionId: 4821 }),
        authenticated: true,
        deployError: "boom",
      }).reason,
    ).toBeNull();
  });

  it("distinguishes a build in progress from no build at all", () => {
    expect(
      lifecycleVerbGate("run", {
        ...signedIn,
        subject: agent({ definitionId: 4821, activeBuildRunStatus: "building" }),
      }).reason,
    ).toBe("Build in progress");
    expect(
      lifecycleVerbGate("run", { ...signedIn, subject: agent({ definitionId: 4821 }) }).reason,
    ).toBe("No ready deployment yet");
  });

  it("says so when nothing is selected, and names no subject", () => {
    for (const verb of ["prod", "test", "run", "deploy"] as const) {
      expect(lifecycleVerbGate(verb, { ...signedIn, subject: null })).toEqual({
        subjectPath: null,
        reason: "Select an agent first",
      });
    }
  });
});

describe("run evidence follows the subject, not the session", () => {
  const run = (
    executionId: string,
    workflowPath: string | null,
    observedAt = 0,
  ): AttributedRun & { observedAt: number } => ({
    workflowPath,
    run: { executionId },
    observedAt,
  });
  const mine = run("x1", ADS);
  const theirs = run("x2", OUTREACH);
  const unattributed = run("x3", null);

  it("keeps the subject's runs and drops another agent's", () => {
    // A run announced for the outreach agent drawn over the ads agent's
    // structure is a false account of what ran, in the surface whose job is to
    // say what ran.
    expect(runsForSubject([mine, theirs, unattributed], ADS)).toEqual([mine]);
  });

  it("shows an unattributed run only on a pane that is about no agent", () => {
    // Deliberately stricter than the reference prototype, which kept
    // unattributed runs on EVERY subject — that is how a run no agent produced
    // appears under one that never ran it. Matches this repo's existing
    // `observedRunMatchesWorkflow`.
    expect(runsForSubject([mine, theirs, unattributed], null)).toEqual([unattributed]);
  });

  it("keeps the shown run only while it belongs to the subject", () => {
    expect(selectedRunForSubject([mine, theirs], theirs, ADS)).toBeNull();
    expect(selectedRunForSubject([mine, theirs], mine, ADS)).toBe(mine);
    expect(selectedRunForSubject([mine, theirs], unattributed, ADS)).toBeNull();
    expect(selectedRunForSubject([mine], null, ADS)).toBeNull();
  });

  it("adds runs another session announced that this one never heard", () => {
    // The bug this closes: announcements only reach the session BOUND to the
    // workflow, so with the selection decoupled the agent on screen had runs
    // nothing in the UI could see.
    expect(
      mergeSubjectRuns([run("seen", ADS, 10)], [run("unseen", ADS, 5)]).map(
        (r) => r.run.executionId,
      ),
    ).toEqual(["seen", "unseen"]);
  });

  it("keeps the ACTIVE session's copy of a run both sides know", () => {
    // It is the live one, still polling, and carries the moment it was actually
    // seen; the other side is a static end state.
    const merged = mergeSubjectRuns([run("x", ADS, 99)], [run("x", ADS, 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].observedAt).toBe(99);
  });

  it("bounds the result by the retention window, whatever the run's source", () => {
    // The bug this closes: a second source folded its whole history in beside
    // the trimmed observed ids, so the picker offered 309 runs in a client that
    // retains 200 and can reopen none of the rest.
    const many = Array.from({ length: 400 }, (_, i) => run(`f${i}`, ADS));
    const merged = mergeSubjectRuns([run("live", ADS)], many);
    expect(merged).toHaveLength(OBSERVED_RUN_WINDOW);
    expect(OBSERVED_RUN_WINDOW).toBe(200);
    // The live run is still first, and the extras that survived are the NEWEST
    // (tail) — the same end a trim would keep.
    expect(merged[0].run.executionId).toBe("live");
    expect(merged[merged.length - 1].run.executionId).toBe("f399");
    // And the 309-shape specifically: 109 known elsewhere on top of 200 live.
    const live = Array.from({ length: 200 }, (_, i) => run(`l${i}`, ADS));
    const extra = Array.from({ length: 109 }, (_, i) => run(`e${i}`, ADS));
    expect(mergeSubjectRuns(live, extra)).toHaveLength(OBSERVED_RUN_WINDOW);
  });

  it("never displaces the active session's runs to make room", () => {
    // They are its own and some are still polling; evicting them for another
    // session's finished history would drop the live half of the evidence.
    const observed = [run("a", ADS), run("b", ADS), run("c", ADS)];
    expect(mergeSubjectRuns(observed, [run("x", ADS), run("y", ADS)], 3)).toEqual(observed);
    // Room for exactly one extra, and it is the newest of them.
    expect(
      mergeSubjectRuns(observed, [run("x", ADS), run("y", ADS)], 4).map((r) => r.run.executionId),
    ).toEqual(["a", "b", "c", "y"]);
  });

  it("keeps the newest observed runs when the observed list alone exceeds the window", () => {
    const observed = [run("old", ADS), run("mid", ADS), run("new", ADS)];
    expect(mergeSubjectRuns(observed, [run("x", ADS)], 2).map((r) => r.run.executionId)).toEqual([
      "mid",
      "new",
    ]);
    expect(mergeSubjectRuns(observed, [], 0)).toEqual([]);
  });

  it("is the observed list when there is nothing to add, and vice versa", () => {
    expect(mergeSubjectRuns([mine], [])).toEqual([mine]);
    expect(mergeSubjectRuns([], [theirs]).map((r) => r.run.executionId)).toEqual(["x2"]);
    expect(mergeSubjectRuns([], [])).toEqual([]);
  });

  describe("shownRunForSubject", () => {
    const first = run("first", ADS);
    const last = run("last", ADS);
    const runs = [first, last];

    it("prefers the session's own pick over the newest known", () => {
      expect(shownRunForSubject(runs, first)).toBe(first);
    });

    it("ignores a pick that is not one of this subject's runs", () => {
      // Switching agents must not pin the previous agent's run onto this board;
      // the stale pick heals itself instead of needing a reset.
      expect(shownRunForSubject(runs, run("elsewhere", OUTREACH))).toBe(last);
    });

    it("falls back to the newest known run, and to nothing when there is none", () => {
      expect(shownRunForSubject(runs, null)).toBe(last);
      expect(shownRunForSubject([], first)).toBeNull();
      expect(shownRunForSubject([], null)).toBeNull();
    });
  });
});
