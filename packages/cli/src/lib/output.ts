/**
 * Output contract shared by every command: a single success object or a
 * structured error, rendered for humans by default and as JSON under `--json`.
 * Keeping this in one place is what makes the CLI legible to both people and
 * coding agents.
 */

export interface StructuredError {
  code: string;
  message: string;
  step?: string;
  hint?: string;
  docsUrl?: string;
}

/** A command failure carrying a machine-readable code and an actionable hint. */
export class CliError extends Error {
  readonly code: string;
  readonly step?: string;
  readonly hint?: string;
  readonly docsUrl?: string;

  constructor(err: StructuredError) {
    super(err.message);
    this.name = 'CliError';
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

let jsonMode = false;

/** Set per-command once the `--json` flag is parsed. */
export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Print a successful result. `data` is emitted verbatim under `--json`. */
export function ok(data: Record<string, unknown>, lines: string[] = []): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
    return;
  }
  for (const line of lines) process.stdout.write(line + '\n');
}

/** Print a structured error to stderr and set a non-zero exit code. */
export function fail(error: unknown): void {
  const structured: StructuredError =
    error instanceof CliError
      ? error.toStructured()
      : { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };

  if (jsonMode) {
    process.stderr.write(JSON.stringify({ ok: false, error: structured }, null, 2) + '\n');
  } else {
    process.stderr.write(`✗ ${structured.message}\n`);
    if (structured.step) process.stderr.write(`  step: ${structured.step}\n`);
    if (structured.hint) process.stderr.write(`  hint: ${structured.hint}\n`);
    if (structured.docsUrl) process.stderr.write(`  docs: ${structured.docsUrl}\n`);
  }
  process.exitCode = 1;
}
