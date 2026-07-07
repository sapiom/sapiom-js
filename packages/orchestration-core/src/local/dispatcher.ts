/**
 * LocalStubDispatcher — a `StepDispatcher` that runs a step body in-process with
 * a stub `ctx.sapiom`, then feeds the result back to the walker. It executes the
 * author's actual step code locally; `@sapiom/tools/stub` supplies a same-shaped
 * capability client whose calls return built-in defaults plus the project's
 * overrides (no real capability calls).
 *
 * The walker (`@sapiom/orchestration-runtime`) drives the loop; this just
 * executes one step and reports the completion.
 */
import {
  type NextStepDirective,
  type AgentExecutionContext,
  type AgentDefinition,
  InMemoryContextStore,
} from "@sapiom/orchestration";
import {
  type StepCompletionPayload,
  type StepDispatcher,
  type StepDispatchRequest,
  type AgentRunnerCore,
  parseCorrelationId,
  STEP_COMPLETION_OUTCOME,
} from "@sapiom/orchestration-runtime";
import { createStubClient } from "@sapiom/tools/stub";

import type { StubFile } from "./stubs.js";

export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  meta?: Record<string, unknown>;
}

/** One step attempt's record in the local run trace. */
export interface LocalStepTrace {
  step: string;
  attempt: number;
  input: unknown;
  status: "succeeded" | "threw";
  output?: unknown;
  directive?: NextStepDirective;
  error?: { name: string; message: string; stack?: string };
  logs: LogEntry[];
}

export class LocalStubDispatcher implements StepDispatcher {
  private core: AgentRunnerCore | null = null;
  private maxAttemptsPerStep: number | undefined;
  /** Run-scoped registry: launch correlationId → the result to resume a pause with. */
  private signals = new Map<string, unknown>();

  /** Per-step-attempt trace, in execution order. */
  readonly trace: LocalStepTrace[] = [];

  /** stepName → override keys that actually matched a capability call (across
   *  attempts). Diffed against the supplied stub keys to flag unmatched ones. */
  readonly usedKeysByStep = new Map<string, Set<string>>();

  /** Warnings about malformed stub *values* (right key, wrong shape), collected
   *  across all steps in execution order. */
  readonly stubWarnings = new Set<string>();

  constructor(
    private readonly definition: AgentDefinition,
    private readonly stubs: StubFile,
  ) {}

  setCore(core: AgentRunnerCore): void {
    this.core = core;
  }

  setMaxAttempts(max: number): void {
    this.maxAttemptsPerStep = max;
  }

  /** Share the signal registry with runLocal so it can auto-resume pauses. */
  setSignals(signals: Map<string, unknown>): void {
    this.signals = signals;
  }

  async dispatch(request: StepDispatchRequest): Promise<void> {
    if (!this.core)
      throw new Error("LocalStubDispatcher: setCore() was not called");
    const step = this.definition.steps[request.stepName];
    if (!step)
      throw new Error(
        `LocalStubDispatcher: no step '${request.stepName}' in the definition`,
      );

    const parsed = parseCorrelationId(request.correlationId);
    if (!parsed)
      throw new Error(
        `LocalStubDispatcher: malformed correlationId '${request.correlationId}'`,
      );

    const logs: LogEntry[] = [];
    const sharedStore = new InMemoryContextStore<Record<string, unknown>>(
      request.shared,
    );
    // The step's stub block is interpreted as capability overrides; unmatched
    // calls fall back to @sapiom/tools/stub's built-in defaults.
    const overrides = (this.stubs.steps[request.stepName] ?? {}) as Record<
      string,
      unknown
    >;
    let usedKeys = this.usedKeysByStep.get(request.stepName);
    if (!usedKeys) {
      usedKeys = new Set<string>();
      this.usedKeysByStep.set(request.stepName, usedKeys);
    }
    const sapiom = createStubClient({
      overrides,
      signals: this.signals,
      usedKeys,
      warnings: this.stubWarnings,
    });

    const ctx = {
      executionId: request.executionId,
      workflowName: request.workflowName,
      organizationId: request.organizationId,
      tenantId: request.tenantId,
      input: request.workflowInput,
      shared: sharedStore,
      history: [], // V1: not threaded — most steps don't read it. (deferred)
      attempts: request.attempt,
      logger: makeLogger(logs),
      sapiom,
    } as unknown as AgentExecutionContext;

    let directive: NextStepDirective;
    try {
      directive = await step.run(request.input, ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.trace.push({
        step: request.stepName,
        attempt: request.attempt,
        input: request.input,
        status: "threw",
        error: { name: e.name, message: e.message, stack: e.stack },
        logs,
      });
      await this.core.completeDispatchedStep(
        {
          protocol: 1,
          correlationId: request.correlationId,
          outcome: STEP_COMPLETION_OUTCOME.THREW,
          error: { name: e.name, message: e.message, stack: e.stack },
          shared: sharedStore.snapshot(),
        },
        parsed,
        this.maxAttemptsPerStep,
      );
      return;
    }

    const { output, wire } = splitDirective(directive);
    this.trace.push({
      step: request.stepName,
      attempt: request.attempt,
      input: request.input,
      status: "succeeded",
      output,
      directive,
      logs,
    });
    const payload: StepCompletionPayload = {
      protocol: 1,
      correlationId: request.correlationId,
      outcome: STEP_COMPLETION_OUTCOME.RESULT,
      result: { output, directive: wire },
      shared: sharedStore.snapshot(),
    };
    await this.core.completeDispatchedStep(
      payload,
      parsed,
      this.maxAttemptsPerStep,
    );
  }
}

function makeLogger(sink: LogEntry[]): AgentExecutionContext["logger"] {
  const at =
    (level: LogEntry["level"]) =>
    (msg: string, meta?: Record<string, unknown>) => {
      sink.push({ level, msg, ...(meta ? { meta } : {}) });
    };
  return {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
  };
}

type WireDirective = NonNullable<StepCompletionPayload["result"]>["directive"];

/**
 * Split a returned authoring directive into the audit `output` and the clean
 * wire directive the completion contract carries.
 */
function splitDirective(d: NextStepDirective): {
  output: unknown;
  wire: WireDirective;
} {
  switch (d.kind) {
    case "continue":
      return {
        output: d.input,
        wire: { kind: "continue", stepName: d.stepName, input: d.input },
      };
    case "terminate":
      return {
        output: (d as { output?: unknown }).output,
        wire: { kind: "terminate", reason: d.reason },
      };
    case "fail":
      return {
        output: (d as { output?: unknown }).output,
        wire: { kind: "fail", reason: d.reason },
      };
    case "pause_until_signal":
      return {
        output: (d as { output?: unknown }).output,
        wire: {
          kind: "pause_until_signal",
          signal: d.signal,
          timeoutMs: d.timeoutMs,
          resumeStep: d.resumeStep,
        },
      };
    case "retry":
      return {
        output: undefined,
        wire: { kind: "retry", delayMs: d.delayMs, reason: d.reason },
      };
  }
}
