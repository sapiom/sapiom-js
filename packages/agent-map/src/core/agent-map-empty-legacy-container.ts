import type { StudioProjectId } from "../shared/agent-map.js";
import {
  createEmptyProjectPlanningAggregate,
  parseLegacyWorkspaceState,
  type AgentMapProjectAggregate,
} from "./agent-map-aggregate-migration.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const emptyArray = (value: unknown) =>
  Array.isArray(value) && value.length === 0;
const emptyObject = (value: unknown) =>
  isRecord(value) && Object.keys(value).length === 0;

const originalKeys = [
  "schemaVersion",
  "planId",
  "currentPlanVersion",
  "planVersions",
  "currentBriefByAgentId",
  "briefVersionsById",
  "assignmentByAgentId",
  "submissionsByAssignmentId",
  "idempotencyReceipts",
];
const tombstoneKeys = [...originalKeys, "idempotencyTombstones"];
const fanoutKeys = [
  ...tombstoneKeys,
  "fanoutApprovals",
  "builderBindingsByAssignmentId",
  "planningSubmissionReceipts",
];
// Exact persisted shapes from 42233439, 61a4a1c3, 74051316, and 9f82bd15.
// Missing additions were defaulted together by the old writers. Arbitrary
// optional-field combinations are not evidence of an unused container.
const historicalKeys = [
  originalKeys,
  tombstoneKeys,
  fanoutKeys,
  [...fanoutKeys, "fanoutConsents"],
];
const arrayKeys = new Set([
  "planVersions",
  "idempotencyReceipts",
  "idempotencyTombstones",
  "fanoutApprovals",
  "planningSubmissionReceipts",
  "fanoutConsents",
]);

/** A compatibility conversion, separate from the outer-format-1 reset.
 * Only records provably identical to an old store's initial state qualify.
 * Higher revisions, cleared maps, unknown fields and authored history do not. */
export function convertEmptyLegacyContainer(
  value: unknown,
  projectId: StudioProjectId,
): AgentMapProjectAggregate | null {
  if (
    !isRecord(value) ||
    value.storageSchemaVersion !== 2 ||
    !exact(value, [
      "storageSchemaVersion",
      "workspace",
      "proposal",
      "receipts",
      "buildPlanning",
    ]) ||
    value.proposal !== null ||
    !emptyArray(value.receipts) ||
    !isRecord(value.buildPlanning)
  )
    return null;
  let workspace;
  try {
    workspace = parseLegacyWorkspaceState(value.workspace, projectId);
  } catch {
    return null;
  }
  if (
    workspace.recordVersion !== 1 ||
    workspace.createdAt !== workspace.updatedAt ||
    workspace.confirmedRevisionId !== null ||
    workspace.activeProposalId !== null ||
    workspace.projectBuildPlanId !== null
  )
    return null;

  const planning = value.buildPlanning;
  if (
    !historicalKeys.some((keys) => exact(planning, keys)) ||
    planning.schemaVersion !== 1 ||
    planning.planId !== null ||
    planning.currentPlanVersion !== null
  )
    return null;
  for (const [key, entry] of Object.entries(planning)) {
    if (["schemaVersion", "planId", "currentPlanVersion"].includes(key))
      continue;
    if (!(arrayKeys.has(key) ? emptyArray(entry) : emptyObject(entry)))
      return null;
  }
  return createEmptyProjectPlanningAggregate(
    projectId,
    workspace.createdAt,
    workspace.recordVersion,
  );
}
