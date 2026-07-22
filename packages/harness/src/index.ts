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
