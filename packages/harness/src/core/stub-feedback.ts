/**
 * stub-feedback — the pure, read-only derivations behind the run-inspector's
 * stub affordances (WB15-2). Given a {@link RunView} (which already carries the
 * run-level stub facts set by {@link renderLocalRun}), decide:
 *  - whether a given step should show the "stubbed" chip, and
 *  - what the read-only stub-hygiene notice should say (or nothing).
 *
 * Pure and deterministic: no LLM, no I/O, no clock — every result is a function
 * of the RunView alone, so both are Stryker targets with mutation-first tests.
 *
 * Read-only by design: this surfaces what a stub run DID (served a call, or a
 * supplied stub matched nothing / had the wrong shape). Editing stubs is a
 * deferred fast-follow and lives nowhere here.
 *
 * Honesty is the whole point: the chip appears only for a step that actually ran
 * in a stub-served run (never for a prod run, never for a step the run never
 * reached), and the notice is `null` unless there is a real problem to report —
 * so a clean run shows no chrome at all.
 */
import type { RunView } from "../shared/types.js";

/**
 * Should the "stubbed" chip render for the step named `stepName`?
 *
 * True only when BOTH hold:
 *  1. the run was stub-served (`run.stubbed` — set by renderLocalRun for an
 *     offline local run; never by renderRunState for a prod run), and
 *  2. that step actually ran this run (it appears in `run.steps`).
 *
 * A local run resolves every `ctx.sapiom.*` call from a stub, so a step that ran
 * was stub-served — that is the honest granularity (agent-core records no
 * per-CALL stub attribution). A step the run never reached, or any step of a
 * real run, gets no chip. A null run (nothing observed yet) is never stubbed.
 */
export function stepIsStubbed(run: RunView | null, stepName: string): boolean {
  if (!run || run.stubbed !== true) return false;
  return run.steps.some((s) => s.name === stepName);
}

/**
 * The read-only stub-hygiene notice for a run, or `null` when there is nothing
 * honest to show. Present only the signals that carry real content:
 *  - `unusedStubs`: supplied stub keys that matched no capability call (a no-op
 *    mock — almost always a typo or the wrong path form), and
 *  - `stubWarnings`: stub values that matched a key but had the wrong shape.
 *
 * Returns `null` unless at least one non-empty signal exists, so the caller can
 * render nothing for a clean run (honesty — no empty "0 issues" panel). The
 * returned arrays are always non-empty when present (empty ones are dropped),
 * so the component never has to re-check length.
 */
export interface StubNotice {
  unusedStubs?: NonNullable<RunView["unusedStubs"]>;
  stubWarnings?: NonNullable<RunView["stubWarnings"]>;
}

export function stubNotice(run: RunView | null): StubNotice | null {
  if (!run) return null;
  const notice: StubNotice = {};
  if (run.unusedStubs && run.unusedStubs.length > 0) {
    notice.unusedStubs = run.unusedStubs;
  }
  if (run.stubWarnings && run.stubWarnings.length > 0) {
    notice.stubWarnings = run.stubWarnings;
  }
  // Empty object == no real signal; report honest absence as null so the
  // inspector renders no notice block at all.
  return notice.unusedStubs || notice.stubWarnings ? notice : null;
}
