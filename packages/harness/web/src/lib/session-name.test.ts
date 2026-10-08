import { describe, expect, it } from "vitest";
import type { HarnessSession } from "@shared/types";

import { sessionDisplayName } from "./session-name";

const session = (over: Partial<HarnessSession>): HarnessSession => ({
  id: "s1",
  agentSessionId: null,
  boundWorkflowPath: null,
  harness: "claude-code",
  cwd: "/Users/demo/acme-app",
  title: "acme-app",
  agentMapIdentity: {
    projectId: "project_00000000-0000-4000-8000-000000000001",
    userId: "user_test",
    sessionId: "s1",
  },
  status: "running",
  createdAt: "2026-07-20T10:00:00.000Z",
  lastActiveAt: "2026-07-20T10:00:00.000Z",
  ready: true,
  ...over,
});

describe("sessionDisplayName", () => {
  it("shows the persisted title, which defaults to the folder basename", () => {
    expect(sessionDisplayName(session({}), {})).toBe("acme-app");
    expect(
      sessionDisplayName(session({ title: "Build the leasing pipeline" }), {}),
    ).toBe("Build the leasing pipeline");
  });

  it("keeps the server-assigned ordinal whatever its siblings do", () => {
    const first = session({ id: "s1" });
    const second = session({ id: "s2", title: "acme-app 2" });
    expect(sessionDisplayName(second, {})).toBe("acme-app 2");
    expect(sessionDisplayName({ ...first, status: "exited" }, {})).toBe(
      "acme-app",
    );
    expect(sessionDisplayName(second, {})).toBe("acme-app 2");
  });

  it("a user rename beats everything and empties back to the title", () => {
    const s = session({ title: "Build the leasing pipeline" });
    expect(sessionDisplayName(s, { s1: "Leasing revamp" })).toBe(
      "Leasing revamp",
    );
    expect(sessionDisplayName(s, { s1: "  " })).toBe(
      "Build the leasing pipeline",
    );
  });

  it("falls back to the cwd basename for a record with no title", () => {
    expect(sessionDisplayName(session({ title: "" }), {})).toBe("acme-app");
    expect(
      sessionDisplayName(
        session({ title: "", cwd: "C:\\Users\\demo\\acme-app" }),
        {},
      ),
    ).toBe("acme-app");
  });
});
