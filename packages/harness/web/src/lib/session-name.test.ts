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
  status: "running",
  createdAt: "2026-07-20T10:00:00.000Z",
  lastActiveAt: "2026-07-20T10:00:00.000Z",
  ready: true,
  ...over,
});

describe("sessionDisplayName", () => {
  it("defaults to the workspace folder basename, never the agent kind", () => {
    const s = session({});
    expect(sessionDisplayName(s, [s], {})).toBe("acme-app");
  });

  it("counts up only among same-folder sessions still on the default", () => {
    const first = session({ id: "s1", createdAt: "2026-07-20T09:00:00.000Z" });
    const second = session({ id: "s2", createdAt: "2026-07-20T10:00:00.000Z" });
    const all = [first, second];
    expect(sessionDisplayName(first, all, {})).toBe("acme-app");
    expect(sessionDisplayName(second, all, {})).toBe("acme-app 2");
  });

  it("a sibling with a transcript title never pushes the default to 'folder 2'", () => {
    const titled = session({ id: "s1", title: "Build the leasing pipeline", createdAt: "2026-07-20T09:00:00.000Z" });
    const untitled = session({ id: "s2", createdAt: "2026-07-20T10:00:00.000Z" });
    const all = [titled, untitled];
    expect(sessionDisplayName(titled, all, {})).toBe("Build the leasing pipeline");
    expect(sessionDisplayName(untitled, all, {})).toBe("acme-app");
  });

  it("a user rename beats everything and empties back to the default", () => {
    const s = session({ title: "Build the leasing pipeline" });
    expect(sessionDisplayName(s, [s], { s1: "Leasing revamp" })).toBe("Leasing revamp");
    expect(sessionDisplayName(s, [s], { s1: "  " })).toBe("Build the leasing pipeline");
  });

  it("sessions in different folders never collide", () => {
    const a = session({ id: "s1", cwd: "/Users/demo/acme-app", title: "acme-app" });
    const b = session({ id: "s2", cwd: "/Users/demo/scratch", title: "scratch" });
    const all = [a, b];
    expect(sessionDisplayName(a, all, {})).toBe("acme-app");
    expect(sessionDisplayName(b, all, {})).toBe("scratch");
  });
});
