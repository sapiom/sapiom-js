/**
 * Runs `@sapiom/agent-core`'s `check()` in an isolated child process, rather
 * than importing it in-process. Two independent reasons:
 *
 *  1. `check()` dynamically `import()`s an esbuild-bundled copy of whatever
 *     TypeScript the target workflow's `index.ts` contains — a workflow
 *     project the harness doesn't control. Running that inside the harness's
 *     own long-lived server process would let a stray top-level side effect,
 *     infinite loop, or crash in someone else's workflow code take the whole
 *     harness down. A child process bounds the blast radius to one failed
 *     render.
 *  2. It sidesteps a real Vite/Vitest limitation: `check()`'s own dynamic
 *     `import(\`file://${tmpPath}\`)` gets intercepted by Vite's SSR
 *     dynamic-import-vars transform when anything imports `check` directly
 *     into a Vitest-run module graph, and mishandles the tmpdir's `file://`
 *     URL on darwin ("File URL host must be 'localhost' or empty"),
 *     corrupting every extraction. A plain child `node` process never goes
 *     through that transform.
 *
 * The child process is a short inline ESM script (no separate file to keep
 * in sync across dev/build) run with `cwd` set to this package's own root,
 * so `import { check } from "@sapiom/agent-core"` resolves against the
 * harness's real dependency — exactly like the CLI's own `sapiom agents
 * check` already runs it, just invoked programmatically instead of as a
 * subcommand.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Hard ceiling, not the performance target — bundling a small workflow is
 *  typically well under a second; this only guards against a pathological
 *  project (a huge dependency tree, a hanging top-level side effect) from
 *  blocking a render indefinitely. */
const CHECK_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// This module lives at either src/core/ (tsx dev, vitest) or dist/core/
// (built) — both two directories below the package root.
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const RUNNER_SOURCE = `
import { check, AgentOperationError } from "@sapiom/agent-core";

function reasonFor(err) {
  if (err instanceof AgentOperationError) return err.hint ? \`\${err.message} \${err.hint}\` : err.message;
  return err instanceof Error ? err.message : String(err);
}

const sourceDir = process.env.SAPIOM_CANVAS_CHECK_SOURCE_DIR;
try {
  // typecheck: false — a diagram only needs the manifest/graph, and the
  // project's own tsc --noEmit is the dominant multi-second per-render cost;
  // esbuild still surfaces real breakage (bad imports, syntax errors).
  const result = await check({ sourceDir, typecheck: false });
  process.stdout.write(JSON.stringify({ ok: true, manifest: result.manifest, warnings: result.warnings }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, reason: reasonFor(err) }));
}
`;

export interface ManifestCheckSuccess {
  ok: true;
  manifest: unknown;
  warnings: string[];
}

export interface ManifestCheckFailure {
  ok: false;
  reason: string;
}

export type ManifestCheckResult = ManifestCheckSuccess | ManifestCheckFailure;

/** Runs `check({ sourceDir })` in a child `node` process; never throws or
 *  rejects — a crash, timeout, or unparsable output all come back as a
 *  `ManifestCheckFailure` with a human-readable reason. */
export function runManifestCheck(sourceDir: string): Promise<ManifestCheckResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", RUNNER_SOURCE],
      {
        cwd: packageRoot(),
        env: { ...process.env, SAPIOM_CANVAS_CHECK_SOURCE_DIR: sourceDir },
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
      },
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed && err.signal === "SIGTERM";
          resolve({
            ok: false,
            reason: timedOut
              ? `Extraction timed out after ${CHECK_TIMEOUT_MS / 1000}s.`
              : (stderr.trim() || err.message),
          });
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ManifestCheckResult);
        } catch {
          resolve({ ok: false, reason: `Unexpected output from the check process: ${stdout.slice(0, 500)}` });
        }
      },
    );
  });
}
