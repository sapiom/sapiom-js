import { DIRECTIVE_KIND } from '@sapiom/orchestration';

import { ADVANCE_RESULT_KIND, type AdvanceResult } from './advance-result.js';
import { EXECUTION_STATUS, type ExecutionState } from './execution-state.js';

/**
 * Map a finished (or already-advanced) execution row to an {@link AdvanceResult}.
 * Used when an advance finds the execution already in a terminal/paused state
 * (e.g. a duplicate advance, or reloading after a crash).
 */
export function outcomeForFinishedRow(row: ExecutionState): AdvanceResult {
  switch (row.status) {
    case EXECUTION_STATUS.PAUSED:
      return {
        kind: ADVANCE_RESULT_KIND.PAUSED,
        directive: {
          kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL,
          signal: {
            name: row.pausedSignalName ?? '',
            correlationId: row.pausedSignalCorrelationId ?? undefined,
          },
        },
      };
    case EXECUTION_STATUS.COMPLETED:
      return { kind: ADVANCE_RESULT_KIND.COMPLETED, output: row.output };
    case EXECUTION_STATUS.FAILED:
    case EXECUTION_STATUS.CANCELLED:
      return { kind: ADVANCE_RESULT_KIND.FAILED, error: row.error };
    default:
      return { kind: ADVANCE_RESULT_KIND.RUNNING };
  }
}
