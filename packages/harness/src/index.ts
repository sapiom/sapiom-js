/**
 * @sapiom/harness — library entry. The CLI (`sapiom-harness`) is the primary
 * interface; this export exists so other packages can reuse the contract.
 */

export * from "./shared/types.js";
export {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  EXECUTION_MODES,
  PLAN_NODE_KINDS,
  RELATIONSHIP_KINDS,
} from "./shared/agent-map.js";
export type {
  AcceptedProposalDelta,
  ExecutionMode,
  MapOperation,
  MapProposalId,
  PlanNode,
  PlanNodeChanges,
  PlanNodeId,
  PlanNodeKind,
  PlanRelationship,
  PlanRelationshipId,
  ProposalActor,
  ProposalOperationId,
  RelationshipChanges,
  RelationshipKind,
  StudioProjectId,
} from "./shared/agent-map.js";
export type { WorkspaceScopeSummary } from "./shared/system-graph.js";
export { AGENT_STUDIO_PRODUCT_NAME } from "./shared/branding.js";
export {
  HarnessError,
  UnknownSessionError,
  SessionNotReadyError,
  SessionNotResumeableError,
  SessionAlreadyLiveError,
  AdapterNotFoundError,
  ExternalHarnessError,
  SpawnTargetError,
} from "./core/errors.js";
export {
  listHarnessAdapters,
  getHarnessAdapter,
  createHarnessAdapterRegistry,
  UnknownHarnessAdapterError,
} from "./core/adapters/registry.js";
export type {
  HarnessAdapterInfo,
  HarnessAdapterId,
  HarnessAdapterMode,
  EmbeddedHarnessAdapterInfo,
  ExternalHarnessAdapterInfo,
} from "./core/adapters/adapter.js";

// Embedding surface (SAP: harness-desktop) — lets a second host (the Electron
// app) reuse the exact server + setup flow the CLI (`bin.ts`) runs, instead of
// forking it. `ensureConsent`/`printDoctorReport` are intentionally NOT exported:
// they are TTY-shaped, and a native host supplies `telemetryOptIn`/`consentSource`
// to `startServer` directly — which is why `saveSettings` is exported too: a
// native host that prompts for consent itself must persist the answer the way
// `ensureConsent` does, or the settings file (the source of truth for the UI's
// analytics chip and for the next launch) never learns about it.
export { startServer } from "./server/index.js";
export type { HarnessServer, HarnessServerOptions } from "./server/index.js";
export {
  runDoctor,
  pickDefaultHarness,
  CLAUDE_INSTALL_COMMAND,
  CODEX_INSTALL_COMMAND,
} from "./cli/doctor.js";
export type { DoctorReport } from "./cli/doctor.js";
export { ensureAuthenticated } from "./cli/auth.js";
export type { HarnessIdentity } from "./cli/auth.js";
export { getOrCreateMachineId } from "./cli/machine-id.js";
export { ensureSpawnHelperExecutable } from "./core/session-manager.js";
// Exported so a host can spawn a pty the same way the harness does — Windows
// cannot launch a bare command name or a .cmd shim directly (see the module).
export { resolveSpawnTarget } from "./core/spawn-target.js";
export type { SpawnTarget } from "./core/spawn-target.js";
// Lets a host point the claude-code adapter at a different binary. Used by the
// desktop app's --smoke mode to create a REAL session against a stub agent, so
// per-OS session coverage doesn't require Claude Code installed on a CI runner.
export { createClaudeCodeAdapter } from "./core/adapters/claude-code.js";
export {
  loadSettings,
  saveSettings,
  recordRecentDir,
  hasStoredSettings,
} from "./cli/settings.js";
