/**
 * Structured error type shared across orchestration-core operations. Kept
 * separate from CLI rendering (no process.stderr, no process.exitCode) so it
 * can be caught and re-shaped by any consumer (CLI, MCP, programmatic).
 */

export interface StructuredError {
  code: string;
  message: string;
  step?: string;
  hint?: string;
  docsUrl?: string;
}

/** A typed, machine-readable failure from any core operation. */
export class AgentOperationError extends Error {
  readonly code: string;
  readonly step?: string;
  readonly hint?: string;
  readonly docsUrl?: string;

  constructor(err: StructuredError) {
    super(err.message);
    this.name = 'AgentOperationError';
    this.code = err.code;
    this.step = err.step;
    this.hint = err.hint;
    this.docsUrl = err.docsUrl;
  }

  toStructured(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      ...(this.step ? { step: this.step } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.docsUrl ? { docsUrl: this.docsUrl } : {}),
    };
  }
}
