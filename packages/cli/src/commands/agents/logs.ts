import {
  AgentOperationError,
  type ExecutionProjection,
  type GatewayClient,
  inspect,
  inspectBuild,
  isExecutionTerminal,
  listExecutions,
  waitForExecution,
  watchExecution,
} from '@sapiom/agent-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { readConfig, requireConfig } from '../../lib/config.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';
import { renderExecutionList, renderExecutionTree, type RenderOptions } from './render.js';

/**
 * `sapiom agents logs [executionId]` — inspect an execution (its steps, child
 * runs, and per-node cost), a build (`--build`), or recent executions (no
 * argument). With `--follow` / `--watch` an execution streams live and
 * re-renders on every change until it reaches a terminal status.
 */
export async function runLogs(
  executionId: string | undefined,
  opts: { build?: string; host?: string; target?: CliTarget; follow?: boolean; watch?: boolean; verbose?: boolean },
): Promise<void> {
  try {
    const dir = process.cwd();
    const renderOpts: RenderOptions = { verbose: Boolean(opts.verbose) };

    if (opts.build) {
      const cfg = requireConfig(dir);
      const client = makeClient({ projectHost: cfg.host, flagHost: opts.host, flagTarget: opts.target });
      const { build } = await inspectBuild({ definitionId: cfg.definitionId, buildRunId: opts.build }, client);
      if (isJsonMode()) ok({ build });
      else ok({}, [`build ${opts.build}: ${build.status ?? 'unknown'}`]);
      return;
    }

    const cfg = readConfig(dir);
    const client = makeClient({ projectHost: cfg?.host, flagHost: opts.host, flagTarget: opts.target });

    if (!executionId) {
      const executions = await listExecutions(client);
      if (isJsonMode()) ok({ executions });
      else ok({}, renderExecutionList(executions));
      return;
    }

    if (opts.follow || opts.watch) {
      await followExecution(executionId, client, renderOpts);
      return;
    }

    const ex = await inspect({ executionId }, client);
    if (isJsonMode()) ok({ execution: ex });
    else ok({}, renderExecutionTree(ex, renderOpts));
  } catch (err) {
    if (err instanceof AgentOperationError) throw new CliError(err.toStructured());
    throw err;
  }
}

/** Re-render window in the SSE-drop poll fallback (ms). Bounds how often the
 *  fallback re-reads and re-renders; each chunk inherits `waitForExecution`'s
 *  poll + settle semantics (incl. auto-resume pause handling). */
const FOLLOW_POLL_WINDOW_MS = 10_000;

/** An empty event source — passed to `waitForExecution` in the fallback so it
 *  skips SSE entirely and drops straight to its internal poll loop. */
const noEvents = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: async (): Promise<IteratorResult<never, undefined>> => ({ done: true, value: undefined }),
  }),
});

/**
 * Stream an execution live: render once, then wake on each {@link watchExecution}
 * SSE event, refetch the canonical projection, and re-render until the run
 * reaches a terminal status. In a TTY the tree is redrawn in place; otherwise
 * each snapshot is appended. Ctrl-C aborts the stream and returns cleanly. If the
 * SSE handshake fails or the stream drops mid-run, it degrades to the
 * `waitForExecution` poll loop for the rest of the run — no functional regression.
 */
async function followExecution(executionId: string, client: GatewayClient, renderOpts: RenderOptions): Promise<void> {
  const jsonMode = isJsonMode();
  const renderer = new LiveRenderer(Boolean(process.stdout.isTTY));

  const emit = (ex: ExecutionProjection, final: boolean): void => {
    // JSON is a machine contract: emit only the final, authoritative projection
    // once (avoids ambiguous concatenated JSON). Humans get every live frame.
    if (jsonMode) {
      if (final) ok({ execution: ex });
    } else {
      renderer.render(renderExecutionTree(ex, renderOpts));
    }
  };

  let ex = await inspect({ executionId }, client);
  if (isExecutionTerminal(ex.status)) {
    emit(ex, true);
    return;
  }
  emit(ex, false);

  const abort = new AbortController();
  let aborted = false;
  const onSigint = (): void => {
    aborted = true;
    abort.abort();
  };
  process.once('SIGINT', onSigint);

  try {
    // Primary path: wake on each SSE event, refetch, re-render. Manual iterator
    // (not for-await) so teardown is explicit — `events.return()` in the finally
    // aborts the underlying fetch even when we break early or throw.
    const events = watchExecution({ executionId, signal: abort.signal }, client)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await events.next(); // resolves on each event (heartbeats filtered)
        if (next.done || aborted) break;
        ex = await inspect({ executionId }, client);
        if (isExecutionTerminal(ex.status)) {
          emit(ex, true);
          return;
        }
        emit(ex, false);
      }
    } catch {
      // SSE unavailable / dropped — fall through to the poll fallback below.
    } finally {
      await events.return?.(undefined);
    }
    if (aborted) {
      emit(ex, true);
      return;
    }

    // Fallback: inherit `waitForExecution` poll + settle semantics, re-rendering
    // each window. Stops on terminal or a pause that needs an external signal.
    for (;;) {
      const result = await waitForExecution(
        { executionId, maxWaitMs: FOLLOW_POLL_WINDOW_MS, watch: () => noEvents() },
        client,
      );
      ex = result.execution;
      if (aborted) {
        emit(ex, true);
        return;
      }
      if (result.done || result.reason === 'needs-signal') {
        emit(ex, true);
        return;
      }
      emit(ex, false); // reason === 'timeout' — still in flight, keep polling
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (aborted) renderer.finish();
  }
}

/**
 * Renders successive snapshots to stdout. In a TTY it clears the previous render
 * (cursor up + clear-to-end) so the tree updates in place; otherwise it appends
 * each snapshot separated by a blank line. Purely stdout side effects — the tree
 * formatting itself lives in the pure `render` module.
 */
class LiveRenderer {
  private lastLineCount = 0;

  constructor(
    private readonly tty: boolean,
    private readonly write: (s: string) => void = (s) => void process.stdout.write(s),
  ) {}

  render(lines: string[]): void {
    if (this.lastLineCount > 0) {
      // Move up over the previous render and clear to end of screen (TTY), or
      // separate successive snapshots with a blank line (non-TTY / piped).
      if (this.tty) this.write(`\x1b[${this.lastLineCount}A\x1b[0J`);
      else this.write('\n');
    }
    this.write(lines.join('\n') + '\n');
    this.lastLineCount = lines.length;
  }

  /** Leave the cursor on a fresh line after an interrupted (Ctrl-C) follow. */
  finish(): void {
    if (this.tty && this.lastLineCount > 0) this.write('\n');
  }
}
