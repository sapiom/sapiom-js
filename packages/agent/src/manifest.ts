// `zod/v4` subpath (present in zod 3.25.x AND zod 4.x): use the v4 type + API
// surface (incl. `z.toJSONSchema`) while the `zod` peer can resolve to v3 or v4.
import { z } from 'zod/v4';

/**
 * Protocol version for the workflow manifest format. Bumped when the schema
 * changes in a way that requires the engine to handle both versions.
 */
export const MANIFEST_PROTOCOL = 1 as const;

/**
 * A declared transition a step may take — the build-derivable graph edge set.
 * Tagged + versioned (NOT a bare `next: string[]`) so future edge kinds
 * (sub-workflow, fan-out) slot in as additive `kind`s without a schema break.
 * `retry` is intentionally NOT a transition kind — it is a universal badge the
 * engine always permits, not a topology edge.
 */
export type ManifestTransition =
  | { readonly kind: 'continue'; readonly target: string }
  | { readonly kind: 'terminate' }
  | { readonly kind: 'fail' }
  | { readonly kind: 'pause'; readonly signal: string; readonly resumeStep: string };

/**
 * Per-step metadata emitted by the build phase and consumed by the engine.
 * The engine uses this to pre-validate inputs and enforce dispatch deadlines
 * without importing any customer definition code.
 */
export interface AgentStepManifest {
  /**
   * Dispatch deadline for one attempt (ms).
   * null → engine applies its own default (DEFAULT_DISPATCH_TIMEOUT_MS).
   * Populated from step.timeoutMs when declared; null when undeclared.
   * Timeout policy lives in the engine, not the SDK — manifest carries null.
   */
  readonly timeoutMs: number | null;
  /**
   * JSON Schema (draft 2020-12) for the step input, or null if the step
   * declares no inputSchema. The engine pre-validates against this before
   * dispatching; the sandbox runner does the authoritative Zod parse.
   */
  readonly inputSchema: Record<string, unknown> | null;
  /**
   * The declared transitions out of this step (the graph edges). Built from the
   * step's `next`/`terminal`/`canFail`/`pause` declarations. The engine
   * validates every completion's directive against this set (per-step,
   * per-kind); the renderer draws one edge per entry. `reachable ⊆ declared`.
   */
  readonly transitions: readonly ManifestTransition[];
  /**
   * The canonical dotted id of the platform capability this step declares it
   * calls (`step.capability`, e.g. `web.search`), or null when the step
   * declares none. The engine validates the id against the capability
   * registry at index time and binds the step to it for attribution.
   * Optional in the type for compatibility with manifests built before the
   * field existed; the schema defaults it to null on parse.
   */
  readonly capabilityId?: string | null;
}

/**
 * The workflow manifest — pure data the engine consumes to drive execution
 * without importing customer code. Produced by the build phase (locally via
 * `build-definition`, in CI via the sandbox build-run). Protocol 1.
 */
export interface AgentManifest {
  /** Schema version. Engine rejects unknown protocols. */
  readonly protocol: typeof MANIFEST_PROTOCOL;
  /** Agent name (matches AgentDefinition.name). */
  readonly name: string;
  /** Entry step name (matches AgentDefinition.entry). */
  readonly entry: string;
  /** Version of @sapiom/workflow-sdk used to build the definition. */
  readonly sdkVersion: string;
  /** Bundle artifact metadata for integrity checks. */
  readonly artifact: {
    readonly sha256: string;
    readonly entryFile: string;
  };
  /** Per-step metadata map (keyed by step name). */
  readonly steps: Readonly<Record<string, AgentStepManifest>>;
}

// ---------------------------------------------------------------------------
// Zod schema — used by the engine to validate manifests it receives
// ---------------------------------------------------------------------------

const manifestTransitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue'), target: z.string().min(1) }),
  z.object({ kind: z.literal('terminate') }),
  z.object({ kind: z.literal('fail') }),
  z.object({ kind: z.literal('pause'), signal: z.string().min(1), resumeStep: z.string().min(1) }),
]);

const workflowStepManifestSchema = z.object({
  timeoutMs: z.union([z.number().int().positive(), z.null()]),
  inputSchema: z.union([z.record(z.string(), z.unknown()), z.null()]),
  transitions: z.array(manifestTransitionSchema),
  // Absent on manifests built before the field existed → parses to null.
  // Present ids must be non-empty (strict like timeoutMs); `z.object` strips
  // unknown keys, so without this entry the engine would silently drop the
  // binding at its validation edge.
  capabilityId: z.union([z.string().min(1), z.null()]).default(null),
});

/**
 * Zod schema that parses and validates a AgentManifest.
 * The engine uses this when it receives a manifest from the build phase.
 */
export const agentManifestSchema = z.object({
  protocol: z.literal(MANIFEST_PROTOCOL),
  name: z.string().min(1),
  entry: z.string().min(1),
  sdkVersion: z.string().min(1),
  artifact: z.object({
    sha256: z.string().min(1),
    entryFile: z.string().min(1),
  }),
  steps: z.record(z.string(), workflowStepManifestSchema),
});
