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
 * A vault secret binding declares which named environment variables an agent
 * needs from one tenant vault secret-set. It never carries secret values.
 */
export interface SecretBinding {
  /** Vault secret-set reference. */
  readonly ref: string;
  /** Environment-variable names to inject from that secret-set. */
  readonly keys: readonly string[];
}

// Identifier limits and character sets mirror Vault v2. Collection bounds keep
// manifests and dispatch-time vault requests finite.
export const SECRET_BINDING_LIMITS = {
  maxBindings: 32,
  maxKeysPerBinding: 64,
  maxTotalKeys: 256,
  maxRefLength: 256,
  maxKeyLength: 256,
} as const;

const SECRET_REF_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SECRET_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESERVED_SECRET_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isProtectedEnvironmentKey(key: string): boolean {
  return key === 'PATH' || key.startsWith('SAPIOM_') || key.startsWith('WORKFLOWS_');
}

const secretKeySchema = z
  .string()
  .min(1)
  .max(SECRET_BINDING_LIMITS.maxKeyLength)
  .regex(SECRET_KEY_PATTERN)
  .refine((key) => !RESERVED_SECRET_KEYS.has(key), 'Reserved object key is not allowed')
  .refine((key) => !isProtectedEnvironmentKey(key), 'Protected environment key is not allowed');

export const secretBindingSchema = z
  .object({
    ref: z.string().min(1).max(SECRET_BINDING_LIMITS.maxRefLength).regex(SECRET_REF_PATTERN),
    keys: z.array(secretKeySchema).min(1).max(SECRET_BINDING_LIMITS.maxKeysPerBinding),
  })
  .strict();

/**
 * Runtime schema shared by defineAgent, buildManifest, and AgentManifest.
 * A key may have exactly one source so sandbox env collision behavior never
 * depends on declaration order.
 */
export const secretBindingsSchema = z
  .array(secretBindingSchema)
  .max(SECRET_BINDING_LIMITS.maxBindings)
  .superRefine((bindings, ctx) => {
    const refs = new Set<string>();
    const keys = new Set<string>();
    let totalKeys = 0;

    for (const [bindingIndex, binding] of bindings.entries()) {
      if (refs.has(binding.ref)) {
        ctx.addIssue({
          code: 'custom',
          path: [bindingIndex, 'ref'],
          message: 'Secret-set refs must be unique',
        });
      }
      refs.add(binding.ref);

      for (const [keyIndex, key] of binding.keys.entries()) {
        totalKeys += 1;
        if (keys.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [bindingIndex, 'keys', keyIndex],
            message: 'Secret key names must be unique across bindings',
          });
        }
        keys.add(key);
      }
    }

    if (totalKeys > SECRET_BINDING_LIMITS.maxTotalKeys) {
      ctx.addIssue({
        code: 'custom',
        message: `Secret bindings may declare at most ${SECRET_BINDING_LIMITS.maxTotalKeys} keys total`,
      });
    }
  });

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
  /**
   * Vault secret key-name bindings to inject at dispatch. Optional for legacy
   * manifests; the runtime schema defaults it to an empty array.
   */
  readonly secrets?: readonly SecretBinding[];
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
  secrets: secretBindingsSchema.default([]),
});
