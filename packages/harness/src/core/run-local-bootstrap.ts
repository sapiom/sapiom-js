/**
 * run-local bootstrap — the child-process entrypoint behind
 * `POST /api/runs/local`.
 *
 * It runs an agent entirely in-process against stub capabilities
 * (`runLocalFromDir` from @sapiom/agent-core) and writes the result as an
 * NDJSON stream to stdout: one line per {@link LocalStepTrace}, then a single
 * terminal summary line `{ outcome, output, error, unusedStubs, stubWarnings }`.
 * Fully offline and zero-cost — run-local resolves every `ctx.sapiom.*` call
 * from stubs and never touches the network.
 *
 * Why a separate child process (not an in-process import):
 *  1. `runLocalFromDir` esbuild-bundles and dynamically `import()`s a workflow
 *     project the harness doesn't control, so a stray top-level side effect,
 *     infinite loop, or crash in someone else's step body is bounded to this
 *     one child instead of taking the long-lived harness server down.
 *  2. It sidesteps a Vite/Vitest limitation: the dynamic `import(\`file://…\`)`
 *     inside the loader gets intercepted by the SSR dynamic-import-vars
 *     transform when pulled into a Vitest module graph, and mishandles the
 *     tmpdir `file://` URL on darwin. A plain child `node` process never goes
 *     through that transform. (Mirrors the reasoning in canvas-manifest-check.)
 *
 * Contract with the route ({@link createActionsRouter}):
 *  - Request arrives as one JSON object on **stdin**: `{ sourceDir, input?,
 *    stubs?, maxAttemptsPerStep? }`.
 *  - Output is line-oriented JSON on **stdout** — the route forwards each line
 *    through unchanged, so the shapes here ARE the wire shapes the SPA parses.
 *  - Diagnostics go to **stderr**; the route keeps a bounded tail for failures.
 *  - Exit 0 once the terminal line is written (even for a failed run — a failed
 *    *run* is a successful *invocation*); exit 1 only when no run happened
 *    (bad request, load error) after writing a terminal `error` line.
 */
import {
  runLocalFromDir,
  type LocalStepTrace,
  type LocalRunOutcome,
  type StubFile,
} from "@sapiom/agent-core";

/** The request shape the route writes to this child's stdin. */
export interface RunLocalRequest {
  /** Absolute path to the agent project directory (contains `index.ts`). */
  sourceDir: string;
  /** The workflow's entry-step input (optional; agent-core defaults it). */
  input?: unknown;
  /** Explicit stub overrides. When omitted the project's committed
   *  `.sapiom-dev/stubs.json` is used (agent-core's own precedence). */
  stubs?: StubFile;
  /** Per-step attempt cap (optional; agent-core defaults it). */
  maxAttemptsPerStep?: number;
}

/**
 * The terminal NDJSON line, written after every per-step trace line. Carries
 * the run-level outcome and the two stub-hygiene signals the inspector surfaces
 * (WB15-2): `unusedStubs` (supplied keys that matched no capability call) and
 * `stubWarnings` (keys that matched but carried the wrong shape).
 *
 * `kind: "summary"` discriminates it from a step-trace line so a consumer never
 * has to guess which line is terminal.
 */
export interface RunLocalSummaryLine {
  kind: "summary";
  outcome: LocalRunOutcome;
  output?: unknown;
  error?: unknown;
  unusedStubs: Array<{ step: string; key: string }>;
  stubWarnings: string[];
}

/**
 * The terminal line written when the run could not be *invoked* at all — a
 * malformed request, an unreadable stub file, a project that fails to load.
 * `outcome` is always `"failed"`; the child then exits non-zero. Distinct from
 * a `summary` line, which represents a run that actually executed (even if that
 * run's own outcome was `failed`).
 */
export interface RunLocalErrorLine {
  kind: "error";
  outcome: "failed";
  error: string;
}

/** Read the entire request payload from a readable stream as one UTF-8 string. */
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse the stdin payload into a {@link RunLocalRequest}. Throws a plain Error
 * with a caller-safe message (no key material, no provider names) on anything
 * that isn't a JSON object carrying a non-empty string `sourceDir`.
 */
export function parseRunLocalRequest(raw: string): RunLocalRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("run-local request is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("run-local request must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const sourceDir = body.sourceDir;
  if (typeof sourceDir !== "string" || sourceDir.trim() === "") {
    throw new Error("run-local request requires a non-empty sourceDir");
  }
  return {
    sourceDir,
    input: body.input,
    stubs: body.stubs as StubFile | undefined,
    maxAttemptsPerStep:
      typeof body.maxAttemptsPerStep === "number"
        ? body.maxAttemptsPerStep
        : undefined,
  };
}

/** Serialize one step trace as a single NDJSON line (newline-terminated). */
function traceLine(step: LocalStepTrace): string {
  return JSON.stringify(step) + "\n";
}

/** Serialize the terminal summary as a single NDJSON line. */
function summaryLine(line: RunLocalSummaryLine): string {
  return JSON.stringify(line) + "\n";
}

/**
 * Run the request and emit its NDJSON stream to `out`. Returns the process exit
 * code: 0 when a run executed (any outcome), 1 when the run could not be
 * invoked (a terminal `error` line is emitted first). Never throws — every
 * failure becomes an in-band terminal line, because a half-written stream with
 * a thrown stack on stderr is far harder for the route to reason about than a
 * clean terminal line plus an exit code.
 */
export async function runBootstrap(
  request: RunLocalRequest,
  out: NodeJS.WritableStream,
): Promise<number> {
  try {
    const result = await runLocalFromDir({
      sourceDir: request.sourceDir,
      input: request.input,
      stubs: request.stubs,
      maxAttemptsPerStep: request.maxAttemptsPerStep,
    });

    // One line per step-attempt, in execution order — the consumer parses them
    // incrementally rather than buffering the whole trace as a single blob.
    for (const step of result.steps) {
      out.write(traceLine(step));
    }

    const summary: RunLocalSummaryLine = {
      kind: "summary",
      outcome: result.outcome,
      output: result.output,
      error: result.error,
      unusedStubs: result.unusedStubs,
      stubWarnings: result.stubWarnings,
    };
    out.write(summaryLine(summary));
    return 0;
  } catch (err) {
    const errorLine: RunLocalErrorLine = {
      kind: "error",
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
    out.write(JSON.stringify(errorLine) + "\n");
    return 1;
  }
}

/**
 * Entrypoint: read the request from stdin, run it, exit with the run's code.
 * A stdin/read failure (or a request that can't be parsed) also degrades to a
 * terminal `error` line + exit 1 — the route always sees a well-formed final
 * line regardless of how the child failed.
 */
async function main(): Promise<void> {
  let request: RunLocalRequest;
  try {
    request = parseRunLocalRequest(await readAll(process.stdin));
  } catch (err) {
    const errorLine: RunLocalErrorLine = {
      kind: "error",
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
    process.stdout.write(JSON.stringify(errorLine) + "\n");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runBootstrap(request, process.stdout);
}

// Only self-invoke when run as the child entrypoint, never when imported by a
// unit test (which drives runBootstrap / parseRunLocalRequest directly). The
// built entry is dist/core/run-local-bootstrap.js; import.meta.url ends with
// this module's own file, and process.argv[1] is the script node was told to
// run — they share a basename only for the real child launch.
const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedAsScript) {
  void main();
}
