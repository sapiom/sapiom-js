import { describe, it, expect } from "vitest";
import type { AgentVersionView } from "@shared/types";

import {
  isContentDigest,
  localStateLabel,
  needsPinConfirm,
  newestReadySha,
  realLabels,
  shortSha,
  versionLabel,
  whenLabel,
} from "./versions";

function version(
  over: Partial<AgentVersionView> & { sha: string },
): AgentVersionView {
  return {
    subject: "",
    author: "",
    committedAt: "2026-01-01T00:00:00.000Z",
    deployedAt: "2026-01-01T00:00:00.000Z",
    buildStatus: "ready",
    tags: [],
    isActive: false,
    ...over,
  };
}

describe("realLabels", () => {
  it("drops `latest`, which is computed and cannot be moved", () => {
    expect(realLabels(version({ sha: "a", tags: ["latest", "0.0.2"] }))).toEqual([
      "0.0.2",
    ]);
  });

  it("is empty for a build carrying only the computed label", () => {
    expect(realLabels(version({ sha: "a", tags: ["latest"] }))).toEqual([]);
  });
});

describe("versionLabel", () => {
  it("prefers a real label over the sha", () => {
    expect(
      versionLabel(version({ sha: "abcdef1234", tags: ["latest", "0.0.2"] })),
    ).toBe("0.0.2");
  });

  it("falls back to the short sha when nothing is labelled", () => {
    expect(versionLabel(version({ sha: "abcdef1234", tags: ["latest"] }))).toBe(
      "abcdef1",
    );
  });
});

describe("newestReadySha", () => {
  it("picks the most recently deployed ready build", () => {
    const rows = [
      version({ sha: "old", deployedAt: "2026-01-01T00:00:00.000Z" }),
      version({ sha: "new", deployedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(newestReadySha(rows)).toBe("new");
  });

  /**
   * Offering a building or failed build as "latest" would point the agent at
   * something that cannot run.
   */
  it("ignores builds that are not ready, however recent", () => {
    const rows = [
      version({ sha: "building", buildStatus: "building", deployedAt: "2026-05-01T00:00:00.000Z" }),
      version({ sha: "failed", buildStatus: "failed", deployedAt: "2026-04-01T00:00:00.000Z" }),
      version({ sha: "ready", deployedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(newestReadySha(rows)).toBe("ready");
  });

  it("returns null when nothing is ready", () => {
    expect(
      newestReadySha([version({ sha: "a", buildStatus: "building" })]),
    ).toBeNull();
  });

  it("falls back to committedAt for a build that was never deployed", () => {
    const rows = [
      version({ sha: "a", deployedAt: null, committedAt: "2026-06-01T00:00:00.000Z" }),
      version({ sha: "b", deployedAt: null, committedAt: "2026-05-01T00:00:00.000Z" }),
    ];
    expect(newestReadySha(rows)).toBe("a");
  });
});

describe("needsPinConfirm", () => {
  const rows = [
    version({ sha: "newest", deployedAt: "2026-03-01T00:00:00.000Z" }),
    version({ sha: "older", deployedAt: "2026-01-01T00:00:00.000Z" }),
  ];

  it("does not confirm when returning to the newest build", () => {
    // Going forward resumes following latest — a return to normal.
    expect(needsPinConfirm(rows, "newest")).toBe(false);
  });

  it("confirms when pinning back to an older build", () => {
    // Pinning stops later deploys going live, which deserves a second look.
    expect(needsPinConfirm(rows, "older")).toBe(true);
  });

  it("confirms for a sha that is not in the list at all", () => {
    expect(needsPinConfirm(rows, "unknown")).toBe(true);
  });
});

describe("whenLabel", () => {
  const now = Date.parse("2026-03-01T12:00:00.000Z");

  it("reads `just now` under a minute", () => {
    expect(
      whenLabel(version({ sha: "a", deployedAt: "2026-03-01T11:59:40.000Z" }), now),
    ).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(
      whenLabel(version({ sha: "a", deployedAt: "2026-03-01T11:30:00.000Z" }), now),
    ).toBe("30m ago");
    expect(
      whenLabel(version({ sha: "a", deployedAt: "2026-03-01T06:00:00.000Z" }), now),
    ).toBe("6h ago");
    expect(
      whenLabel(version({ sha: "a", deployedAt: "2026-02-25T12:00:00.000Z" }), now),
    ).toBe("4d ago");
  });

  it("dashes rather than inventing a date when the stamp is unusable", () => {
    expect(
      whenLabel(version({ sha: "a", deployedAt: "not-a-date", committedAt: "also-bad" }), now),
    ).toBe("—");
  });
});

describe("shortSha", () => {
  it("takes seven characters", () => {
    expect(shortSha("2f86780534d145719dd7708009ccb1cd440220f2")).toBe("2f86780");
  });
});

describe("localStateLabel", () => {
  const deployed = version({ sha: "a".repeat(64), tags: ["latest", "0.0.2"] });
  const gitBuilt = version({ sha: "b".repeat(40), tags: ["0.0.1"] });

  it("names the deployed version the local copy matches", () => {
    expect(
      localStateLabel({ digest: "a".repeat(64), matchesSha: "a".repeat(64) }, [
        deployed,
        gitBuilt,
      ]),
    ).toBe("0.0.2");
  });

  /**
   * Never "you have unsaved changes". The local copy failing to match proves
   * only that these bytes are not a deployed ARCHIVE — and with an archive
   * version present to compare against, "not deployed" is the honest phrasing.
   * (The git-only case, where even that would overclaim, is covered below.)
   */
  it("says `not deployed`, not `modified`, when an archive version exists", () => {
    const withArchive = [deployed, gitBuilt];
    expect(
      localStateLabel({ digest: "f".repeat(64), matchesSha: null }, withArchive),
    ).toBe("not deployed");
  });

  it("says nothing when there is nothing to pack", () => {
    expect(localStateLabel(null, [deployed])).toBeNull();
  });

  it("falls back to the short digest when the match is off the page", () => {
    // matchesSha can point at a version beyond the 10 the panel shows.
    expect(
      localStateLabel({ digest: "x", matchesSha: "0123456789abcdef" }, []),
    ).toBe("0123456");
  });
});

describe("localStateLabel — nothing comparable", () => {
  /**
   * An agent whose only versions came from git. A commit sha can never equal a
   * content digest, so "not deployed" would be a false accusation against a
   * pristine checkout. Say nothing instead.
   */
  it("stays silent when every version is a git build", () => {
    const gitOnly = [version({ sha: "a".repeat(40), tags: ["0.0.1"] })];
    expect(
      localStateLabel({ digest: "b".repeat(64), matchesSha: null }, gitOnly),
    ).toBeNull();
  });

  it("still says `not deployed` once an archive version exists to compare against", () => {
    const mixed = [
      version({ sha: "a".repeat(40), tags: ["0.0.1"] }),
      version({ sha: "c".repeat(64), tags: ["0.0.2"] }),
    ];
    expect(
      localStateLabel({ digest: "b".repeat(64), matchesSha: null }, mixed),
    ).toBe("not deployed");
  });
});

describe("isContentDigest", () => {
  it("tells a sha256 digest from a git commit sha", () => {
    expect(isContentDigest("a".repeat(64))).toBe(true);
    expect(isContentDigest("a".repeat(40))).toBe(false);
  });
});
