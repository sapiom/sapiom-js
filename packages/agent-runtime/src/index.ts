/**
 * @sapiom/agent-runtime — the host-agnostic orchestration runtime.
 *
 * Exports the walker (`AgentRunnerCore`), the decision logic it uses
 * (directive validation, the retry/cap rule, terminal-outcome mapping), the
 * dispatch + completion contracts, and the host interfaces it runs against
 * (`ExecutionStore`, `StepDispatcher`, `RuntimeObserver`) — plus an in-memory
 * store for embedding the runtime without external infrastructure.
 */

export * from './advance-result.js';
export * from './completion-payload.js';
export * from './dispatch.js';
export * from './errors.js';
export * from './execution-state.js';
export * from './in-memory-store.js';
export * from './manifest-validation.js';
export * from './outcome.js';
export * from './runner-core.js';
export * from './stores.js';
export * from './validate-directive.js';
