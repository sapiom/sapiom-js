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
export { AgentError, UnknownStepError, StepInputValidationError, DisallowedTransitionError } from './errors.js';

// Introspection — zod→JSON-Schema conversion + step/workflow input contracts.
// Shared by engine tooling and the build phase (runs outside the engine).
export { zodToJsonSchema, exampleFromJsonSchema, stepInputContract, workflowInputContract } from './introspection.js';
export type { StepInputContract, AgentInputContract } from './introspection.js';

// Manifest types, Zod schema, and generator — the build→engine contract.
export { MANIFEST_PROTOCOL, agentManifestSchema } from './manifest.js';
export type { AgentManifest, AgentStepManifest, ManifestTransition, SecretBinding } from './manifest.js';

// Manifest generator + graph validation — called by the build phase.
export { buildManifest, validateGraph, assertValidGraph } from './build-manifest.js';
export type { GraphValidation } from './build-manifest.js';
