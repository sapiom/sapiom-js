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
// member is pausable via `pauseUntilSignal` in @sapiom/agent.
export type { DispatchHandle } from "./dispatch.js";

export * as sandboxes from "./sandboxes/index.js";
export { Sandbox } from "./sandboxes/index.js";

export * as repositories from "./repositories/index.js";
export { Repository } from "./repositories/index.js";

export * as models from "./models/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on an agent step.
export { CODING_RESULT_SIGNAL } from "./models/index.js";
// The shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives as
// input — annotate the resumed step with it instead of hand-rolling the shape.
export type {
  CodingResultPayload,
  ExecutionEnvironmentRef,
} from "./models/index.js";
// Validate / build a `CodingResultPayload`, and the env `type` whose `id` is a
// sandbox name for `sandboxes.attach(id)`.
export {
  CodingRunHttpError,
  codingResultSchema,
  CodingResultSchemaError,
  toResumePayload,
  EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
} from "./models/index.js";
// Default (instant, in-server) model — `models.run` / `models.launch`. Signal const
// for a step's static `pause: { signal }` decl; the result payload shape + schema
// for a step resumed from `pauseUntilSignal(modelHandle, …)`.
export { MODEL_RUN_RESULT_SIGNAL } from "./models/index.js";
export type {
  ModelRunSpec,
  ModelRunResult,
  ModelRunOutcome,
  ModelRunError,
  ModelRunStatus,
  ModelRunHandle,
  ModelRunResultPayload,
  ModelMcp,
} from "./models/index.js";
export {
  modelRunResultSchema,
  ModelRunResultSchemaError,
} from "./models/index.js";

export * as agents from "./agents/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on an agent step.
export { AGENTS_RESULT_SIGNAL } from "./agents/index.js";

// schedules — create/manage cron + one-off triggers for a deployed agent.
export * as schedules from "./schedules/index.js";
// The shape a step resumed from `pauseUntilSignal(agentHandle, …)` receives
// as input — annotate the resumed step with it instead of hand-rolling the shape.
export type { AgentRunResultPayload } from "./agents/index.js";
// Validate an AgentRunResultPayload at the resume boundary.
export { agentResultSchema, AgentResultSchemaError } from "./agents/index.js";

// llm — routed LLM calls through the gateway's /v2 routing front-end: `run`
// (synchronous direct), `submit` (deferred-start; pausable handle), `redeem`,
// and the sessions resource (`createSession`/`getSession`/`callSession`/
// `releaseSession` — deferred capacity, repeatable calls).
export * as llm from "./llm/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on an llm step.
export {
  LLM_ROUTE_RESULT_SIGNAL,
  LLM_SESSION_READY_SIGNAL,
} from "./llm/index.js";
// The shape a step resumed from `pauseUntilSignal(llmHandle, …)` receives as
// input — annotate the resumed step with it instead of hand-rolling the shape.
export type { LlmRouteResultPayload } from "./llm/index.js";
// Validate an LlmRouteResultPayload at the resume boundary.
export {
  llmRouteResultSchema,
  LlmRouteResultSchemaError,
} from "./llm/index.js";

export * as fileStorage from "./file-storage/index.js";
export { FileStorageHttpError } from "./file-storage/index.js";

export * as contentGeneration from "./content-generation/index.js";
export { ContentGenerationHttpError } from "./content-generation/index.js";
// Thrown when a launched image/video job terminally FAILS (as distinct from an HTTP error on
// the request, or a poll that ran out its `timeoutMs` with the job still going) — SAP-3097.
export { ContentGenerationFailedError } from "./content-generation/index.js";
// The PUBLIC semantic model aliases the routed image/video capabilities serve, for callers that
// want to pin one. Aliases are the supported input; raw provider ids still work but are deprecated
// (SAP-2582), so pin from these maps rather than from the deprecated VIDEO_MODELS.
export {
  IMAGE_MODELS,
  VIDEO_MODEL_ALIASES,
} from "./content-generation/index.js";
export type {
  KnownImageModel,
  KnownVideoModelAlias,
} from "./content-generation/index.js";
// @deprecated raw provider video ids — kept exported for back-compat; migrate to VIDEO_MODEL_ALIASES.
export { VIDEO_MODELS } from "./content-generation/index.js";
export type { KnownVideoModel } from "./content-generation/index.js";
// Neutral param vocabulary (E4/SAP-2579) — name these when building typed media inputs.
export type {
  AspectRatio,
  Resolution,
  OutputFormat,
} from "./content-generation/index.js";
// Capability-based model selection (E5/SAP-2580) — the `select` directives honored when `model`
// is omitted; the response echoes `resolvedModel` + `preferSatisfied`. Typed per media type: only
// `VideoSelect` exposes `requires`, and the image type prohibits it. `MediaSelect` is the shared
// shape both inputs accept — name it only in code generic over image AND video.
export type {
  ImageSelect,
  VideoSelect,
  MediaSelect,
} from "./content-generation/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on a workflow step.
export { VIDEO_RESULT_SIGNAL } from "./content-generation/index.js";
export { IMAGE_RESULT_SIGNAL } from "./content-generation/index.js";
// The shape a step resumed from `pauseUntilSignal(launchHandle, …)` receives as input
// — annotate the resumed step with it instead of hand-rolling the shape.
export type { VideoResultPayload } from "./content-generation/index.js";
export type { ImageResultPayload } from "./content-generation/index.js";
// The per-generation cost envelope (SAP-2576) + the resume-metadata half both payloads share —
// name these when typing a re-billing step that persists `cost.reference`.
export type { MediaCostEnvelope } from "./content-generation/index.js";
export type { MediaResumeFields } from "./content-generation/index.js";
// Map a live generation result to the wire shape the resumed step receives.
export { toVideoResumePayload } from "./content-generation/index.js";
export { toImageResumePayload } from "./content-generation/index.js";

export * as search from "./search/index.js";
export { SearchHttpError } from "./search/index.js";

export * as database from "./database/index.js";
export { DatabaseHttpError } from "./database/index.js";

export * as email from "./email/index.js";
export { EmailHttpError } from "./email/index.js";

export * as domains from "./domains/index.js";
export { DomainsHttpError } from "./domains/index.js";

export * as memory from "./memory/index.js";
export { MemoryHttpError } from "./memory/index.js";

export * as speech from "./speech/index.js";
export { SpeechHttpError } from "./speech/index.js";

export * as browserAutomation from "./browser-automation/index.js";
export { BrowserAutomationHttpError } from "./browser-automation/index.js";

export * as vault from "./vault/index.js";
export { VaultHttpError } from "./vault/index.js";

export * as keys from "./keys/index.js";
export { KeysHttpError } from "./keys/index.js";
export type { MintScopedInput, ScopedKey } from "./keys/index.js";
