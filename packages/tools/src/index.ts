/**
 * `@sapiom/tools` — the typed Sapiom capability client.
 *
 * The same catalog your agents call over MCP, callable from code. Capabilities are
 * namespaces (`sandboxes`, `repositories`, `agent`, `fileStorage`, … ), importable
 * from the barrel or a subpath:
 *
 *   import { sandboxes } from "@sapiom/tools";
 *   import { sandboxes } from "@sapiom/tools/sandboxes";
 *
 * Auth is implicit: ambient (engine-injected) inside a workflow step, or explicit
 * via `createClient({ apiKey })` standalone.
 */
export { createClient, createClientFromEnv } from "./client.js";
export type { Sapiom } from "./client.js";
export type { TransportConfig, Attribution } from "./_client/index.js";

// The generic dispatch contract: any capability handle that carries a `dispatch`
// member is pausable via `pauseUntilSignal` in @sapiom/orchestration.
export type { DispatchHandle } from "./dispatch.js";

export * as sandboxes from "./sandboxes/index.js";
export { Sandbox } from "./sandboxes/index.js";

export * as repositories from "./repositories/index.js";
export { Repository } from "./repositories/index.js";

export * as agent from "./agent/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on a workflow step.
export { CODING_RESULT_SIGNAL } from "./agent/index.js";
// The shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives as
// input — annotate the resumed step with it instead of hand-rolling the shape.
export type {
  CodingResultPayload,
  ExecutionEnvironmentRef,
} from "./agent/index.js";
// Validate / build a `CodingResultPayload`, and the env `type` whose `id` is a
// sandbox name for `sandboxes.attach(id)`.
export {
  codingResultSchema,
  CodingResultSchemaError,
  toResumePayload,
  EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
} from "./agent/index.js";
// Default (instant, in-server) agent — `agent.run` / `agent.launch`. Signal const
// for a step's static `pause: { signal }` decl; the result payload shape + schema
// for a step resumed from `pauseUntilSignal(agentHandle, …)`.
export { AGENT_RUN_RESULT_SIGNAL } from "./agent/index.js";
export type {
  AgentRunSpec,
  AgentRunResult,
  AgentRunOutcome,
  AgentRunError,
  AgentRunStatus,
  AgentRunHandle,
  AgentRunResultPayload,
  AgentMcp,
} from "./agent/index.js";
export {
  agentRunResultSchema,
  AgentRunResultSchemaError,
} from "./agent/index.js";

export * as orchestrations from "./orchestrations/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on a workflow step.
export { ORCHESTRATIONS_RESULT_SIGNAL } from "./orchestrations/index.js";

// schedules — create/manage cron + one-off triggers for a deployed orchestration.
export * as schedules from "./schedules/index.js";
// The shape a step resumed from `pauseUntilSignal(orchestrationHandle, …)` receives
// as input — annotate the resumed step with it instead of hand-rolling the shape.
export type { OrchestrationRunResultPayload } from "./orchestrations/index.js";
// Validate an OrchestrationRunResultPayload at the resume boundary.
export {
  orchestrationResultSchema,
  OrchestrationResultSchemaError,
} from "./orchestrations/index.js";

export * as fileStorage from "./file-storage/index.js";
export { FileStorageHttpError } from "./file-storage/index.js";

export * as contentGeneration from "./content-generation/index.js";
export { ContentGenerationHttpError } from "./content-generation/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on a workflow step.
export { VIDEO_RESULT_SIGNAL } from "./content-generation/index.js";
// The shape a step resumed from `pauseUntilSignal(videoLaunchHandle, …)` receives
// as input — annotate the resumed step with it instead of hand-rolling the shape.
export type { VideoResultPayload } from "./content-generation/index.js";
// Map a live VideoGenerationResult to the wire shape the resumed step receives.
export { toVideoResumePayload } from "./content-generation/index.js";

export * as search from "./search/index.js";
export { SearchHttpError } from "./search/index.js";

export * as database from "./database/index.js";
export { DatabaseHttpError } from "./database/index.js";

export * as email from "./email/index.js";
export { EmailHttpError } from "./email/index.js";

export * as domains from "./domains/index.js";
export { DomainsHttpError } from "./domains/index.js";
