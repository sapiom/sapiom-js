/**
 * Direct-action macro routing (pure).
 *
 * Three of the action-rail macros no longer inject a `sapiom …` command into
 * the agent's pty — they call the harness server's direct routes instead, so
 * the action runs server-side (Deploy / Prod-run) or in-process (Run-local)
 * with **no Claude Code and no user LLM credits**:
 *
 *   - `deploy`    → POST /api/workflows/:id/deploy  (build-status NDJSON stream)
 *   - `prod_run`  → POST /api/runs                  ({ executionId } → inspector)
 *   - `run_local` → POST /api/runs/local            (offline stub-run NDJSON)
 *
 * Every other macro is untouched: `open_prod` (open-url), `visualize`
 * (render-canvas), and any inject macro — including the Debug / Explain /
 * free-form prompt-inserts surfaced through the composer library — still go
 * through their existing path.
 *
 * This module is the single source of truth for that split so the wiring at the
 * call site stays a thin `switch`, and the mapping is unit-testable without a
 * DOM. It is pure: no React, no I/O.
 */

/** The direct server-backed action a macro maps to, or `null` for a macro that
 *  keeps its existing (inject / open-url / render-canvas) behaviour. */
export type DirectActionKind = "deploy" | "prod-run" | "run-local";

/**
 * The macro ids that are now direct actions, mapped to their kind. Keyed by the
 * macro `id` the registry ships (`src/core/macros.ts`) so a rename there fails
 * loudly here rather than silently falling back to the pty inject path.
 */
const DIRECT_ACTION_BY_MACRO_ID: Readonly<Record<string, DirectActionKind>> = {
  deploy: "deploy",
  prod_run: "prod-run",
  run_local: "run-local",
};

/**
 * Classify a macro by id: the direct action it performs, or `null` when the
 * macro should keep its existing behaviour (open-url, render-canvas, or a pty
 * inject — e.g. Debug / Explain / free-form). The caller routes a non-null
 * result to the matching direct API method and a `null` result to `runMacro`.
 */
export function directActionKind(macroId: string): DirectActionKind | null {
  // hasOwn (not `record[id] ?? null`) so an inherited key like "toString" never
  // resolves to a function off Object.prototype.
  return Object.prototype.hasOwnProperty.call(DIRECT_ACTION_BY_MACRO_ID, macroId)
    ? DIRECT_ACTION_BY_MACRO_ID[macroId]
    : null;
}
