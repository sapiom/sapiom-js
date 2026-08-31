/**
 * Boundary adapter from caller-scoped, syntax-only invocation scans to the
 * package-scoped graph-evidence protocol and the existing public graph DTO.
 * Scanner cache state remains private input; only validated evidence is
 * eligible for projection.
 */
import { createHash } from "node:crypto";

import {
  advancePackageGraphStaticEvidenceState,
  createPackageGraphEvidenceStaticResult,
  projectPackageGraphEvidence,
  type PackageGraphEvidenceCoverageGap,
  type PackageGraphEvidenceDiagnostic,
  type PackageGraphEvidenceDigest,
  type PackageGraphEvidenceProducer,
  type PackageGraphEvidenceStaticResult,
  type PackageGraphStaticEvidenceCandidate,
  type PackageGraphStaticEvidenceState,
  type PackageInventory,
} from "@sapiom/agent";

import type {
  GraphWarning,
  StaticInvocationGraphEdge,
} from "../shared/system-graph.js";
import type { SourceEvidence } from "./canvas-interconnections.js";
import type { AgentInventoryItem } from "./system-graph-inventory.js";
import type { AgentInvocationProviderResult } from "./system-graph-relationships.js";

export const DIRECT_INVOCATION_EVIDENCE_PRODUCER = {
  id: "sapiom.harness.direct-invocation",
  version: "1.0.0",
} as const satisfies PackageGraphEvidenceProducer;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface DirectInvocationScan {
  caller: AgentInventoryItem;
  result: AgentInvocationProviderResult;
  failed: boolean;
  pending: boolean;
}

export interface DirectInvocationEvidenceAdaptation {
  /** The latest producer attempt, including deterministic diagnostics. */
  latestResult: PackageGraphEvidenceStaticResult;
  /** Reference last-good state retained by the workspace builder. */
  state: PackageGraphStaticEvidenceState;
  /** Existing path-free V0 projection derived only from accepted evidence. */
  edges: StaticInvocationGraphEdge[];
  warnings: GraphWarning[];
  /** True when the analyzed static subset is settled and safe to cache. */
  cacheable: boolean;
  /** True only when no static topology path remains unresolved. */
  complete: boolean;
}

type Resolution =
  | { kind: "resolved"; target: AgentInventoryItem }
  | { kind: "unknown" | "ambiguous" };

interface DiagnosticContext {
  caller: AgentInventoryItem;
  reason:
    | "dynamic"
    | "failed"
    | "incomplete"
    | "invalid-fingerprint"
    | "pending"
    | "resolved"
    | "self"
    | "unknown"
    | "ambiguous";
  target?: string;
}

