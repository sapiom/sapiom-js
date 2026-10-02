/** Pure mapping from a Linear issue's state to what Sylon does about it. */
import type { LinearIssue } from "../../_shared/linear";

export type Resolution = "done" | "canceled";

/**
 * `get_issue` returns `statusType` (Linear's workflow state type: triage, backlog, unstarted,
 * started, completed, canceled) beside the team-specific `status` name. The type is authoritative;
 * the name is read only when a reply carries no type.
 */
export function resolution(
  linear: Pick<LinearIssue, "status" | "statusType">,
): Resolution | null {
  const type = linear.statusType?.toLowerCase();
  if (type === "completed") return "done";
  if (type === "canceled" || type === "cancelled") return "canceled";
  if (type) return null;
  const name = linear.status?.toLowerCase();
  if (name === "done") return "done";
  if (name === "canceled" || name === "cancelled") return "canceled";
  return null;
}

/** Key of the triage post for one resolution of one Linear issue; the base of every dedup key. */
export const syncKey = (
  issueId: string,
  identifier: string,
  r: Resolution,
): string => `linear-sync:${issueId}:${identifier}:${r}`;
