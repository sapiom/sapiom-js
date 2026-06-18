/**
 * `DispatchHandle` — the structural contract a long-running capability's launch
 * handle satisfies so a workflow step can pause on it and resume when it finishes.
 *
 * A "dispatched" capability (the coding agent today; deep research, sub-workflows,
 * browser sessions later) is launched fire-and-forget and reports completion via a
 * Sapiom-internal callback. Its launch handle carries the two facts the engine
 * needs to pause-then-resume: a `correlationId` (the join key for this specific
 * run) and the `resultSignal` it fires on terminal.
 *
 * Authors never read `dispatch` directly — they pass the whole handle to
 * `pauseUntilSignal(handle, { resumeStep })`, which reads these off it. The member
 * is framework plumbing (marked `@internal`); the callback / secret / correlation
 * wiring beneath it is owned and injected by the engine + gateway. Any capability
 * whose handle exposes a `dispatch` member is automatically pausable — the
 * orchestration layer is blind to which capability produced it.
 */
export interface DispatchHandle {
  /** @internal Framework plumbing consumed by `pauseUntilSignal`; not a supported author field. */
  readonly dispatch: {
    /** Join key for this dispatched run; the engine matches the resume on it. */
    readonly correlationId: string;
    /** Capability-stable signal fired when the run reaches a terminal state. */
    readonly resultSignal: string;
  };
}
