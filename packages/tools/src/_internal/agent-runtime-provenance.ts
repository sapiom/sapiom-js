/**
 * Private runtime-provenance bridge for instrumented agent bundles.
 *
 * This is deliberately an object-identity side channel: provenance never becomes
 * part of AgentRunSpec, an agent input, or an AgentRunResult. The build adapter may
 * associate an opaque callsite token with the exact spec it emits. Likewise, only
 * an exact SDK result object can carry a server-signed receipt into the next agent
 * boundary; copies and nested/transformed values intentionally lose the sidecar.
 *
 * @internal This is a versioned integration contract, not an author-facing API.
 */

export const AGENT_RUNTIME_PROVENANCE_VERSION = 1 as const;

export const AGENT_RUNTIME_PROVENANCE_VERSION_HEADER =
  "x-sapiom-runtime-provenance-version";
export const AGENT_RUNTIME_CALLSITE_HEADER =
  "x-sapiom-runtime-callsite-evidence";
export const AGENT_RUNTIME_LINEAGE_HEADER = "x-sapiom-runtime-lineage-receipt";

export interface AgentRuntimeProvenanceV1 {
  readonly version: typeof AGENT_RUNTIME_PROVENANCE_VERSION;
  /** Opaque build-owned reference. It contains no graph identity. */
  readonly callsite: string;
}

interface AgentRuntimeLineageV1 {
  readonly version: typeof AGENT_RUNTIME_PROVENANCE_VERSION;
  /** Opaque server-signed receipt. Its contents are never decoded by the SDK. */
  readonly receipt: string;
}

const MAX_OPAQUE_TOKEN_LENGTH = 8_192;
const invocationProvenance = new WeakMap<object, AgentRuntimeProvenanceV1>();
const resultLineage = new WeakMap<object, AgentRuntimeLineageV1>();

function supportedOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_TOKEN_LENGTH &&
    !/[\r\n]/.test(value)
  );
}

/** Associate build-derived v1 evidence without mutating or wrapping the spec. */
export function carryAgentRuntimeProvenance<T extends object>(
  spec: T,
  provenance: AgentRuntimeProvenanceV1,
): T {
  if (
    provenance.version === AGENT_RUNTIME_PROVENANCE_VERSION &&
    supportedOpaqueToken(provenance.callsite)
  ) {
    invocationProvenance.set(spec, provenance);
  }
  return spec;
}

/** @internal Headers for one immediate invocation; never recursively inspects input. */
export function agentRuntimeProvenanceHeaders(
  spec: object,
  directInput: unknown,
): Record<string, string> {
  const callsite = invocationProvenance.get(spec);
  const lineage =
    directInput !== null && typeof directInput === "object"
      ? resultLineage.get(directInput)
      : undefined;
  if (!callsite && !lineage) return {};
  return {
    [AGENT_RUNTIME_PROVENANCE_VERSION_HEADER]: String(
      AGENT_RUNTIME_PROVENANCE_VERSION,
    ),
    ...(callsite ? { [AGENT_RUNTIME_CALLSITE_HEADER]: callsite.callsite } : {}),
    ...(lineage ? { [AGENT_RUNTIME_LINEAGE_HEADER]: lineage.receipt } : {}),
  };
}

/** @internal Retain only a supported response receipt on the exact SDK result. */
export function retainAgentRuntimeLineage(
  result: object,
  version: string | null,
  receipt: string | null,
): void {
  if (
    version === String(AGENT_RUNTIME_PROVENANCE_VERSION) &&
    supportedOpaqueToken(receipt)
  ) {
    resultLineage.set(result, {
      version: AGENT_RUNTIME_PROVENANCE_VERSION,
      receipt,
    });
  }
}