interface NormalizedScanFingerprint {
  callerAgentKey: string;
  status: "failed" | "missing" | "pending" | "ready";
  complete: boolean;
  sourceFingerprint: PackageGraphEvidenceDigest | null;
  candidates: PackageGraphStaticEvidenceCandidate[];
  dynamicCallsites: Array<{
    mode: "blocking" | "async";
    callsite: { kind: "source-callsite"; ref: string };
  }>;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function stableEvidenceJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableEvidenceJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Evidence identity accepts JSON values only");
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(
      ([key, child]) => `${JSON.stringify(key)}:${stableEvidenceJson(child)}`,
    )
    .join(",")}}`;
}

function evidenceDigest(value: unknown): PackageGraphEvidenceDigest {
  return `sha256:${createHash("sha256").update(stableEvidenceJson(value)).digest("hex")}`;
}

function sameInventoryVersion(
  left: PackageInventory["version"],
  right: PackageInventory["version"],
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "working-tree" && right.kind === "working-tree"
    ? left.workspaceKey === right.workspaceKey &&
        left.revision === right.revision
    : left.kind === "bundle" &&
        right.kind === "bundle" &&
        left.bundleDigest === right.bundleDigest;
}

function publicWarningOrder(left: GraphWarning, right: GraphWarning): number {
  return (
    compareText(left.code, right.code) ||
    compareText(left.agentKey ?? "", right.agentKey ?? "") ||
    compareText(left.message, right.message)
  );
}

function normalizeWarnings(warnings: readonly GraphWarning[]): GraphWarning[] {
  return [
    ...new Map(
      [...warnings]
        .sort(publicWarningOrder)
        .map((warning) => [
          `${warning.code}\0${warning.agentKey ?? ""}\0${warning.message}`,
          warning,
        ]),
    ).values(),
  ];
}

function validSourceEvidence(value: unknown): value is SourceEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<SourceEvidence>;
  return (
    typeof evidence.file === "string" &&
    evidence.file.length > 0 &&
    !evidence.file.startsWith("/") &&
    !evidence.file.includes("\\") &&
    evidence.file.split("/").every((part) => part !== "" && part !== "..") &&
    Number.isSafeInteger(evidence.line) &&
    evidence.line! > 0 &&
    Number.isSafeInteger(evidence.column) &&
    evidence.column! > 0
  );
}

function sourceCallsiteReference(
  callerAgentKey: string,
  evidence: SourceEvidence,
): { kind: "source-callsite"; ref: string } {
  return {
    kind: "source-callsite",
    ref: `callsite:${evidenceDigest({
      protocol: 1,
      callerAgentKey,
      file: evidence.file,
      line: evidence.line,
      column: evidence.column,
    })}`,
  };
}

function candidateFingerprint(
  candidate: PackageGraphStaticEvidenceCandidate,
): PackageGraphEvidenceDigest {
  return evidenceDigest(candidate);
}

function registerCandidateTarget(
  candidates: Map<string, AgentInventoryItem[]>,
  key: string,
  agent: AgentInventoryItem,
): void {
  const matches = candidates.get(key) ?? [];
  if (!matches.some((candidate) => candidate.agentKey === agent.agentKey)) {
    matches.push(agent);
    candidates.set(key, matches);
  }
}

function targetResolver(agents: readonly AgentInventoryItem[]): {
  resolve(target: string): Resolution;
} {
  const canonical = new Map<string, AgentInventoryItem>();
  const candidates = new Map<string, AgentInventoryItem[]>();
  for (const agent of agents) {
    if (agent.identityStatus === "canonical") {
      canonical.set(agent.agentKey, agent);
    } else {
      registerCandidateTarget(candidates, agent.agentKey, agent);
    }
    for (const alias of agent.resolutionAliases) {
      registerCandidateTarget(candidates, alias, agent);
    }
  }
  return {
    resolve(target) {
      const exact = canonical.get(target);
      if (exact) return { kind: "resolved", target: exact };
      const matches = candidates.get(target) ?? [];
      if (matches.length === 1) {
        return { kind: "resolved", target: matches[0]! };
      }
      return { kind: matches.length === 0 ? "unknown" : "ambiguous" };
    },
  };
}

function safeTargetLabel(target: string): string | null {
  return /^[A-Za-z0-9@_.:-]+$/.test(target) ? target : null;
}

function contextFingerprint(
  callerAgentKey: string,
  reason: DiagnosticContext["reason"],
  input: unknown,
): PackageGraphEvidenceDigest {
  return evidenceDigest({
    protocol: 1,
    producer: DIRECT_INVOCATION_EVIDENCE_PRODUCER,
    callerAgentKey,
    reason,
    input,
  });
}

function addIncompleteDiagnostic(
  diagnostics: PackageGraphEvidenceDiagnostic[],
  contexts: Map<PackageGraphEvidenceDigest, DiagnosticContext>,
  caller: AgentInventoryItem,
  reason: Extract<
    DiagnosticContext["reason"],
    "failed" | "incomplete" | "invalid-fingerprint" | "pending"
  >,
  input: unknown,
): void {
  const fingerprint = contextFingerprint(caller.agentKey, reason, input);
  contexts.set(fingerprint, { caller, reason });
  diagnostics.push({
    code: reason === "failed" ? "producer-failed" : "incomplete-analysis",
    severity: reason === "failed" ? "error" : "warning",
    candidateFingerprint: fingerprint,
  });
}

function scanStatus(
  scan: DirectInvocationScan,
): "failed" | "pending" | "ready" {
  return scan.failed ? "failed" : scan.pending ? "pending" : "ready";
}

function isDigest(value: unknown): value is PackageGraphEvidenceDigest {
  return typeof value === "string" && DIGEST.test(value);
}

function sameProducerSlot(
  state: PackageGraphStaticEvidenceState,
  inventory: PackageInventory,
): boolean {
  const latest = state.latestAttempt;
  return (
    sameInventoryVersion(latest.scope, inventory.version) &&
    latest.producer.id === DIRECT_INVOCATION_EVIDENCE_PRODUCER.id &&
    latest.producer.version === DIRECT_INVOCATION_EVIDENCE_PRODUCER.version
  );
}

function acceptedResult(
  state: PackageGraphStaticEvidenceState,
): PackageGraphEvidenceStaticResult | null {
  return state.status === "failed" ? null : state.accepted;
}

function projectEdges(
  inventory: PackageInventory,
  state: PackageGraphStaticEvidenceState,
): StaticInvocationGraphEdge[] {
  const accepted = acceptedResult(state);
  if (!accepted) return [];
  const projection = projectPackageGraphEvidence(inventory, [accepted]);
  const edges: StaticInvocationGraphEdge[] = [];
  for (const connector of projection.connectors) {
    if (connector.relation !== "invokes") continue;
    const modes = new Set<"blocking" | "async">();
    for (const support of connector.support) {
      if (support.basis === "static-invocation" && support.mode) {
        modes.add(support.mode);
      }
    }
    for (const mode of ["blocking", "async"] as const) {
      if (!modes.has(mode)) continue;
      edges.push({
        from: `agent:${connector.fromAgentKey}`,
        to: `agent:${connector.toAgentKey}`,
        kind: "invokes",
        basis: "static-invocation",
        mode,
      });
    }
  }
  return edges.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.to, right.to) ||
      (left.mode === right.mode ? 0 : left.mode === "blocking" ? -1 : 1),
  );
}

function projectionWarnings(
  latest: PackageGraphEvidenceStaticResult,
  state: PackageGraphStaticEvidenceState,
  contexts: ReadonlyMap<PackageGraphEvidenceDigest, DiagnosticContext>,
  agents: readonly AgentInventoryItem[],
): GraphWarning[] {
  const warnings: GraphWarning[] = [];
  const emittedContexts = new Set<PackageGraphEvidenceDigest>();
  for (const diagnostic of latest.diagnostics) {
    const fingerprint = diagnostic.candidateFingerprint;
    if (!fingerprint || emittedContexts.has(fingerprint)) continue;
    const context = contexts.get(fingerprint);
    if (!context) continue;
    const { caller } = context;
    if (diagnostic.code === "dynamic-target" && context.reason === "dynamic") {
      warnings.push({
        code: "dynamic-target",
        agentKey: caller.agentKey,
        message: `${caller.label} has a dynamic agent target that V0 cannot resolve.`,
      });
      emittedContexts.add(fingerprint);
      continue;
    }
    if (
      (diagnostic.code === "invalid-endpoint" ||
        diagnostic.code === "unknown-endpoint" ||
        diagnostic.code === "ambiguous-endpoint") &&
      (context.reason === "unknown" || context.reason === "ambiguous")
    ) {
      const target = safeTargetLabel(context.target ?? "");
      warnings.push({
        code: "unresolved-target",
        agentKey: caller.agentKey,
        message:
          context.reason === "ambiguous"
            ? `${caller.label} invokes ambiguous agent ${target ?? "target"}.`
            : target
              ? `${caller.label} invokes unknown agent ${target}.`
              : `${caller.label} invokes an invalid agent target.`,
      });
      emittedContexts.add(fingerprint);
      continue;
    }
    if (
      (diagnostic.code === "producer-failed" ||
        diagnostic.code === "incomplete-analysis") &&
      (context.reason === "failed" ||
        context.reason === "incomplete" ||
        context.reason === "invalid-fingerprint")
    ) {
      warnings.push({
        code: "projection-failed",
        agentKey: caller.agentKey,
        message:
          context.reason === "failed"
            ? `Could not inspect ${caller.label}.`
            : `Could not fully inspect ${caller.label}.`,
      });
      emittedContexts.add(fingerprint);
    }
  }

  const byKey = new Map(agents.map((agent) => [agent.agentKey, agent]));
  const accepted = acceptedResult(state);
  if (accepted) {
    const groups = new Map<
      string,
      { caller: AgentInventoryItem; target: AgentInventoryItem; count: number }
    >();
    for (const evidence of accepted.evidence) {
      if (evidence.basis !== "static-invocation") continue;
      const caller = byKey.get(evidence.fromAgentKey);
      const target = byKey.get(evidence.toAgentKey);
      if (!caller || !target) continue;
      const key = `${evidence.fromAgentKey}\0${evidence.toAgentKey}\0${evidence.mode}`;
      const group = groups.get(key) ?? { caller, target, count: 0 };
      group.count += evidence.callsites.length;
      groups.set(key, group);
    }
    for (const { caller, target, count } of groups.values()) {
      if (count < 2) continue;
      warnings.push({
        code: "duplicate-edge",
        agentKey: caller.agentKey,
        message: `${caller.label} invokes ${target.label} more than once.`,
      });
    }
  }
  return normalizeWarnings(warnings);
}

/**
 * Adapt finalized caller-scoped scanner output into one package-scoped static
 * evidence result. Scanner cache/watcher state remains an input only; it is
 * never reused as protocol identity or lifecycle state.
 */
export function adaptDirectInvocationsToGraphEvidence(input: {
  inventory: PackageInventory;
  agents: readonly AgentInventoryItem[];
  scans: readonly DirectInvocationScan[];
  previousState?: PackageGraphStaticEvidenceState;
}): DirectInvocationEvidenceAdaptation {
  const resolver = targetResolver(input.agents);
  const candidates: PackageGraphStaticEvidenceCandidate[] = [];
  const diagnostics: PackageGraphEvidenceDiagnostic[] = [];
  const coverageGaps: PackageGraphEvidenceCoverageGap[] = [];
  const contexts = new Map<PackageGraphEvidenceDigest, DiagnosticContext>();
  const fingerprints: NormalizedScanFingerprint[] = [];
  let settled = true;
  let cacheable = true;
  let complete = true;

  const orderedScans = [...input.scans].sort((left, right) =>
    compareText(left.caller.agentKey, right.caller.agentKey),
  );
  const expectedAgentKeys = new Set(
    input.agents.map((agent) => agent.agentKey),
  );
  const scanCountByAgentKey = new Map<string, number>();
  for (const scan of orderedScans) {
    scanCountByAgentKey.set(
      scan.caller.agentKey,
      (scanCountByAgentKey.get(scan.caller.agentKey) ?? 0) + 1,
    );
    if (expectedAgentKeys.has(scan.caller.agentKey)) continue;
    settled = false;
    cacheable = false;
    complete = false;
    coverageGaps.push({ code: "opaque-boundary" });
    addIncompleteDiagnostic(diagnostics, contexts, scan.caller, "incomplete", {
      unexpectedCaller: true,
    });
  }
  for (const caller of [...input.agents].sort((left, right) =>
    compareText(left.agentKey, right.agentKey),
  )) {
    const count = scanCountByAgentKey.get(caller.agentKey) ?? 0;
    if (count === 1) continue;
    settled = false;
    cacheable = false;
    complete = false;
    coverageGaps.push({ code: "opaque-boundary" });
    addIncompleteDiagnostic(
      diagnostics,
      contexts,
      caller,
      "incomplete",
      count === 0 ? { missingScan: true } : { duplicateScans: count },
    );
    if (count === 0) {
      fingerprints.push({
        callerAgentKey: caller.agentKey,
        status: "missing",
        complete: false,
        sourceFingerprint: null,
        candidates: [],
        dynamicCallsites: [],
      });
    }
  }
  for (const scan of orderedScans) {
    const status = scanStatus(scan);
    const validFingerprint = isDigest(scan.result.sourceFingerprint);
    const normalizedCandidates: PackageGraphStaticEvidenceCandidate[] = [];
    const dynamicCallsites: NormalizedScanFingerprint["dynamicCallsites"] = [];

    if (scan.pending) {
      settled = false;
      cacheable = false;
      complete = false;
      coverageGaps.push({ code: "other" });
      addIncompleteDiagnostic(diagnostics, contexts, scan.caller, "pending", {
        status,
      });
    } else if (scan.failed) {
      settled = false;
      cacheable = false;
      complete = false;
      coverageGaps.push({ code: "producer-failed" });
      addIncompleteDiagnostic(diagnostics, contexts, scan.caller, "failed", {
        status,
      });
    } else {
      if (scan.result.complete !== true) {
        cacheable = false;
        complete = false;
        coverageGaps.push({ code: "opaque-boundary" });
        addIncompleteDiagnostic(
          diagnostics,
          contexts,
          scan.caller,
          "incomplete",
          { complete: scan.result.complete ?? null },
        );
      }
      if (!validFingerprint) {
        cacheable = false;
        complete = false;
        coverageGaps.push({ code: "opaque-boundary" });
        addIncompleteDiagnostic(
          diagnostics,
          contexts,
          scan.caller,
          "invalid-fingerprint",
          { sourceFingerprint: null },
        );
      }

      for (const warning of scan.result.warnings) {
        if (warning.code !== "dynamic-target") continue;
        complete = false;
        if (!validSourceEvidence(warning.evidence)) {
          cacheable = false;
          coverageGaps.push({ code: "opaque-boundary" });
          addIncompleteDiagnostic(
            diagnostics,
            contexts,
            scan.caller,
            "incomplete",
            { invalidDynamicCallsite: true, mode: warning.mode },
          );
          continue;
        }
        const callsite = sourceCallsiteReference(
          scan.caller.agentKey,
          warning.evidence,
        );
        dynamicCallsites.push({ mode: warning.mode, callsite });
        coverageGaps.push({ code: "dynamic-source", reference: callsite });
        const fingerprint = contextFingerprint(
          scan.caller.agentKey,
          "dynamic",
          { mode: warning.mode, callsite },
        );
        contexts.set(fingerprint, {
          caller: scan.caller,
          reason: "dynamic",
        });
        diagnostics.push({
          code: "dynamic-target",
          severity: "warning",
          candidateFingerprint: fingerprint,
          reference: callsite,
        });
      }

      for (const invocation of scan.result.invocations) {
        const suppliedEvidence = Array.isArray(invocation.evidence)
          ? invocation.evidence
          : [];
        const validEvidence = suppliedEvidence.filter(validSourceEvidence);
        if (
          validEvidence.length === 0 ||
          validEvidence.length !== suppliedEvidence.length
        ) {
          cacheable = false;
          complete = false;
          coverageGaps.push({ code: "opaque-boundary" });
          addIncompleteDiagnostic(
            diagnostics,
            contexts,
            scan.caller,
            "incomplete",
            {
              invalidInvocationCallsites: true,
              targetFingerprint: evidenceDigest({
                target: invocation.target,
              }),
            },
          );
        }
        const callsites = [
          ...new Map(
            validEvidence
              .map((evidence) =>
                sourceCallsiteReference(scan.caller.agentKey, evidence),
              )
              .sort((left, right) => compareText(left.ref, right.ref))
              .map((reference) => [reference.ref, reference]),
          ).values(),
        ];
        const resolution = resolver.resolve(invocation.target);
        const candidate: PackageGraphStaticEvidenceCandidate = {
          fromAgentKey: scan.caller.agentKey,
          toAgentKey:
            resolution.kind === "resolved"
              ? resolution.target.agentKey
              : invocation.target.length <= 512
                ? invocation.target
                : "",
          relation: "invokes",
          basis: "static-invocation",
          mode: invocation.mode,
          callsites,
        };
        const fingerprint = candidateFingerprint(candidate);
        normalizedCandidates.push(candidate);
        if (resolution.kind === "resolved") {
          candidates.push(candidate);
          contexts.set(fingerprint, {
            caller: scan.caller,
            reason:
              resolution.target.agentKey === scan.caller.agentKey
                ? "self"
                : "resolved",
            target: invocation.target,
          });
          if (
            resolution.target.agentKey !== scan.caller.agentKey &&
            callsites.length > 1
          ) {
            diagnostics.push({
              code: "duplicate-evidence",
              severity: "warning",
              candidateFingerprint: fingerprint,
              reference: callsites[0],
            });
          }
          continue;
        }

        contexts.set(fingerprint, {
          caller: scan.caller,
          reason: resolution.kind,
          target: invocation.target,
        });
        const inventoryCanClassifyAmbiguity = input.inventory.agents.some(
          (agent) =>
            agent.identityStatus === "provisional" &&
            agent.identityIssue === "duplicate-agent-key" &&
            agent.candidateAgentKey === invocation.target,
        );
        if (resolution.kind !== "ambiguous" || inventoryCanClassifyAmbiguity) {
          candidates.push(candidate);
        } else {
          diagnostics.push({
            code: "ambiguous-endpoint",
            severity: "error",
            candidateFingerprint: fingerprint,
            endpoint: "to",
          });
        }
      }
    }

    normalizedCandidates.sort((left, right) =>
      compareText(stableEvidenceJson(left), stableEvidenceJson(right)),
    );
    dynamicCallsites.sort((left, right) =>
      compareText(stableEvidenceJson(left), stableEvidenceJson(right)),
    );
    fingerprints.push({
      callerAgentKey: scan.caller.agentKey,
      status,
      complete: scan.result.complete === true,
      sourceFingerprint: validFingerprint
        ? scan.result.sourceFingerprint!
        : null,
      candidates: normalizedCandidates,
      dynamicCallsites,
    });
  }

  fingerprints.sort((left, right) =>
    compareText(stableEvidenceJson(left), stableEvidenceJson(right)),
  );

  if (
    !complete &&
    !diagnostics.some((item) => item.code === "incomplete-analysis")
  ) {
    const fingerprint = contextFingerprint("package", "incomplete", {
      scans: fingerprints,
    });
    diagnostics.push({
      code: "incomplete-analysis",
      severity: "warning",
      candidateFingerprint: fingerprint,
    });
  }

  const allFailed =
    orderedScans.length > 0 && orderedScans.every((scan) => scan.failed);
  const analysisFingerprint = evidenceDigest({
    protocol: 1,
    scope: input.inventory.version,
    producer: DIRECT_INVOCATION_EVIDENCE_PRODUCER,
    scans: fingerprints,
  });
  const latestResult = createPackageGraphEvidenceStaticResult(
    {
      scope: input.inventory.version,
      producer: DIRECT_INVOCATION_EVIDENCE_PRODUCER,
      analysisFingerprint,
      outcome: allFailed ? "failure" : "success",
      coverage: complete
        ? { status: "complete" }
        : allFailed
          ? { status: "none", gaps: coverageGaps }
          : { status: "partial", gaps: coverageGaps },
      candidates: allFailed ? [] : candidates,
      diagnostics,
    },
    input.inventory,
  );
  const previousState =
    input.previousState &&
    sameProducerSlot(input.previousState, input.inventory)
      ? input.previousState
      : undefined;
  // A settled bounded scan can atomically refresh the proven literal subset
  // even when structural limits or dynamic targets keep topology incomplete.
  // Pending, failed, or inconsistent scan sets retain the last accepted result.
  const state = advancePackageGraphStaticEvidenceState(
    settled && latestResult.outcome === "success" ? undefined : previousState,
    latestResult,
  );

  return {
    latestResult,
    state,
    edges: projectEdges(input.inventory, state),
    warnings: projectionWarnings(latestResult, state, contexts, input.agents),
    cacheable,
    complete,
  };
}
