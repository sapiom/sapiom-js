import { Buffer } from "node:buffer";

import {
  AGENT_MAP_UUID_V7_PATTERN,
  hasAgentMapControlCharacter,
} from "./agent-map-codec.js";
import { canonicalDigest, canonicalJson } from "./agent-map-canonical.js";
import {
  parseAgentBriefVersionRef,
  parseAgentMapVersionRef,
  parseProjectBuildPlanVersionRef,
} from "./build-plan-codec.js";
import {
  PROJECT_SUBSESSION_DELEGATION_LIMIT,
  PROJECT_SUBSESSION_KEY_BYTES,
  PROJECT_SUBSESSION_KICKOFF_CONTEXT_BYTES,
  PROJECT_SUBSESSION_OUTCOME_BYTES,
  PROJECT_SUBSESSION_REQUEST_BYTES,
  PROJECT_SUBSESSION_SCHEMA_VERSION,
  type CanonicalDelegationBindingDigest,
  type CanonicalDelegationRequestDigest,
  type DelegationFocusRef,
  type ProjectSubsessionDelegation,
  type ProjectSubsessionRequest,
  type SubsessionContextDigest,
} from "./subsession-delegation.js";

export interface SubsessionDelegationValidationIssue {
  path: string;
  code: string;
}

export class SubsessionDelegationValidationError extends Error {
  readonly code: "invalid_request" | "unsupported_schema" | "capacity_exceeded";
  readonly issues: readonly SubsessionDelegationValidationIssue[];

  constructor(
    code: "invalid_request" | "unsupported_schema" | "capacity_exceeded",
    issues: readonly SubsessionDelegationValidationIssue[],
  ) {
    super("Project subsession request is invalid");
    this.name = "SubsessionDelegationValidationError";
    this.code = code;
    this.issues = issues.slice(0, 32).map(({ path, code: issueCode }) => ({
      path: path.slice(0, 256),
      code: issueCode.slice(0, 128),
    }));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key));
};

const normalizeText = (value: string): string =>
  value.normalize("NFC").replace(/\r\n?/gu, "\n");

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const isKey = (value: unknown): value is string =>
  typeof value === "string" &&
  byteLength(value) >= 1 &&
  byteLength(value) <= PROJECT_SUBSESSION_KEY_BYTES &&
  /^[A-Za-z0-9._-]+$/u.test(value);

const isPromptText = (
  value: unknown,
  maximumBytes: number,
): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  byteLength(normalizeText(value)) <= maximumBytes &&
  ![...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return hasAgentMapControlCharacter(character) &&
      point !== 0x09 && point !== 0x0a && point !== 0x0d;
  });

