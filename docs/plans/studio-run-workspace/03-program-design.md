# Program Design: Studio Run Workspace

## Files

- `packages/harness/src/shared/types.ts` — input-contract and enriched run view contracts.
- `packages/harness/src/server/actions.ts` — registered input-contract read and existing launch routes.
- `packages/harness/src/core/render-run-state.ts` — preserve cloud run and attempt evidence.
- `packages/agent-core/src/local/dispatcher.ts` and `local/run-local.ts` — local timings, shared state, and lifecycle callback.
- `packages/harness/src/core/run-local-bootstrap.ts` and `render-local-run.ts` — live NDJSON mapping into `RunView`.
- `packages/harness/web/src/lib/api.ts` and `use-harness-state.ts` — contract fetch, local upserts, launch input, and run store.
- `packages/harness/web/src/components/SessionStepsBar.tsx` and a new run-sheet component — split action and schema-driven input collection.
- `packages/harness/web/src/components/CanvasPane.tsx` and `CanvasStepDetail.tsx` — adaptive timeline, result, and evidence inspector.
- New web helpers/components for schema input, artifact rendering, and run preferences; `styles.css` supplies responsive/focus styling.
- Existing server, core, web unit, and Playwright specs receive regression coverage; focused new specs cover pure helpers.

## Types & signatures

```ts
type WorkflowInputContractResponse =
  | {
      status: "available";
      jsonSchema: Record<string, unknown>;
      example: unknown;
    }
  | { status: "none"; jsonSchema: null; example: Record<string, never> }
  | {
      status: "unavailable";
      jsonSchema: null;
      example: Record<string, never>;
      reason: string;
    };

interface RunView {
  executionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  input?: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: string;
  finishedAt?: string;
  steps: StepView[];
}

interface StepView {
  id: string;
  name: string;
  attempt: number;
  status: "pending" | "running" | "passed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  input?: unknown;
  output?: unknown;
  sharedState?: Record<string, unknown>;
  directive?: unknown;
  error?: string;
  logSlice?: string;
  calls?: StepCall[];
}

type RunLocalLine =
  | { kind: "step"; phase: "started" | "settled"; trace: LocalStepProgress }
  | RunLocalSummaryLine
  | RunLocalErrorLine;
```

## Call stack

- Launch: `SessionStepsBar → RunSheet → getWorkflowInputContract → schema form/AJV → App launch handler → runLocal/startProdRun → API`.
- Observe: `cloud poll or local stream → enriched RunView → current-session store → CanvasPane → timeline → shared inspector`.
- Render: `run/step value → artifact classifier → safe React renderer → Rendered/Raw + Copy`.
- Debug: `attempt selection → bounded attempt context → injectInput`.

## Test plan

- Contract route distinguishes available/none/unavailable and never reads an unregistered path.
- Form covers examples/defaults/required-skeleton merging, nested objects,
  enum/boolean controls, scalar arrays, scoped JSON fallbacks, stale saved
  input, keyboard tabs, validation, and exact launch payloads.
- Cloud mapper preserves falsy evidence, attempt/state/directive, timestamps, run result, and honest absence.
- Local stream publishes running and settled updates and upserts rather than duplicates.
- Timeline orders attempts chronologically and preserves manual selection.
- Renderer safely handles structures, markdown, media, failed media, escaped HTML, Raw, and Copy.
- Keyboard/modal/focus behavior and content-free analytics are covered in Playwright.
- Shared Rendered/Raw tabs use roving focus and a persistent labelled panel;
  Focus makes the obscured app root inert, owns Escape one layer at a time,
  and restores focus to its persistent trigger.
- Desktop dev-build coverage pins the Harness dependency build before Electron starts, so
  renderer/server routes cannot drift.
- PTY spawn tests inject a hostile launcher environment (`NO_COLOR`, `TERM=dumb`) and
  assert the child receives an xterm true-colour environment.
- Mock Studio coverage asserts Run-menu row geometry, attempts-before-result ordering,
  whole-result disclosure, bounded long/HTML previews, and Focus-layer occlusion plus
  macOS safe-area spacing.

## Least confident decisions

1. AJV adds web-bundle weight, but faithfully validating the runtime JSON Schema is safer than a partial hand-written validator.
2. A dedicated contract endpoint is authoritative and works before Canvas
   mounts; the already-validated visible entry graph is used only as a
   last-known-good fallback when fresh extraction is unavailable.
3. Stable evidence tabs include disabled “not recorded” states so local and cloud inspection use one predictable model.
