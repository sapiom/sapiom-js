# Status: Studio Run Workspace

- Gate 1 — Product: APPROVED 2026-08-13
- Gate 2 — Architecture: APPROVED 2026-08-13
- Gate 3 — Program Design: APPROVED 2026-08-13
- Gate 4 — Slice plan: APPROVED 2026-08-13

## Slices

- [x] Slice 1 — tracer bullet: input-contract endpoint plus split Run sheet wired to local and cloud launches
- [x] Slice 2 — schema controls, validation, and per-agent input/target restoration
- [x] Slice 3 — rich production evidence and genuinely live local attempt streaming
- [x] Slice 4 — chronological adaptive run workspace and evidence tabs
- [x] Slice 5 — safe artifact rendering and result-first completion behavior
- [x] Slice 6 — contextual debugging, analytics, accessibility, and regression polish
- [x] Slice 7 — hands-on remediation: build coherence, terminal colour, adaptive ordering, bounded artifacts, and isolated Focus mode

## Verification

- Harness typecheck and production web build pass.
- Harness Vitest: 139 files, 2,011 tests pass; performance suite: 4/4 pass.
- Desktop Vitest: 18 files, 152 tests pass. Harness and desktop typechecks pass.
- Run-entry and run-inspector Playwright coverage: 18/18 deterministic,
  content-safe scenarios pass. Canvas evidence has another 11/11 scenarios.
- Full Studio Playwright compatibility pass: 311/311 tests pass. Eleven stale
  assertions describing the removed Test/Run accordions were migrated to the
  split control, timeline, evidence tabs, and compact header.
- Manual browser review completed for the input sheet, artifact-first result,
  attempt drill-in, and Focus timeline/inspector layout.

Agent-core's distributable build passes. Its source-wide Jest/typecheck command
is not a reliable verification target in this checkout because the lockfile's
Zod 3.25 dev dependency is not linked into `packages/agent-core/node_modules`;
the existing `zod/v4` test import fails before tests load. The runtime path is
covered through the Harness bootstrap, renderer, stream parser, and browser
suites above.

## Notes for a fresh session

The user approved all four gates in chat on 2026-08-13 and then explicitly requested implementation. The primary job is artifact verification, not diagnosis, though complete per-attempt evidence remains available. The success metric is that at least 80% of executions inspected in Studio do not require opening the dashboard for run details. Local and cloud runs share one experience. Run history is current-session only; cost and production capability-call expansion are out of scope.

Hands-on review on 2026-08-13 reopened the implementation for remediation without
changing the approved product or architecture. Acceptance now explicitly requires:

- the desktop development launcher builds the Harness server and web assets before Electron;
- PTYs own their colour-capable terminal environment instead of inheriting `NO_COLOR`;
- an available entry-step schema always produces native input controls in the launched build;
- the Run target menu has two-line rows with stable spacing and no overlap;
- narrow Steps shows attempts before the latest result;
- the result card is foldable, while long text and escaped HTML start behind bounded previews;
- Focus is an opaque top-level layer with macOS traffic-light clearance and no underlying pane chrome;
- deterministic mocks cover every behavior above, including disclosure and responsive ordering.

The remediation slice completed on 2026-08-13. The desktop dev command now
rebuilds Harness before Electron, the visible entry graph is a last-known-good
contract fallback, PTYs explicitly advertise true colour, artifacts use bounded
disclosures, and Focus renders through an opaque document-level portal. The
same Rendered/Raw artifact viewer is reused for structured attempt Input,
Output, State, Directive, and Logs evidence. Calls retain their call grouping,
with Arguments and Results rendered as collapsed artifacts. Canvas node
selection also reuses that artifact viewer for observed step Input, Output, and
Logs instead of falling back to raw-only disclosures; these compact Canvas
evidence cards start collapsed. Recorded capability-call Arguments and Results
follow the same pattern.

The release-candidate audit completed on 2026-08-14. It tightened shared tab and
listbox keyboard behavior, labelled every dynamic panel and scoped JSON editor,
made Focus a true inert modal with one-layer Escape and focus restoration,
bounded logs and calls through the shared artifact renderer, and fixed recursive
prefill so partial defaults merge with required skeletons without materializing
optional object groups. The recursive form, stale-contract recovery, exact
payloads, Focus isolation, empty artifacts, long output, calls, logs, and
content-free telemetry are all pinned by deterministic mocks.
