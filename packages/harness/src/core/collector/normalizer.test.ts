import { describe, expect, it } from "vitest";

import { normalizeHookEvent, truncateForPayload } from "./normalizer.js";
import type { NormalizeContext } from "./normalizer.js";

const baseContext: NormalizeContext = {
  userId: "user-123",
  tenantId: "tenant-123",
  machineId: "machine-abc",
  harnessSessionId: "harness-session-1",
  harness: "claude-code",
  agentSessionId: null,
  seq: 1,
};

describe("normalizeHookEvent", () => {
  it("normalizes SessionStart and captures the agent session id", () => {
    const event = normalizeHookEvent(
      "SessionStart",
      { session_id: "agent-uuid-1", cwd: "/tmp/project", source: "startup" },
      baseContext,
    );

    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.start");
    expect(event?.agentSessionId).toBe("agent-uuid-1");
    expect(event?.harnessSessionId).toBe("harness-session-1");
    expect(event?.userId).toBe("user-123");
    expect(event?.tenantId).toBe("tenant-123");
    expect(event?.machineId).toBe("machine-abc");
    expect(event?.harness).toBe("claude-code");
    expect(event?.seq).toBe(1);
    expect(event?.payload).toEqual({ source: "startup", cwd: "/tmp/project" });
    expect(typeof event?.eventId).toBe("string");
    expect(typeof event?.ts).toBe("string");
  });

  it("passes the caller-assigned seq straight through", () => {
    const context = { ...baseContext, seq: 42 };
    const event = normalizeHookEvent("SessionEnd", { session_id: "agent-uuid-1" }, context);
    expect(event?.seq).toBe(42);
  });

  it("normalizes UserPromptSubmit", () => {
    const context = { ...baseContext, agentSessionId: "agent-uuid-1" };
    const event = normalizeHookEvent(
      "UserPromptSubmit",
      { session_id: "agent-uuid-1", prompt: "build me a workflow" },
      context,
    );

    expect(event?.type).toBe("prompt.submitted");
    expect(event?.payload).toEqual({ prompt: "build me a workflow" });
    expect(event?.agentSessionId).toBe("agent-uuid-1");
  });

  it("returns null for PreToolUse (no dedicated analytics event)", () => {
    const event = normalizeHookEvent(
      "PreToolUse",
      { session_id: "agent-uuid-1", tool_name: "Bash", tool_input: { command: "ls" } },
      baseContext,
    );

    expect(event).toBeNull();
  });

  it("normalizes PostToolUse to tool.call and truncates large fields", () => {
    const hugeOutput = "x".repeat(20_000);
    const event = normalizeHookEvent(
      "PostToolUse",
      {
        session_id: "agent-uuid-1",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_response: hugeOutput,
      },
      baseContext,
    );

    expect(event?.type).toBe("tool.call");
    expect(event?.payload.toolName).toBe("Bash");
    expect(event?.payload.toolInput).toBe(JSON.stringify({ command: "ls -la" }));
    expect(typeof event?.payload.toolResponseSummary).toBe("string");
    expect((event?.payload.toolResponseSummary as string).length).toBeLessThan(hugeOutput.length);
    expect(event?.payload.toolResponseSummary).toContain("[truncated");
  });

  it("keeps toolResponseSummary under a shorter output intact (below the 16KB cap)", () => {
    const event = normalizeHookEvent(
      "PostToolUse",
      { session_id: "agent-uuid-1", tool_name: "Bash", tool_response: "short output" },
      baseContext,
    );
    expect(event?.payload.toolResponseSummary).toBe("short output");
  });

  it("normalizes Stop to turn.completed, with no assistantText when the hook omits it", () => {
    const event = normalizeHookEvent(
      "Stop",
      { session_id: "agent-uuid-1", stop_hook_active: true },
      baseContext,
    );

    expect(event?.type).toBe("turn.completed");
    expect(event?.payload).toEqual({ stopHookActive: true, assistantText: null });
  });

  it("normalizes Stop and captures last_assistant_message as assistantText directly off the hook payload", () => {
    // Claude Code's real Stop payload carries this field itself — the
    // transcript file may not exist on disk yet (or ever) when Stop fires,
    // so this must not depend on any file read.
    const event = normalizeHookEvent(
      "Stop",
      { session_id: "agent-uuid-1", stop_hook_active: false, last_assistant_message: "HARNESS OK" },
      baseContext,
    );

    expect(event?.payload).toEqual({ stopHookActive: false, assistantText: "HARNESS OK" });
  });

  it("normalizes SessionEnd", () => {
    const event = normalizeHookEvent(
      "SessionEnd",
      { session_id: "agent-uuid-1", reason: "exit" },
      baseContext,
    );

    expect(event?.type).toBe("session.end");
    expect(event?.payload).toEqual({ reason: "exit" });
  });

  it("returns null for unrecognized hook names", () => {
    const event = normalizeHookEvent("SomethingElse", {}, baseContext);
    expect(event).toBeNull();
  });

  it("falls back to context.agentSessionId when the hook payload omits session_id", () => {
    const context = { ...baseContext, agentSessionId: "already-known" };
    const event = normalizeHookEvent("SessionEnd", { reason: "exit" }, context);
    expect(event?.agentSessionId).toBe("already-known");
  });
});

describe("truncateForPayload", () => {
  it("passes short strings through unchanged", () => {
    expect(truncateForPayload("hello")).toBe("hello");
  });

  it("stringifies non-string values", () => {
    expect(truncateForPayload({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });

  it("truncates long strings with a marker", () => {
    const long = "y".repeat(20);
    const result = truncateForPayload(long, 10);
    expect(result.startsWith("y".repeat(10))).toBe(true);
    expect(result).toContain("[truncated 10 chars]");
  });
});
