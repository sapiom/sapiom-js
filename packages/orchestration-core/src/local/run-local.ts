/**
 * runLocal — execute an orchestration entirely in-process, resolving every
 * `ctx.sapiom.*` capability call from a stub file. Runs the author's actual
 * step bodies on the `@sapiom/orchestration-runtime` walker, so a local pass is
 * real evidence, offline and at zero cost.
 *
 * Returns a structured per-step trace + the stub worklist (capability calls that
 * had no stub) so a caller can render the run and fill the missing stubs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { OrchestrationDefinition, WorkflowManifest } from '@sapiom/orchestration';
import {
  ADVANCE_RESULT_KIND,
  DEFAULT_MAX_ATTEMPTS_PER_STEP,
  InMemoryExecutionStore,
  NOOP_OBSERVER,
  WorkflowRunnerCore,
} from '@sapiom/orchestration-runtime';

import { OrchestrationError } from '../errors.js';
import { LocalStubDispatcher, type LocalStepTrace } from './dispatcher.js';
import { loadDefinition } from './load.js';
import { parseStubFile, type StubFile } from './stubs.js';

/** Committed, reviewable stub file a project keeps for its local-run loop. */
export const STUBS_FILE = path.join('.sapiom-dev', 'stubs.json');

/** Load `.sapiom-dev/stubs.json` from a project dir, or undefined if absent. */
function loadStubsFile(sourceDir: string): StubFile | undefined {
  const file = path.join(sourceDir, STUBS_FILE);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new OrchestrationError({
      code: 'STUBS_INVALID',
      message: `${STUBS_FILE} is not valid JSON.`,
      hint: err instanceof Error ? err.message : String(err),
    });
  }
  return parseStubFile(raw);
}

export interface RunLocalOptions {
  definition: OrchestrationDefinition;
  manifest: WorkflowManifest;
  /** The workflow's entry-step input. */
  input?: unknown;
  /** Stub overrides (already parsed). Unmatched calls use built-in defaults. */
  stubs?: StubFile;
  maxAttemptsPerStep?: number;
}

export type LocalRunOutcome = 'completed' | 'failed' | 'paused' | 'running';

export interface LocalRunResult {
  outcome: LocalRunOutcome;
  executionId: string;
  output?: unknown;
  error?: unknown;
  /** Per-step-attempt trace, in execution order. */
  steps: LocalStepTrace[];
}

const MAX_ADVANCES = 1000; // backstop against a pathological non-terminating graph

/** Run a loaded definition locally against stub capabilities (defaults + overrides). */
export async function runLocal(opts: RunLocalOptions): Promise<LocalRunResult> {
  const stubs: StubFile = opts.stubs ?? { version: 1, steps: {} };
  const max = opts.maxAttemptsPerStep ?? DEFAULT_MAX_ATTEMPTS_PER_STEP;

  const store = new InMemoryExecutionStore();
  const dispatcher = new LocalStubDispatcher(opts.definition, stubs);
  const core = new WorkflowRunnerCore({ store, dispatcher, observer: NOOP_OBSERVER });
  dispatcher.setCore(core);
  dispatcher.setMaxAttempts(max);

  const executionId = await core.createExecution(opts.definition.name, opts.definition.entry, opts.input, {
    manifest: opts.manifest,
  });

  // The dispatcher runs each step body + its completion inline, so one advance()
  // fully processes one step. Loop until the execution reaches a terminal/paused state.
  let guard = 0;
  while (guard++ < MAX_ADVANCES) {
    const result = await core.advance(executionId, max);
    if (result.kind !== ADVANCE_RESULT_KIND.RUNNING && result.kind !== ADVANCE_RESULT_KIND.DISPATCHED) break;
  }

  const final = await store.loadExecution(executionId);
  // A local run never cancels; fold the unreachable 'cancelled' into 'failed'.
  const outcome: LocalRunOutcome = final?.status === 'cancelled' ? 'failed' : (final?.status ?? 'running');

  return {
    outcome,
    executionId,
    output: final?.output,
    error: final?.error,
    steps: dispatcher.trace,
  };
}

/**
 * Load a project directory's definition, then run it locally against stubs.
 * Stub precedence: explicit `opts.stubs` → the project's committed
 * `.sapiom-dev/stubs.json` → none. The file is the steered path — a reviewable
 * artifact a human can inspect and adjust.
 */
export async function runLocalFromDir(opts: {
  sourceDir: string;
  input?: unknown;
  stubs?: StubFile;
  maxAttemptsPerStep?: number;
}): Promise<LocalRunResult> {
  const { definition, manifest } = await loadDefinition(opts.sourceDir);
  const stubs = opts.stubs ?? loadStubsFile(opts.sourceDir);
  return runLocal({ definition, manifest, input: opts.input, stubs, maxAttemptsPerStep: opts.maxAttemptsPerStep });
}
