import { describe, expect, it } from "vitest";

import { projectRootForAgent, rootContains } from "./session-scope";

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
