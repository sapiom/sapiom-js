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
} from "./core/errors.js";
