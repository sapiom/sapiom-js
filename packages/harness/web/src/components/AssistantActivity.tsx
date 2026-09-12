import type { JSX } from "react";
import type { AssistantProjection } from "../lib/assistant-state";
import { Icon } from "./Icon";

/** Only decorate an existing Studio session; summaries never create navigation. */
export function AssistantActivity({
  assistant,
  sessionId,
}: {
  assistant?: AssistantProjection;
  sessionId: string;
}): JSX.Element | null {
  const summary = assistant?.snapshot?.enabled
    ? assistant.snapshot.sessions.find(
        (row) => row.harnessSessionId === sessionId,
      )
    : undefined;
  if (!summary) return null;
  const state = !assistant?.current
    ? "checking"
    : summary.freshness === "unavailable"
      ? "unavailable"
      : summary.freshness !== "current" ||
          summary.activity === "unknown" ||
          summary.pendingPermissions === null ||
          summary.pendingQuestions === null
        ? "checking"
        : summary.pendingPermissions > 0 || summary.pendingQuestions > 0
          ? "waiting"
          : summary.activity === "busy" || summary.activity === "retry"
            ? "working"
            : null;
  if (!state) return null;
  const label = {
    checking: "Assistant: Checking status",
    unavailable: "Assistant: Unavailable",
    waiting: "Assistant: Waiting for input",
    working: "Assistant: Working",
  }[state];
  return (
    <span
      className="assistant-activity"
      data-state={state}
      data-testid={`assistant-activity-${sessionId}`}
      role="img"
      aria-label={label}
      title={label}
      data-tooltip={label}
    >
      <Icon
        name={
          state === "waiting"
            ? "MessageSquare"
            : state === "unavailable"
              ? "TriangleAlert"
              : state === "checking"
                ? "CloudOff"
                : "Loader"
        }
        size={12}
      />
    </span>
  );
}
