/**
 * Where an agent verb goes (pure): the one decision behind every button that
 * acts on an agent — the canvas Visualize and render-error Retry, a failed
 * task's Retry, Deploy, Run locally, Run, Describe with AI, and the inject
 * macros.
 *
 * Every route is addressed by the agent's path and none names a session
 * (design-map-chat.md I3; flow-map-chat-overlay.md 4.4b). Before this, each
 * verb bound the agent to a live session (or started one) and bailed without
 * one, because Visualize rendered into the bound session's cwd and runs were
 * filed under the session. Neither holds now: the canvas is read from
 * `GET /api/workflows/:path/graph`, and runs are keyed by agent path.
 */
import type { MacroDef, WorkflowInfo } from "@shared/types";

import type { AgentMacroKind } from "./agent-session-macro";
import { directActionKind } from "./macro-actions";
import { resolveMacroUrl } from "./macro-gating";
import {
  isWorkflowRunnable,
  prodRunBlockedToast,
  workflowDeploymentState,
} from "./workflow-deployment";

export type AgentVerbRoute =
  | { kind: "open-url"; url: string }
  | { kind: "deploy"; agentPath: string }
  /** `definitionId` as the runs route wants it: a string. */
  | { kind: "prod-run"; agentPath: string; definitionId: string }
  | { kind: "run-local"; agentPath: string }
  /** Re-read the agent's graph route; the extraction is deterministic, so a
   *  refetch IS the re-render (no LLM, no session). */
  | { kind: "reload-graph"; agentPath: string }
  /** A new unbound project-root session whose first message is `text`,
   *  tuned to `job` (agent-session-macro.ts). */
  | { kind: "session-macro"; job: AgentMacroKind; text: string }
  /** Nothing runs; the reason is shown, never swallowed. */
  | { kind: "refuse"; reason: string };

/**
 * An inject macro's text with the agent's own placeholders filled. The server
 * filled these (and the session's) when the text was typed into a bound pty;
 * a macro session has no binding, so the agent's values are written in here
 * and the session-only ones (`{{session.cwd}}`, `{{canvas.path}}`) are left
 * for the reader, as the server leaves an unknown token.
 */
function fillAgentPlaceholders(text: string, workflow: WorkflowInfo): string {
  const values: Record<string, string> = {
    path: workflow.path,
    name: workflow.name,
    definitionId: String(workflow.definitionId ?? ""),
  };
  // The macro registry's own token names (src/core/macro-runner.ts).
  return text
    .replace(/\{\{workflow\.(path|name|definitionId)\}\}/g, (_, key: string) => values[key])
    .replaceAll("{{subject}}", "");
}

export function agentVerbRoute(
  macro: MacroDef,
  workflow: WorkflowInfo | null,
  lastDeployError: string | null = null,
): AgentVerbRoute {
  if (macro.action.kind === "open-url")
    return { kind: "open-url", url: resolveMacroUrl(macro.action.url, workflow) };
  const direct = directActionKind(macro.id);
  if (!workflow)
    return {
      kind: "refuse",
      // Run's reason without an agent is the draft one, as before.
      reason: direct === "prod-run" ? prodRunBlockedToast("draft") : "Select an agent first.",
    };
  const agentPath = workflow.path;
  if (direct === "deploy") return { kind: "deploy", agentPath };
  if (direct === "run-local") return { kind: "run-local", agentPath };
  if (direct === "prod-run") {
    // Keyboard and programmatic calls reach here past a disabled button.
    if (workflow.definitionId != null && isWorkflowRunnable(workflow))
      return { kind: "prod-run", agentPath, definitionId: String(workflow.definitionId) };
    return {
      kind: "refuse",
      reason: prodRunBlockedToast(workflowDeploymentState(workflow, lastDeployError)),
    };
  }
  if (macro.action.kind === "render-canvas") return { kind: "reload-graph", agentPath };
  if (macro.id === "describe") return { kind: "session-macro", job: "describe", text: "" };
  return {
    kind: "session-macro",
    job: "ask",
    text: fillAgentPlaceholders(macro.action.text, workflow),
  };
}
