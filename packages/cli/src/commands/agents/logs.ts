import {
  AgentOperationError,
  type ExecutionProjection,
  type GatewayClient,
  type SseEvent,
  type WaitForExecutionOptions,
  type WaitForExecutionResult,
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
export const noEvents = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: async (): Promise<IteratorResult<never, undefined>> => ({ done: true, value: undefined }),
  }),
});

/** Injectable seams for {@link followExecution} — the networked calls and the
 *  render sink. Production passes nothing; tests supply fakes to drive the
 *  SSE → fallback → abort paths deterministically without a real gateway. */
export interface FollowOverrides {
  inspect?: (opts: { executionId: string }, client: GatewayClient) => Promise<ExecutionProjection>;
  watchExecution?: (opts: { executionId: string; signal?: AbortSignal }, client: GatewayClient) => AsyncIterable<SseEvent>;
  waitForExecution?: (opts: WaitForExecutionOptions, client: GatewayClient) => Promise<WaitForExecutionResult>;
  renderer?: LiveRenderer;
  jsonMode?: boolean;
  /** An extra abort trigger in addition to Ctrl-C (tests drive teardown through this). */
  signal?: AbortSignal;
}

/**
 * Stream an execution live: render once, then wake on each {@link watchExecution}
 * SSE event, refetch the canonical projection, and re-render until the run
 * reaches a terminal status. In a TTY the tree is redrawn in place; otherwise
 * each snapshot is appended. Ctrl-C aborts the stream and returns cleanly. If the
 * SSE handshake fails or the stream drops mid-run, it degrades to the
 * `waitForExecution` poll loop for the rest of the run — no functional regression.
 */
export async function followExecution(
  executionId: string,
  client: GatewayClient,
  renderOpts: RenderOptions,
  overrides: FollowOverrides = {},
): Promise<void> {
  const inspectFn = overrides.inspect ?? inspect;
  const watchFn = overrides.watchExecution ?? watchExecution;
  const waitFn = overrides.waitForExecution ?? waitForExecution;
  const jsonMode = overrides.jsonMode ?? isJsonMode();
  const renderer = overrides.renderer ?? new LiveRenderer(Boolean(process.stdout.isTTY));

  const emit = (ex: ExecutionProjection, final: boolean): void => {
    // JSON is a machine contract: emit only the final, authoritative projection
    // once (avoids ambiguous concatenated JSON). Humans get every live frame.
    if (jsonMode) {
      if (final) ok({ execution: ex });
    } else {
      renderer.render(renderExecutionTree(ex, renderOpts));
    }
  };

  let ex = await inspectFn({ executionId }, client);
  if (isExecutionTerminal(ex.status)) {
    emit(ex, true);
    return;
  }
  emit(ex, false);

  const abort = new AbortController();
  let aborted = false;
  const doAbort = (): void => {
    aborted = true;
    abort.abort();
  };
  process.once('SIGINT', doAbort);
  if (overrides.signal) {
    if (overrides.signal.aborted) doAbort();
    else overrides.signal.addEventListener('abort', doAbort, { once: true });
  }

  // A poll sleep that wakes immediately on Ctrl-C, and a clock that reads past
  // the deadline once aborted — together these make `waitForExecution` in the
  // fallback return promptly on abort (within one refetch) instead of blocking
  // for the rest of a poll window.
  const abortableSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (abort.signal.aborted) return resolve();
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  const abortAwareNow = (): number => (aborted ? Number.MAX_SAFE_INTEGER : Date.now());

  try {
    // Primary path: wake on each SSE event, refetch, re-render. Manual iterator
    // (not for-await) so teardown is explicit — `events.return()` in the finally
    // aborts the underlying fetch even when we break early or throw.
    const events = watchFn({ executionId, signal: abort.signal }, client)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await events.next(); // resolves on each event (heartbeats filtered)
        if (next.done || aborted) break;
        ex = await inspectFn({ executionId }, client);
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
    // each window. Stops on terminal, a pause that needs an external signal, or
    // Ctrl-C (the abort-aware sleep/clock make the current window return at once).
    for (;;) {
      if (aborted) {
        emit(ex, true);
        return;
      }
      const result = await waitFn(
        { executionId, maxWaitMs: FOLLOW_POLL_WINDOW_MS, watch: () => noEvents(), sleep: abortableSleep, now: abortAwareNow },
        client,
      );
      ex = result.execution;
      if (aborted || result.done || result.reason === 'needs-signal') {
        emit(ex, true);
        return;
      }
      emit(ex, false); // reason === 'timeout' — still in flight, keep polling
    }
  } finally {
    process.removeListener('SIGINT', doAbort);
    overrides.signal?.removeEventListener('abort', doAbort);
    if (aborted) renderer.finish();
  }
}

/** Count code points — a good-enough display width for the CLI's charset (ASCII
 *  plus width-1 box/status glyphs); avoids counting UTF-16 surrogate pairs
 *  twice. Not full East-Asian-width aware, which the log content never needs. */
function displayWidth(line: string): number {
  return Array.from(line).length;
}

/**
 * Renders successive snapshots to stdout. In a TTY it clears the previous render
 * and redraws in place; otherwise it appends each snapshot separated by a blank
 * line. Purely stdout side effects — the tree formatting lives in the pure
 * `render` module.
 *
 * In-place clearing counts PHYSICAL rows, not logical lines: a headline wider
 * than the terminal wraps to multiple rows, so moving the cursor up by the line
 * count would leave stale wrapped rows and corrupt the redraw on narrow
 * terminals. `columns` is read fresh each render so a resize is (mostly) tolerated.
 */
export class LiveRenderer {
  private lastRows = 0;

  constructor(
    private readonly tty: boolean,
    private readonly write: (s: string) => void = (s) => void process.stdout.write(s),
    private readonly columns: () => number = () => process.stdout.columns || 80,
  ) {}

  /** Physical rows a set of lines occupies at the given width (min 1 per line). */
  private rowsFor(lines: string[], cols: number): number {
    const width = cols > 0 ? cols : 80;
    return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / width)), 0);
  }

  render(lines: string[]): void {
    if (this.lastRows > 0) {
      // Move up over the previous render's physical rows and clear to end of
      // screen (TTY), or separate successive snapshots with a blank line.
      if (this.tty) this.write(`\x1b[${this.lastRows}A\x1b[0J`);
      else this.write('\n');
    }
    this.write(lines.join('\n') + '\n');
    this.lastRows = this.tty ? this.rowsFor(lines, this.columns()) : lines.length;
  }

  /** Leave the cursor on a fresh line after an interrupted (Ctrl-C) follow. */
  finish(): void {
    if (this.tty && this.lastRows > 0) this.write('\n');
  }
}
