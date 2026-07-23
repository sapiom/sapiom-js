/**
 * @sapiom/harness — library entry. The CLI (`sapiom-harness`) is the primary
 * interface; this export exists so other packages can reuse the contract.
 */

export * from "./shared/types.js";
export {
  HarnessError,
  UnknownSessionError,
  SessionNotReadyError,
  SessionNotResumeableError,
  SessionAlreadyLiveError,
  AdapterNotFoundError,
  ExternalHarnessError,
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
// to `startServer` directly.
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
export { loadSettings, recordRecentDir } from "./cli/settings.js";
