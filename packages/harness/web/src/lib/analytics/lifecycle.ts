import type { WorkflowInfo } from "@shared/types";

/**
 * Pure helpers behind the agent-lifecycle product events (`agent.created`,
 * `agent.deploy_*`). Kept framework- and PostHog-free so the App effect / store
 * stay thin wrappers and the counting logic is unit-testable in Node.
 *
 * Privacy: a slug is a folder name or a deployed slug — NEVER the absolute
 * path, which would leak the user's directory layout. See analytics/events.ts.
 */

/**
 * The last path segment — the low-cardinality slug we attach as `workflow_slug`
 * instead of the absolute path. Tolerant of either separator and trailing
 * slashes; falls back to the input if there is nothing to slice.
 */
export function slugFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The paths present in `workflows` that are not yet in `seen` — the agents that
 * have newly appeared since the last snapshot. The caller seeds `seen` on first
 * load (so pre-existing agents never count) and adds the returned paths after
 * emitting, so each agent is counted exactly once per app run.
 */
export function newAgentPaths(
  seen: ReadonlySet<string>,
  workflows: readonly Pick<WorkflowInfo, "path">[],
): string[] {
  const fresh: string[] = [];
  for (const w of workflows) {
    if (!seen.has(w.path)) fresh.push(w.path);
  }
  return fresh;
}

/**
 * A coarse, message-free failure enum for `agent.deploy_failed`. A deploy fails
 * either while creating the remote agent (`linking`) or while building it
 * (`building`); an error thrown out of the stream (network, etc.) is
 * `exception`. Never a raw message — the privacy rule forbids it.
 */
export function deployErrorKind(
  lastNonTerminalPhase: "linking" | "building" | null,
  isException: boolean,
): "link_failed" | "build_failed" | "exception" {
  if (isException) return "exception";
  return lastNonTerminalPhase === "linking" ? "link_failed" : "build_failed";
}

/** The provenance bucket carried as `source` on the lifecycle events. */
export type AgentSource = "template" | "starter" | "fork" | "scratch";

/**
 * The marker-derived provenance subset of WorkflowInfo. Deliberately excludes
 * `WorkflowInfo["source"]` ("scan"/"connect" — how the REGISTRY learned of the
 * path), which is a different dimension from the event `source` computed here.
 */
type ProvenanceFields = Pick<WorkflowInfo, "templateId" | "forkId" | "starterId">;

/** Only a non-empty string counts — the marker is user-editable JSON that the
 *  server casts wholesale, and events.ts promises ids stay strings. */
function asId(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Which provenance bucket a project falls in, from its sapiom.json fields.
 * Order matters: a gallery clone writes `templateId` AND `forkId`, so template
 * must win over fork; `starterId === "default"` is the bare/from-scratch
 * scaffold marker, not a named starter. No fields at all is `scratch` too —
 * that covers agents that predate provenance (and older harness servers).
 */
export function agentSource(workflow: ProvenanceFields): AgentSource {
  if (asId(workflow.templateId)) return "template";
  const starter = asId(workflow.starterId);
  if (starter && starter !== "default") return "starter";
  if (asId(workflow.forkId)) return "fork";
  return "scratch";
}

/**
 * The spreadable `source`/`template_id` payload fragment for the lifecycle
 * events. `template_id` is the public id of what the agent was made from —
 * gallery template id or bundled starter id; omitted for fork (a fork id is a
 * per-user record id, useless for breakdowns) and scratch. `{}` when the
 * registry entry wasn't found at all: an absent property reads "(not set)" in
 * PostHog and points at a wiring bug instead of silently inflating `scratch`.
 */
export function agentProvenance(
  workflow: ProvenanceFields | null | undefined,
): { source?: AgentSource; template_id?: string } {
  if (!workflow) return {};
  const source = agentSource(workflow);
  if (source === "template") return { source, template_id: asId(workflow.templateId) };
  if (source === "starter") return { source, template_id: asId(workflow.starterId) };
  return { source };
}
