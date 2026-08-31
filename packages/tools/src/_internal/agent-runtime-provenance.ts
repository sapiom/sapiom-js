/**
 * Build-facing runtime-provenance carrier for instrumented agent bundles.
 *
 * This published internal subpath intentionally exposes only the opaque v1
 * callsite carrier. Receipt retention, extraction, header assembly, and
 * redaction remain package-private in the agents implementation.
 *
 * @internal Versioned build integration contract; not an author-facing API.
 */
import { registerAgentRuntimeCallsite } from "../agents/runtime-callsite-store.js";

export const AGENT_RUNTIME_PROVENANCE_VERSION = 1 as const;

export interface AgentRuntimeProvenanceV1 {
  readonly version: typeof AGENT_RUNTIME_PROVENANCE_VERSION;
  /** Opaque build-owned reference. It contains no graph identity. */
  readonly callsite: string;
}

/** Associate validated build evidence without mutating or wrapping the spec. */
export function carryAgentRuntimeProvenance<T extends object>(
  spec: T,
  provenance: AgentRuntimeProvenanceV1,
): T {
  registerAgentRuntimeCallsite(spec, provenance.version, provenance.callsite);
  return spec;
}
