/// <reference lib="dom" />
/**
 * Canvas run-state: live step lighting for the sandboxed iframe, plus the
 * reverse click channel (iframe → parent).
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
 * stringifies the functions below with `.toString()` and injects them
 * directly into the `<script>` block that `renderCanvasDocument` emits.
 *
 * REVERSE CHANNEL (iframe → parent)
 * ───────────────────────────────────
 * `bootCanvasNodeClicks` adds a single delegated click listener on
 * `document`. When a click lands inside a `.canvas-node[data-step-name]`
 * element, it posts `{ type: "sapiom:node-click", stepName }` to the parent
 * via `window.parent.postMessage`. The parent listens for this and opens the
 * step-detail panel.
 *
 * CONSTRAINTS on these functions
 * ────────────────────────────────
 * • No TypeScript-only syntax inside the function bodies (they are stringified
 *   as-is and executed in a plain-JS browser context with no transpiler).
 * • No imports or module-level references (same reason).
 * • All functions must be top-level `function` declarations (not arrow
 *   functions, not const lambdas) so they are referenceable by name after
 *   stringification.
 * • `runStateNodeClass` is the one pure piece (no DOM); it is also exported and
 *   unit-tested in `canvas-run-state.test.ts`. The other functions are DOM-only
 *   and not unit-testable in a Node/Vitest environment.
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
    steps: Array<{
      name: string;
      id?: string;
      status: string;
      latencyMs?: number;
    }>;
    status: string;
    target: string;
  },
): void {
  const stateClasses = ["is-running", "is-passed", "is-failed", "is-pending"];

  for (let i = 0; i < msg.steps.length; i++) {
    const step = msg.steps[i];
    // Match by step name (the node's data-step-name), falling back to the
    // step id. Wrapped in try/catch: a step name with a quote/bracket would
    // make an invalid selector throw, which must not abort the whole loop.
    let node = null;
    try {
      node =
        doc.querySelector('[data-step-name="' + step.name + '"]') ||
        (step.id
          ? doc.querySelector('[data-step-id="' + step.id + '"]')
          : null);
    } catch {
      node = null;
    }
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

/**
 * Wires the reverse click channel: iframe → parent.
 *
 * Adds a delegated `click` listener on `document` AND a `message` listener for
 * the harness gesture layer's `sapiom-canvas:pick` / `sapiom-canvas:hover`.
 * The gesture layer overlays the iframe (for pan / zoom) and swallows raw
 * clicks, so the direct listener alone never fires in the harness; the layer
 * instead forwards the click/hover point, which we hit-test with
 * `elementFromPoint`. Either path resolves the `.canvas-node[data-step-name]`
 * under the point and posts `{ type: "sapiom:node-click", stepName }` to the
 * parent (hover answers `{ type: "sapiom-canvas:hit", id }` for the cursor).
 * The parent maps the step name to the current RunView to open the inspector.
 *
 * Uses a delegated listener (one listener on document) rather than per-node
 * listeners so it works even when the SVG is replaced (e.g. after a
 * canvas.reload), without needing to re-wire.
 *
 * Stringified into the iframe template by `canvas-template.ts`.
 */
export function bootCanvasNodeClicks(): void {
  // Resolve the step name of the `.canvas-node[data-step-name]` at or above an
  // element (null when the point/target is not on a node).
  function stepNameAt(target: Element | null): string | null {
    const node = target && target.closest ? target.closest(".canvas-node[data-step-name]") : null;
    return node ? node.getAttribute("data-step-name") : null;
  }
  function emitNodeClick(target: Element | null): void {
    const stepName = stepNameAt(target);
    if (stepName) {
      window.parent.postMessage({ type: "sapiom:node-click", stepName: stepName }, "*");
    }
  }
  // Direct clicks on the board — the path when nothing overlays the iframe.
  document.addEventListener("click", function (e) {
    if (e && e.target) emitNodeClick(/** @type {Element} */ (e.target as Element));
  });
  // The harness renders a gesture layer OVER this iframe (for pan / zoom), so
  // raw clicks never reach this document. That layer forwards a click as
  // `{ type: "sapiom-canvas:pick", x, y }` and hovers as
  // `{ type: "sapiom-canvas:hover", x, y }` in this frame's coordinate space —
  // the iframe never transforms, so a frame-local point IS a viewport point.
  // Hit-test with elementFromPoint so a node still selects on click, and answer
  // hovers with `{ type: "sapiom-canvas:hit", id }` so the layer shows a
  // pointer cursor over nodes (and keeps a node's selection on click).
  window.addEventListener("message", function (e) {
    const d = e && e.data;
    if (!d) return;
    if (d.type === "sapiom-canvas:pick") {
      emitNodeClick(document.elementFromPoint(d.x, d.y));
    } else if (d.type === "sapiom-canvas:hover") {
      window.parent.postMessage(
        { type: "sapiom-canvas:hit", id: stepNameAt(document.elementFromPoint(d.x, d.y)) },
        "*",
      );
    }
  });
}
