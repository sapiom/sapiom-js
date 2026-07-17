/// <reference lib="dom" />
/**
 * Canvas run-state: live step lighting for the sandboxed iframe.
 *
 * HOW IT WORKS — the stringify-into-iframe pattern
 * ─────────────────────────────────────────────────
 * The canvas iframe is served with `sandbox="allow-scripts"` which makes it
 * an opaque origin. The parent page cannot reach its DOM via any API — the
 * ONLY communication channel is `window.postMessage`.
 *
 * To apply live run state to the SVG nodes, we need code that runs INSIDE the
 * iframe's document. We cannot bundle a separate script for it (no fetch
 * inside a sandboxed iframe, no src="" script). Instead, `canvas-template.ts`
 * stringifies the three functions below with `.toString()` and injects them
 * directly into the `<script>` block that `renderCanvasDocument` emits.
 *
 * CONSTRAINTS on these functions
 * ────────────────────────────────
 * • No TypeScript-only syntax inside the function bodies (they are stringified
 *   as-is and executed in a plain-JS browser context with no transpiler).
 * • No imports or module-level references (same reason).
 * • All three must be top-level `function` declarations (not arrow functions,
 *   not const lambdas) so they are mutually referenceable by name after
 *   stringification. `bootCanvasRunState` calls `applyRunStateToCanvas`, which
 *   calls `runStateNodeClass` — the names must resolve at call time.
 * • `runStateNodeClass` is the one pure piece (no DOM); it is also exported and
 *   unit-tested in `canvas-run-state.test.ts`. The other two are DOM-only and
 *   not unit-testable in a Node/Vitest environment.
 */

export type RunStepStatus = "pending" | "running" | "passed" | "failed";

/**
 * Pure: map a step status to its canvas node CSS state class.
 *
 * Unit-tested. Safe to call from Node and from the browser.
 */
export function runStateNodeClass(status: string): string {
  if (status === "running") return "is-running";
  if (status === "passed") return "is-passed";
  if (status === "failed") return "is-failed";
  return "is-pending";
}

/**
 * DOM: apply a run-state message to a canvas document.
 *
 * For each step, finds the matching `[data-step-name]` node (falling back to
 * `[data-step-id]`), strips the four is-* state classes, and applies the one
 * matching the step's current status. Also updates the first `.canvas-badge`
 * inside `.canvas-title-row`: while the run is active it shows "running" or
 * "testing" (with the `canvas-badge--active` styling class); on completion it
 * restores the original text from `data-idle-label`.
 *
 * Browser-only — not unit-tested (no jsdom in the harness test env).
 * Stringified into the iframe template by `canvas-template.ts`.
 */
export function applyRunStateToCanvas(
  doc: Document,
  msg: {
    steps: Array<{ name: string; status: string; latencyMs?: number }>;
    status: string;
    target: string;
  },
): void {
  const stateClasses = ["is-running", "is-passed", "is-failed", "is-pending"];

  for (let i = 0; i < msg.steps.length; i++) {
    const step = msg.steps[i];
    const node =
      doc.querySelector('[data-step-name="' + step.name + '"]') ||
      doc.querySelector('[data-step-id="' + step.name + '"]');
    if (!node) continue;
    for (let j = 0; j < stateClasses.length; j++) {
      node.classList.remove(stateClasses[j]);
    }
    node.classList.add(runStateNodeClass(step.status));
    if (step.latencyMs != null) {
      node.setAttribute("data-latency", String(step.latencyMs));
    }
  }

  const titleRow = doc.querySelector(".canvas-title-row");
  if (!titleRow) return;
  const badge = titleRow.querySelector(".canvas-badge");
  if (!badge) return;

  if (msg.status === "running") {
    if (!badge.getAttribute("data-idle-label")) {
      badge.setAttribute("data-idle-label", badge.textContent || "");
    }
    badge.textContent = msg.target === "local" ? "testing" : "running";
    badge.classList.add("canvas-badge--active");
  } else {
    const idleLabel = badge.getAttribute("data-idle-label");
    if (idleLabel != null) {
      badge.textContent = idleLabel;
      badge.removeAttribute("data-idle-label");
    }
    badge.classList.remove("canvas-badge--active");
  }
}

/**
 * Wires the postMessage listener.
 *
 * Called once at the bottom of the injected `<script>` block. Listens for
 * `{ type: "sapiom:run-state", steps, status, target }` messages from the
 * parent page. The type guard is the only security boundary needed: because
 * the iframe is opaque-origin, no other page can impersonate the parent, and
 * the parent posts to `"*"` (required — we cannot know the opaque origin).
 *
 * Stringified into the iframe template by `canvas-template.ts`.
 */
export function bootCanvasRunState(): void {
  window.addEventListener("message", function (e) {
    const d = e && e.data;
    if (!d || d.type !== "sapiom:run-state") return;
    applyRunStateToCanvas(document, d);
  });
}
