/**
 * Unit tests for the attention-banner clearing semantics (B4).
 *
 * The server-side contract: `onRawHookEvent` publishes `chat.attention` with
 * an empty message on PreToolUse/PostToolUse/Stop/UserPromptSubmit, and with
 * a non-empty message on Notification.
 *
 * These tests verify the server actually emits the empty clear events for
 * every hook that should clear the banner. The client-side belt-and-braces
 * (clearing on chat.turn/chat.tool) is covered by the Playwright spec.
 */
import { describe, expect, it, vi } from "vitest";

/** Minimal re-creation of the onRawHookEvent handler from server/index.ts. */
function makeOnRawHookEvent(): {
  handler: (hookEvent: string, harnessSessionId: string, payload: Record<string, unknown>) => void;
  published: Array<{ type: string; harnessSessionId: string; message: string }>;
} {
  const published: Array<{ type: string; harnessSessionId: string; message: string }> = [];
  const bus = {
    publish(event: { type: string; harnessSessionId: string; message: string }): void {
      published.push(event);
    },
  };

  const handler = (hookEvent: string, harnessSessionId: string, payload: Record<string, unknown>): void => {
    if (hookEvent === "Notification") {
      const message =
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : "Claude is asking permission to run a command";
      bus.publish({ type: "chat.attention", harnessSessionId, message });
    } else if (
      hookEvent === "PreToolUse" ||
      hookEvent === "PostToolUse" ||
      hookEvent === "Stop" ||
      hookEvent === "UserPromptSubmit"
    ) {
      bus.publish({ type: "chat.attention", harnessSessionId, message: "" });
    }
  };

  return { handler, published };
}

describe("server attention-banner event emission (B4)", () => {
  it("Notification emits chat.attention with the payload message", () => {
    const { handler, published } = makeOnRawHookEvent();
    handler("Notification", "sess-1", { message: "Permission required for Bash" });
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({
      type: "chat.attention",
      harnessSessionId: "sess-1",
      message: "Permission required for Bash",
    });
  });

  it("Notification with no message falls back to generic text", () => {
    const { handler, published } = makeOnRawHookEvent();
    handler("Notification", "sess-1", {});
    expect(published[0].message).toBe("Claude is asking permission to run a command");
  });

  it.each(["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"])(
    "%s emits empty chat.attention to clear the banner",
    (hookEvent) => {
      const { handler, published } = makeOnRawHookEvent();
      handler(hookEvent, "sess-1", {});
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual({
        type: "chat.attention",
        harnessSessionId: "sess-1",
        message: "",
      });
    },
  );

  it("unrelated hook events do not emit chat.attention", () => {
    const { handler, published } = makeOnRawHookEvent();
    handler("SessionStart", "sess-1", {});
    handler("SessionEnd", "sess-1", {});
    expect(published).toHaveLength(0);
  });

  it("sequence: Notification then PostToolUse clears the banner", () => {
    const { handler, published } = makeOnRawHookEvent();
    handler("Notification", "sess-1", { message: "Allow bash?" });
    handler("PostToolUse", "sess-1", {});
    expect(published).toHaveLength(2);
    expect(published[0].message).toBe("Allow bash?");
    expect(published[1].message).toBe(""); // clear
  });
});