const id = (value: unknown, prefix: string): value is string =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_${AGENT_MAP_UUID_V7_PATTERN}$`, "u").test(value);

const digest = (value: unknown): value is SubsessionContextDigest =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);

function invalid(path: string, code: string): never {
  throw new SubsessionDelegationValidationError("invalid_request", [
    { path, code },
  ]);
}

function parseFocus(
  value: unknown,
  expectedProjectId: string,
  path: string,
): DelegationFocusRef {
  if (!isRecord(value) || typeof value.kind !== "string")
    return invalid(path, "invalid_focus");
  try {
    if (
      value.kind === "assignment" &&
      hasExactKeys(value, ["kind", "map", "plan", "assignmentId"]) &&
      id(value.assignmentId, "work")
    ) {
      return {
        kind: "assignment",
        map: parseAgentMapVersionRef(value.map, expectedProjectId),
        plan: parseProjectBuildPlanVersionRef(value.plan, expectedProjectId),
        assignmentId: value.assignmentId,
      } as DelegationFocusRef;
    }
    if (
      value.kind === "map-node" &&
      hasExactKeys(value, ["kind", "map", "plan", "nodeId"]) &&
      id(value.nodeId, "node")
    ) {
      return {
        kind: "map-node",
        map: parseAgentMapVersionRef(value.map, expectedProjectId),
        plan:
          value.plan === null
            ? null
            : parseProjectBuildPlanVersionRef(value.plan, expectedProjectId),
        nodeId: value.nodeId,
      } as DelegationFocusRef;
    }
    if (
      value.kind === "brief" &&
      hasExactKeys(value, ["kind", "brief"])
    ) {
      return {
        kind: "brief",
        brief: parseAgentBriefVersionRef(value.brief, expectedProjectId),
      };
    }
  } catch {
    // Collapse codec detail into the bounded public issue below.
  }
  return invalid(path, "invalid_or_cross_project_focus");
}

function parseDelegation(
  value: unknown,
  expectedProjectId: string,
  index: number,
): ProjectSubsessionDelegation {
  const path = `operation.delegations[${index}]`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["delegationKey", "outcome"], [
      "kickoffContext",
      "focus",
    ]) ||
    !isKey(value.delegationKey) ||
    !isPromptText(value.outcome, PROJECT_SUBSESSION_OUTCOME_BYTES) ||
    (value.kickoffContext !== undefined &&
      !isPromptText(
        value.kickoffContext,
        PROJECT_SUBSESSION_KICKOFF_CONTEXT_BYTES,
      ))
  ) {
    return invalid(path, "invalid_delegation");
  }
  return {
    delegationKey: normalizeText(value.delegationKey),
    outcome: normalizeText(value.outcome),
    ...(value.kickoffContext === undefined
      ? {}
      : { kickoffContext: normalizeText(value.kickoffContext) }),
    ...(value.focus === undefined
      ? {}
      : { focus: parseFocus(value.focus, expectedProjectId, `${path}.focus`) }),
  };
}

export function parseProjectSubsessionRequest(
  value: unknown,
  expectedProjectId: string,
): ProjectSubsessionRequest {
  if (!isRecord(value)) invalid("$", "expected_object");
  if (value.schemaVersion !== PROJECT_SUBSESSION_SCHEMA_VERSION) {
    throw new SubsessionDelegationValidationError("unsupported_schema", [
      { path: "schemaVersion", code: "unsupported_schema" },
    ]);
  }
  if (
    !hasExactKeys(value, ["schemaVersion", "requestKey", "operation"]) ||
    !isKey(value.requestKey) ||
    !isRecord(value.operation) ||
    typeof value.operation.kind !== "string"
  ) {
    return invalid("$", "invalid_envelope");
  }

  let operation: ProjectSubsessionRequest["operation"];
  if (
    value.operation.kind === "delegate" &&
    hasExactKeys(value.operation, ["kind", "delegations"]) &&
    Array.isArray(value.operation.delegations)
  ) {
    if (
      value.operation.delegations.length < 1 ||
      value.operation.delegations.length > PROJECT_SUBSESSION_DELEGATION_LIMIT
    ) {
      throw new SubsessionDelegationValidationError("capacity_exceeded", [
        { path: "operation.delegations", code: "delegation_count" },
      ]);
    }
    const delegations = value.operation.delegations
      .map((entry, index) => parseDelegation(entry, expectedProjectId, index))
      .sort((left, right) =>
        left.delegationKey < right.delegationKey
          ? -1
          : left.delegationKey > right.delegationKey
            ? 1
            : 0,
      );
    if (
      new Set(delegations.map(({ delegationKey }) => delegationKey)).size !==
      delegations.length
    ) {
      return invalid("operation.delegations", "duplicate_delegation_key");
    }
    operation = { kind: "delegate", delegations };
  } else if (
    value.operation.kind === "refresh-focused-context" &&
    hasExactKeys(value.operation, [
      "kind",
      "target",
      "expectedContextEpoch",
      "expectedContextDigest",
      "focus",
    ]) &&
    isRecord(value.operation.target) &&
    Number.isSafeInteger(value.operation.expectedContextEpoch) &&
    (value.operation.expectedContextEpoch as number) > 0 &&
    digest(value.operation.expectedContextDigest)
  ) {
    let target: Extract<
      ProjectSubsessionRequest["operation"],
      { kind: "refresh-focused-context" }
    >["target"];
    if (
      value.operation.target.kind === "self" &&
      hasExactKeys(value.operation.target, ["kind"])
    ) {
      target = { kind: "self" };
    } else if (
      value.operation.target.kind === "child" &&
      hasExactKeys(value.operation.target, ["kind", "delegationKey"]) &&
      isKey(value.operation.target.delegationKey)
    ) {
      target = {
        kind: "child",
        delegationKey: normalizeText(value.operation.target.delegationKey),
      };
    } else {
      return invalid("operation.target", "invalid_target");
    }
    operation = {
      kind: "refresh-focused-context",
      target,
      expectedContextEpoch: value.operation.expectedContextEpoch as number,
      expectedContextDigest: value.operation.expectedContextDigest,
      focus:
        value.operation.focus === null
          ? null
          : parseFocus(
              value.operation.focus,
              expectedProjectId,
              "operation.focus",
            ),
    };
  } else {
    return invalid("operation", "invalid_operation");
  }

  const parsed: ProjectSubsessionRequest = {
    schemaVersion: PROJECT_SUBSESSION_SCHEMA_VERSION,
    requestKey: normalizeText(value.requestKey),
    operation,
  };
  if (byteLength(canonicalJson(parsed)) > PROJECT_SUBSESSION_REQUEST_BYTES) {
    throw new SubsessionDelegationValidationError("capacity_exceeded", [
      { path: "$", code: "request_bytes" },
    ]);
  }
  return parsed;
}

export function computeCanonicalDelegationRequestDigest(
  request: ProjectSubsessionRequest,
): CanonicalDelegationRequestDigest {
  return canonicalDigest(
    "sapiom.project-subsession.request.v1",
    request,
  ) as CanonicalDelegationRequestDigest;
}

export function computeCanonicalDelegationBindingDigest(
  delegation: ProjectSubsessionDelegation,
): CanonicalDelegationBindingDigest {
  return canonicalDigest(
    "sapiom.project-subsession.binding.v1",
    delegation,
  ) as CanonicalDelegationBindingDigest;
}

export function computeSubsessionContextDigest(
  focus: DelegationFocusRef | null,
): SubsessionContextDigest {
  return canonicalDigest(
    "sapiom.project-subsession.context.v1",
    focus,
  ) as SubsessionContextDigest;
}

