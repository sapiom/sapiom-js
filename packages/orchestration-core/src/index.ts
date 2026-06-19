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
export { OrchestrationError } from './errors.js';
export type { StructuredError } from './errors.js';

// HTTP client factory
export { GatewayClient, createClient, DEFAULT_WORKFLOWS_HOST } from './client.js';
export type { ClientOptions, GatewayErrorBody } from './client.js';

// Config (sapiom.json)
export { readConfig, requireConfig, writeConfig, CONFIG_FILE } from './config.js';
export type { SapiomConfig } from './config.js';

// scaffold (local, no network)
export { scaffold, resolveVersions, resolveTemplate, listTemplates, DEFAULT_TEMPLATE } from './scaffold.js';
export type { ScaffoldOptions, ScaffoldResult, ResolvedVersions } from './scaffold.js';

// check (local, no network)
export { check } from './check.js';
export type { CheckOptions, CheckResult } from './check.js';

// link (networked)
export { link } from './link.js';
export type { LinkOptions, LinkResult, DefinitionSummary } from './link.js';

// deploy (networked)
export { deploy } from './deploy.js';
export type { DeployOptions, DeployResult } from './deploy.js';

// run (networked)
export { run, parseJsonInput } from './run.js';
export type { RunOptions, RunResult } from './run.js';

// inspect / logs (networked)
export { inspect, listExecutions, inspectBuild } from './inspect.js';
export type {
  InspectOptions,
  InspectResult,
  ListExecutionsResult,
  InspectBuildOptions,
  InspectBuildResult,
  ExecutionDetail,
  StepRecord,
  BuildDetail,
} from './inspect.js';

// signal (networked)
export { signal, parseSignalPayload } from './signal.js';
export type { SignalOptions, SignalResult } from './signal.js';

// git helpers (used by deploy; exported for consumers that need them directly)
export { assertDeployable, pushHead } from './git.js';
