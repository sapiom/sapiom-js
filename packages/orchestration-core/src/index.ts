/**
 * @sapiom/orchestration-core — pure, stateless functions for scaffolding,
 * validating, and operating Sapiom orchestrations.
 *
 * Design contract:
 *   - No process.env reads (all config is passed explicitly)
 *   - No console output (callers render results)
 *   - No global state
 *   - Every networked function accepts a GatewayClient as its last argument
 *
 * Consumers: @sapiom/cli (thin arg-parse + render shell), @sapiom/mcp (SAP-930).
 */

// Errors
export { OrchestrationError } from "./errors.js";
export type { StructuredError } from "./errors.js";

// HTTP client factory
export {
  GatewayClient,
  createClient,
  DEFAULT_WORKFLOWS_HOST,
} from "./client.js";
export type { ClientOptions, GatewayErrorBody } from "./client.js";

// Config (sapiom.json)
export {
  readConfig,
  requireConfig,
  writeConfig,
  CONFIG_FILE,
} from "./config.js";
export type { SapiomConfig } from "./config.js";

// scaffold (local, no network)
export {
  scaffold,
  resolveVersions,
  resolveTemplate,
  listTemplates,
  DEFAULT_TEMPLATE,
} from "./scaffold.js";
export type {
  ScaffoldOptions,
  ScaffoldResult,
  ResolvedVersions,
} from "./scaffold.js";

// check (local, no network)
export { check } from "./check.js";
export type { CheckOptions, CheckResult } from "./check.js";

// bundle-for-deploy (local, no network) — inline local/shared code, externalize npm deps
export { bundleForDeploy } from "./bundle.js";
export type { DeployBundle } from "./bundle.js";

// link (networked)
export { link } from "./link.js";
export type { LinkOptions, LinkResult, DefinitionSummary } from "./link.js";

// deploy (networked)
export { deploy } from "./deploy.js";
export type { DeployOptions, DeployResult } from "./deploy.js";

// run (networked)
export { run, parseJsonInput } from "./run.js";
export type { RunOptions, RunResult } from "./run.js";

// projection types (canonical inspection contract — single owner, see interfaces.md)
export type {
  ExecutionProjection,
  StepProjection,
  CostNode,
  SettleState,
  ExecutionRef,
  DispatchRef,
  StepError,
  StepEvent,
} from "./types.js";

// projection decode helpers (tolerant normalization of the REST body)
export {
  decodeExecutionProjection,
  decodeExecutionRef,
  decodeCostNode,
} from "./decode.js";

// inspect / logs (networked)
export {
  inspect,
  listExecutions,
  inspectBuild,
  waitForExecution,
  isExecutionTerminal,
} from "./inspect.js";
export type {
  InspectOptions,
  InspectBuildOptions,
  InspectBuildResult,
  BuildDetail,
  WaitForExecutionOptions,
  WaitForExecutionResult,
  WaitStopReason,
} from "./inspect.js";

// signal (networked)
export { signal, parseSignalPayload } from "./signal.js";
export type { SignalOptions, SignalResult } from "./signal.js";

// schedules / triggers (networked)
export { createSchedule, listSchedules, getSchedule, cancelSchedule, previewCron } from "./schedule.js";
export type {
  ScheduleKind,
  ScheduleStatus,
  SchedulePolicy,
  CreateScheduleOptions,
  ListSchedulesOptions,
  CronPreviewOptions,
  CronPreview,
  ScheduleSummary,
  ScheduleDetail,
  ScheduleFireRecord,
} from "./schedule.js";

// git helpers (used by deploy; exported for consumers that need them directly)
export { assertDeployable, pushHead } from "./git.js";

// local stub file model (per-step capability overrides for run_local)
export { parseStubFile, STUB_FILE_VERSION } from "./local/stubs.js";
export type { StubFile, StepStubs, StubResponse } from "./local/stubs.js";

// local execution (runs step bodies in-process against stub capabilities)
export { runLocal, runLocalFromDir, STUBS_FILE } from "./local/run-local.js";
export type {
  RunLocalOptions,
  LocalRunResult,
  LocalRunOutcome,
} from "./local/run-local.js";
export { loadDefinition } from "./local/load.js";
export type { LoadedDefinition } from "./local/load.js";
export { LocalStubDispatcher } from "./local/dispatcher.js";
export type { LocalStepTrace, LogEntry } from "./local/dispatcher.js";
