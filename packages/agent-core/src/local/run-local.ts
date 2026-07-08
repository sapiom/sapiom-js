/**
 * runLocal — execute an agent entirely in-process, resolving every
 * `ctx.sapiom.*` capability call from a stub file. Runs the author's actual
 * step bodies on the `@sapiom/agent-runtime` walker, so a local pass is
 * real evidence, offline and at zero cost.
 *
 * Returns a structured per-step trace plus `unusedStubs` (supplied keys that
 * matched no call) and `stubWarnings` (keys that matched but carried the wrong
 * shape), so a caller can render the run and spot stubs that didn't take effect.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  AgentDefinition,
  AgentManifest,
} from "@sapiom/agent";
import {
  DEFAULT_MAX_ATTEMPTS_PER_STEP,
  InMemoryExecutionStore,
  NOOP_OBSERVER,
  AgentRunnerCore,
} from "@sapiom/agent-runtime";

import { AgentOperationError } from "../errors.js";
import { LocalStubDispatcher, type LocalStepTrace } from "./dispatcher.js";
import { loadDefinition } from "./load.js";
import { parseStubFile, type StubFile } from "./stubs.js";

/** Committed, reviewable stub file a project keeps for its local-run loop. */
export const STUBS_FILE = path.join(".sapiom-dev", "stubs.json");

/** Load `.sapiom-dev/stubs.json` from a project dir, or undefined if absent. */
function loadStubsFile(sourceDir: string): StubFile | undefined {
  const file = path.join(sourceDir, STUBS_FILE);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new AgentOperationError({
      code: "STUBS_INVALID",
      message: `${STUBS_FILE} is not valid JSON.`,
      hint: err instanceof Error ? err.message : String(err),
    });
  }
  return parseStubFile(raw);
}

export interface RunLocalOptions {
  definition: AgentDefinition;
  manifest: AgentManifest;
  /** The workflow's entry-step input. */
  input?: unknown;
  /** Stub overrides (already parsed). Unmatched calls use built-in defaults. */
  stubs?: StubFile;
  maxAttemptsPerStep?: number;
}

export type LocalRunOutcome = "completed" | "failed" | "paused" | "running";

/** A supplied stub key that no capability call in its step ever matched — almost
 *  always a typo or the wrong path form (e.g. `models.coding.launch` instead of
 *  `models.coding.run`, or the plural `repositories.pushFromSandbox` instead of
 *  the handle-method `repository.pushFromSandbox`). */
export interface UnusedStub {
  step: string;
  key: string;
}

export interface LocalRunResult {
  outcome: LocalRunOutcome;
  executionId: string;
  output?: unknown;
  error?: unknown;
  /** Per-step-attempt trace, in execution order. */
  steps: LocalStepTrace[];
  /** Stub keys that were supplied but matched no capability call. Empty when
   *  every supplied stub was used. */
  unusedStubs: UnusedStub[];
  /** Warnings about stub values that matched a key but had the wrong shape for
   *  the capability (the silent-wrong-data trap). Empty when none. */
  stubWarnings: string[];
}

const MAX_ADVANCES = 1000; // backstop against a pathological non-terminating graph

/** Run a loaded definition locally against stub capabilities (defaults + overrides). */
export async function runLocal(opts: RunLocalOptions): Promise<LocalRunResult> {
  const stubs: StubFile = opts.stubs ?? { version: 1, steps: {} };
  const max = opts.maxAttemptsPerStep ?? DEFAULT_MAX_ATTEMPTS_PER_STEP;

  const store = new InMemoryExecutionStore();
  const dispatcher = new LocalStubDispatcher(opts.definition, stubs);
  // Shared registry: a launched capability (e.g. models.coding.launch) records the
  // result that should resume a pause on its signal.
  const signals = new Map<string, unknown>();
  dispatcher.setSignals(signals);
  const core = new AgentRunnerCore({
    store,
    dispatcher,
    observer: NOOP_OBSERVER,
  });
  dispatcher.setCore(core);
  dispatcher.setMaxAttempts(max);

  const executionId = await core.createExecution(
    opts.definition.name,
    opts.definition.entry,
    opts.input,
    {
      manifest: opts.manifest,
    },
  );

  // The dispatcher runs each step body + its completion inline, so one advance()
  // fully processes one step. Drive on the execution's resulting status: keep
  // advancing while running; auto-resume a pause (feeding the recorded signal
  // result as the resumed step's input); stop on a terminal state.
  let guard = 0;
  while (guard++ < MAX_ADVANCES) {
    await core.advance(executionId, max);
    const row = await store.loadExecution(executionId);
    if (
      !row ||
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    )
      break;
    if (row.status === "paused") {
      const payload = signals.get(row.pausedSignalCorrelationId ?? "") ?? {};
      await core.resetForResume(executionId, { fromStepInput: payload });
    }
    // 'running' (or just-resumed) → advance again
  }

  const final = await store.loadExecution(executionId);
  // A local run never cancels; fold the unreachable 'cancelled' into 'failed'.
  const outcome: LocalRunOutcome =
    final?.status === "cancelled" ? "failed" : (final?.status ?? "running");

  // Flag supplied stub keys that no call matched — only for steps that actually
  // ran (an unexecuted branch's stubs aren't "unused", just untouched this run).
  const unusedStubs: UnusedStub[] = [];
  for (const [step, used] of dispatcher.usedKeysByStep) {
    for (const key of Object.keys(stubs.steps[step] ?? {})) {
      if (!used.has(key)) unusedStubs.push({ step, key });
    }
  }

  return {
    outcome,
    executionId,
    output: final?.output,
    error: final?.error,
    steps: dispatcher.trace,
    unusedStubs,
    stubWarnings: [...dispatcher.stubWarnings],
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
  return runLocal({
    definition,
    manifest,
    input: opts.input,
    stubs,
    maxAttemptsPerStep: opts.maxAttemptsPerStep,
  });
}
