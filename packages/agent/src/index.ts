/**
 * @sapiom/workflow-sdk — the versioned public contract for Sapiom workflow authoring.
 *
 * Shared by:
 *   - Customer workflow definitions (compiled against this package's types)
 *   - The sandbox step-runner (reads input.json, builds ctx, runs one step)
 *   - The engine (uses types + directive guards; steps implement these interfaces)
 *
 * Design rule: LEAN. Types + ~100 lines of protocol runtime over zod. No
 * capability clients, no engine internals, no NestJS imports.
 */

// Directives — the load-bearing protocol contract
export { DIRECTIVE_KIND, isContinue, isRetry, isPause, isTerminate, isFail } from './directives.js';
export type {
  DirectiveKind,
  NextStepDirective,
  ContinueDirective,
  RetryDirective,
  PauseUntilSignalDirective,
  TerminateDirective,
  FailDirective,
} from './directives.js';

// Transition constructors + their branded types (the authoring surface)
export { goto, terminate, fail, pauseUntilSignal, retry } from './directives.js';
export type { Goto, Terminate, Fail, Pause, Retry } from './directives.js';

// Step authoring: defineStep + the derived `Allowed` return type + StepDefinition.
// Step + StepResult are retained for the engine (deprecated for authoring).
export { defineStep } from './step.js';
export type { Step, StepResult, StepDefinition, Allowed } from './step.js';

// Execution context — what a step's `run` receives (metadata + shared store + logger)
export type {
  AgentExecutionContext,
  TypedContextStore,
  InMemoryContextStoreOptions,
  StepExecutionRecord,
  StepLogger,
  FinishedStepStatus,
} from './context.js';
export { InMemoryContextStore } from './context.js';

// Agent definition + defineAgent factory + brand guards (current + pre-rename legacy)
export type { AgentDefinition } from './agent.js';
export {
  defineAgent,
  isAgentDefinition,
  AGENT_DEFINITION_BRAND,
  isLegacyOrchestrationDefinition,
  LEGACY_ORCHESTRATION_DEFINITION_BRAND,
} from './agent.js';

// Errors that are part of the public contract surface
export {
  AgentError,
  UnknownStepError,
  StepInputValidationError,
  DisallowedTransitionError,
  STEP_INPUT_VALIDATION_ERROR_CONTRACT,
  stepInputValidationErrorPayloadSchema,
  isStepInputValidationErrorPayload,
} from './errors.js';
export type { StepInputValidationErrorPayload } from './errors.js';

// ctx.shared quota — the versioned cross-process size/error contract
export {
  CTX_SHARED_QUOTA_CONTRACT,
  MAX_SHARED_SNAPSHOT_BYTES,
  CtxSharedSizeLimitExceededError,
  ctxSharedSizeLimitExceededPayloadSchema,
  findCtxSharedSizeViolation,
  isCtxSharedSizeLimitExceededPayload,
  measureCtxSharedSnapshotBytes,
} from './ctx-shared-quota.js';
export type {
  CtxSharedSizeLimitExceededErrorOptions,
  CtxSharedSizeLimitExceededPayload,
  CtxSharedSizeLimitPhase,
  CtxSharedSizeViolation,
} from './ctx-shared-quota.js';

// ctx.shared serialization — terminal JSON encoding failures at enforcement boundaries
export {
  CTX_SHARED_SERIALIZATION_ERROR_CONTRACT,
  CtxSharedSerializationError,
  ctxSharedSerializationErrorPayloadSchema,
  isCtxSharedSerializationErrorPayload,
} from './ctx-shared-serialization.js';
export type {
  CtxSharedSerializationErrorOptions,
  CtxSharedSerializationErrorPayload,
  CtxSharedSerializationPhase,
} from './ctx-shared-serialization.js';

// Closed platform retry-classification registry.
export { isNonRetryableStepErrorPayload, parseNonRetryableStepErrorPayload } from './non-retryable-step-error.js';
export type { NonRetryableStepErrorPayload } from './non-retryable-step-error.js';

// Injected run configuration — the seam a step reads a chosen resource handle
// from (the entry input the setup panel's settings / resource picker drive).
export { resolveResourceHandle } from './config.js';
export type { ResolveResourceHandleOptions } from './config.js';

// Introspection — zod→JSON-Schema conversion + step/workflow input contracts.
// Shared by engine tooling and the build phase (runs outside the engine).
export { zodToJsonSchema, exampleFromJsonSchema, stepInputContract, workflowInputContract } from './introspection.js';
export type { StepInputContract, AgentInputContract } from './introspection.js';

// Manifest types, Zod schema, and generator — the build→engine contract.
export { MANIFEST_PROTOCOL, agentManifestSchema } from './manifest.js';
export type { AgentManifest, AgentStepManifest, ManifestTransition } from './manifest.js';

// Multi-agent package inventory — separate from the single-agent build manifest.
export { PACKAGE_INVENTORY_PROTOCOL, packageInventorySchema } from './package-inventory.js';
export type {
  PackageInventory,
  PackageInventoryAgent,
  PackageInventoryIdentityIssue,
  PackageInventoryVersion,
} from './package-inventory.js';

// Manifest generator + graph validation — called by the build phase.
export { buildManifest, validateGraph, assertValidGraph } from './build-manifest.js';
export type { GraphValidation } from './build-manifest.js';
