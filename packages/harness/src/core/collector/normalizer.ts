/**
 * Raw Claude Code hook payload -> normalized AnalyticsEvent.
 *
 * `userId` / `machineId` / `harness` are never present on the hook payload
 * itself (Claude Code has no idea it's running inside the harness) — they're
 * injected from server-side context resolved by the caller (the session
 * registry, auth state, machine-id file).
 */

import * as crypto from "node:crypto";

import type { AnalyticsEvent, AnalyticsEventType, HarnessKind } from "../../shared/types.js";

/** The six hook names Claude Code invokes; see claude-settings.ts. */
export type ClaudeHookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

/** Loose on purpose — hook payloads vary by event and Claude Code version. */
export type RawHookPayload = Record<string, unknown>;

export interface NormalizeContext {
  userId: string | null;
  tenantId: string | null;
  machineId: string;
  harnessSessionId: string;
  harness: HarnessKind;
  /** Already-known agent session id, if the registry has resolved one yet. */
  agentSessionId: string | null;
  /** Per-harnessSessionId monotonic counter, assigned by the caller (see core/collector/seq.ts). */
  seq: number;
}

const HOOK_TO_TYPE: Partial<Record<ClaudeHookEvent, AnalyticsEventType>> = {
  SessionStart: "session.start",
  UserPromptSubmit: "prompt.submitted",
  PostToolUse: "tool.call",
  Stop: "turn.completed",
  SessionEnd: "session.end",
  // PreToolUse has no dedicated analytics event today; it's still registered
  // as a hook (see claude-settings.ts) so a future correctness check can
  // compare pre/post firing without a settings-file change.
};

const MAX_FIELD_LENGTH = 4000;
/** Tool output can be much larger than other fields; cap it separately. */
const MAX_TOOL_RESPONSE_LENGTH = 16 * 1024;

/** Stringify + truncate a value so a giant tool payload can't blow up storage. */
export function truncateForPayload(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}…[truncated ${str.length - maxLength} chars]`;
}

function stringField(payload: RawHookPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function buildEventPayload(
  hookEvent: ClaudeHookEvent,
  hookPayload: RawHookPayload,
): Record<string, unknown> {
  switch (hookEvent) {
    case "SessionStart":
      return {
        source: stringField(hookPayload, "source") ?? null,
        cwd: stringField(hookPayload, "cwd") ?? null,
      };
    case "UserPromptSubmit":
      return {
        prompt: stringField(hookPayload, "prompt") ?? "",
      };
    case "PostToolUse":
      return {
        toolName: stringField(hookPayload, "tool_name") ?? null,
        toolInput: truncateForPayload(hookPayload.tool_input),
        toolResponseSummary: truncateForPayload(hookPayload.tool_response, MAX_TOOL_RESPONSE_LENGTH),
      };
    case "Stop":
      return {
        stopHookActive: hookPayload.stop_hook_active === true,
      };
    case "SessionEnd":
      return {
        reason: stringField(hookPayload, "reason") ?? null,
      };
    case "PreToolUse":
      return {};
    default:
      return {};
  }
}

/**
 * Normalize one Claude Code hook invocation into an AnalyticsEvent, or
 * `null` when the hook doesn't map to an analytics event (PreToolUse, or an
 * unrecognized hook name).
 */
export function normalizeHookEvent(
  hookEvent: string,
  hookPayload: RawHookPayload,
  context: NormalizeContext,
): AnalyticsEvent | null {
  const type = HOOK_TO_TYPE[hookEvent as ClaudeHookEvent];
  if (!type) return null;

  const agentSessionId = stringField(hookPayload, "session_id") ?? context.agentSessionId;

  return {
    eventId: crypto.randomUUID(),
    seq: context.seq,
    ts: new Date().toISOString(),
    userId: context.userId,
    tenantId: context.tenantId,
    machineId: context.machineId,
    harnessSessionId: context.harnessSessionId,
    agentSessionId,
    harness: context.harness,
    type,
    payload: buildEventPayload(hookEvent as ClaudeHookEvent, hookPayload),
  };
}
