/**
 * Actions router — backs the direct, in-app agent action macros:
 *   POST /api/workflows/:id/deploy  → deploy the linked agent (build + poll).
 *   POST /api/runs                  → start a prod execution → { executionId }.
 *
 * These are the "direct" replacements for the old CLI/agent-driven macros: the
 * harness server calls the Sapiom backend itself (via {@link deploy} / {@link run}
 * from @sapiom/agent-core), so an action never spawns a subprocess agent and never
 * consumes the user's LLM credits. The Sapiom API key is held server-side and
 * never forwarded to the browser — exactly like {@link createRunsRouter}: the
 * SPA hits these local `/api/*` routes (no key in the request) and the router
 * presents the key to the backend on its behalf.
 *
 * Deploy streams its build lifecycle as NDJSON (one JSON object per line, the
 * same line-oriented convention the local-run stream uses) so the canvas can
 * show "building…" the moment the build kicks off and a terminal line when it
 * settles. Prod-run is a single request/response returning `{ executionId }`,
 * which the existing live-canvas path then polls via the runs router.
 *
 * Run-local (`POST /api/runs/local`) is the offline sibling: it spawns the
 * run-local bootstrap child, which runs the workflow in-process against stub
 * capabilities and streams NDJSON back — one {@link LocalStepTrace} per line,
 * then a terminal summary carrying `unusedStubs`/`stubWarnings`. It needs no
 * API key and makes no network call, so it works signed-out and at zero cost.
 */

import { spawn as spawnChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "express";
import {
  AgentOperationError,
  createClient,
  deploy as coreDeploy,
  run as coreRun,
  readConfig as coreReadConfig,
  type DeployResult,
  type RunResult,
  type SapiomConfig,
} from "@sapiom/agent-core";

import { resolveCoreBaseUrl } from "../core/definition-slug-resolver.js";
import type { RunLocalRequest } from "../core/run-local-bootstrap.js";
import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "../core/api-key-provider.js";

/**
 * A registered workflow the actions router can act on — the subset of
 * {@link WorkflowInfo} deploy needs. Resolved by the injected
 * {@link ActionsRouterOpts.resolveWorkflow} so the router stays decoupled from
 * the registry (mirrors the rest router's `findWorkflow` seam).
 */
export interface ActionWorkflow {
  /** Absolute path to the agent project directory (deploy's `projectDir`). */
  path: string;
}

/**
 * One line of the deploy NDJSON stream. `building` is emitted once the build is
 * triggered; exactly one terminal line (`ready` | `error`) closes the stream.
 * `capability`-agnostic and credential-free by construction.
 */
export type DeployStreamEvent =
  | { phase: "building"; definitionId: string }
  | { phase: "ready"; definitionId: string; buildRunId: string; status: string }
  | { phase: "error"; code: string; message: string; hint?: string };

/**
 * Injectable core operations. Real implementations are the @sapiom/agent-core
 * exports; tests substitute fakes so no route ever touches git or the network.
 * Undocumented for prod — a test seam only, mirroring `fetchImpl` in runs.ts.
 */
export interface ActionsCoreDeps {
  createClient: typeof createClient;
  deploy: typeof coreDeploy;
  run: typeof coreRun;
  readConfig: typeof coreReadConfig;
}

const DEFAULT_CORE_DEPS: ActionsCoreDeps = {
  createClient,
  deploy: coreDeploy,
  run: coreRun,
  readConfig: coreReadConfig,
};

/**
 * The slice of node's ChildProcess the run-local route uses — injectable so
 * tests drive a fake child (a scripted stdout stream) without spawning a real
 * `node` process. Mirrors {@link TaskProcess} in task-manager.ts.
 */
export interface RunLocalChildProcess {
  /** Where the request JSON is written; closed immediately after. */
  stdin: NodeJS.WritableStream | null;
  /** Line-oriented NDJSON the route forwards to the HTTP response. */
  stdout: NodeJS.ReadableStream | null;
  /** Diagnostics; a bounded tail is kept for failure reporting. */
  stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** Spawn the run-local bootstrap child. Test seam — defaults to `node`ing the
 *  compiled bootstrap. */
export type RunLocalSpawnFn = () => RunLocalChildProcess;

/**
 * Resolve the compiled run-local bootstrap entry. This module lives at
 * `dist/server/actions.js` (built) or `src/server/actions.ts` (tsx dev /
 * vitest) — the bootstrap is its sibling one directory over in `core/`, with
 * the same `.js`/`.ts` extension as this file. Reading the extension off
 * `import.meta.url` (rather than hard-coding `.js`) keeps a real dev-server
 * spawn resolvable too. Exported for unit coverage of the path math.
 */
export function resolveRunLocalBootstrapPath(moduleUrl: string): string {
  const here = fileURLToPath(moduleUrl);
  const ext = here.endsWith(".ts") ? ".ts" : ".js";
  return join(dirname(here), "..", "core", `run-local-bootstrap${ext}`);
}

/**
 * The default spawn: `node <bootstrap>` with `cwd` set to this package's root
 * so the bootstrap's `import "@sapiom/agent-core"` resolves against the
 * harness's real dependency (same technique as canvas-manifest-check). A `.ts`
 * bootstrap (dev only) is loaded through the `tsx` register hook; the built
 * `.js` runs on bare node. stdin is piped so the route can write the request.
 */
function defaultRunLocalSpawn(): RunLocalChildProcess {
  const bootstrap = resolveRunLocalBootstrapPath(import.meta.url);
  const nodeArgs = bootstrap.endsWith(".ts")
    ? ["--import", "tsx", bootstrap]
    : [bootstrap];
  return spawnChildProcess(process.execPath, nodeArgs, {
    cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Bounded stderr tail kept per run-local child for failure display. */
const RUN_LOCAL_STDERR_TAIL_CHARS = 2_000;

/**
 * The run-local request body the SPA POSTs. `sourceDir` is required; the rest
 * mirror {@link RunLocalRequest} and are forwarded to the bootstrap as-is.
 */
function parseRunLocalBody(body: unknown): RunLocalRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sourceDir !== "string" || b.sourceDir.trim() === "") return null;
  return {
    sourceDir: b.sourceDir,
    input: b.input,
    stubs: b.stubs as RunLocalRequest["stubs"],
    maxAttemptsPerStep:
      typeof b.maxAttemptsPerStep === "number"
        ? b.maxAttemptsPerStep
        : undefined,
  };
}

export interface ActionsRouterOpts {
  /**
   * Sapiom credential the deploy/prod-run actions authenticate with. Accepts
   * either a plain `string | null` (the boot-time key) or an
   * {@link ApiKeyProvider}; pass a provider — exactly like
   * {@link createRunsRouter} — so a rejected key can refresh + retry and so each
   * request reads the current key rather than a boot-time snapshot. This is the
   * API key (`sk_…`), NOT the local boot token. `null` (or a provider whose
   * `getKey()` is null) means the harness is not signed in.
   */
  apiKey: string | null | ApiKeyProvider;
  /**
   * Backend host for @sapiom/agent-core's GatewayClient (the CORE surface —
   * `/v1/workflows` is appended by the client). Resolved from env by default.
   * Test seam.
   */
  coreBaseUrl?: string;
  /**
   * Resolve a workflow `:id` (as it appears in the route path) to the registered
   * workflow, or null when unknown. The caller supplies this from the live
   * registry — the router does not read the registry directly.
   */
  resolveWorkflow: (id: string) => ActionWorkflow | null;
  /** Injectable core operations. Test seam; defaults to the real exports. */
  coreDeps?: Partial<ActionsCoreDeps>;
  /**
   * Spawn the run-local bootstrap child. Undocumented for prod — a test seam
   * only (defaults to `node`ing the compiled bootstrap), so a test can stream a
   * scripted trace without spawning a real process, mirroring `fetchImpl` in
   * runs.ts and the `spawnProcess` seam in task-manager.ts.
   */
  runLocalSpawn?: RunLocalSpawnFn;
}

/**
 * Extract the linked `definitionId` from a project's `sapiom.json`. The config
 * file — not the registry — is the source of truth for a project's server-side
 * definition id, so both deploy and (a future) resolve path read it here. Never
 * throws: an unlinked/unreadable project returns null and the route maps that to
 * a 409.
 */
function readDefinitionId(
  readConfig: typeof coreReadConfig,
  projectDir: string,
): string | null {
  let config: SapiomConfig | null;
  try {
    config = readConfig(projectDir);
  } catch {
    // BAD_CONFIG (unparseable sapiom.json) — treat as "not linked" for the route.
    return null;
  }
  return config?.definitionId ?? null;
}

/**
 * Map an {@link AgentOperationError} (or any thrown value) to a terminal deploy
 * stream event. The hint is forwarded — it is safe to do so because git errors
 * are redacted at source (credentials stripped before they reach the hint field),
 * so no key material can reach the browser via this path.
 */
function toDeployErrorEvent(
  err: unknown,
): Extract<DeployStreamEvent, { phase: "error" }> {
  if (err instanceof AgentOperationError) {
    return {
      phase: "error",
      code: err.code,
      message: err.message,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    };
  }
  return {
    phase: "error",
    code: "UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Whether a thrown value is an upstream "the API key was rejected" — worth one
 * refresh + retry before giving up. agent-core maps a 401/403 to an
 * {@link AgentOperationError} with `code: "HTTP_401" | "HTTP_403"` (see
 * client.ts), so we match on that code rather than an HTTP status here — the
 * error-code analogue of run-state.ts's `isAuthRejection(status)`.
 */
function isAuthRejectionError(err: unknown): boolean {
  return (
    err instanceof AgentOperationError &&
    (err.code === "HTTP_401" || err.code === "HTTP_403")
  );
}

/**
 * Run a core operation with the current API key and, when it fails with an auth
 * rejection, refresh the shared credential store once and retry with the newer
 * key — the deploy/prod-run analogue of run-state.ts's refresh-on-401 recovery.
 *
 * `invoke` is handed a freshly-minted client for the key in force (the boot key
 * on the first attempt, the refreshed key on the retry) so a rotated/re-logged-in
 * credential recovers in place instead of every action locking on the stale key.
 * Retries only when refresh actually yields a *different, non-null* key —
 * otherwise the original error is re-thrown unchanged (no wasted call, and the
 * caller's error mapping sees the real auth failure).
 *
 * The caller has already checked `provider.getKey()` is non-null, so `apiKey!`
 * here is safe; a concurrent sign-out would surface as a normal auth error.
 */
async function withKeyRefreshRetry<T>(
  provider: ApiKeyProvider,
  createClientFor: (apiKey: string) => ReturnType<typeof createClient>,
  invoke: (client: ReturnType<typeof createClient>) => Promise<T>,
): Promise<T> {
  const apiKey = provider.getKey();
  try {
    return await invoke(createClientFor(apiKey!));
  } catch (err) {
    if (!isAuthRejectionError(err)) throw err;
    const refreshed = await provider.refresh();
    if (!refreshed || refreshed === apiKey) throw err;
    return invoke(createClientFor(refreshed));
  }
}

/**
 * Create the actions router. Mounts:
 *   - `POST /api/workflows/:id/deploy` — NDJSON build-status stream.
 *   - `POST /api/runs` — `{ executionId }` for a started prod execution.
 *   - `POST /api/runs/local` — NDJSON offline stub-run trace + summary.
 *
 * Deploy and prod-run run server-side with the held API key; run-local is fully
 * offline and needs no key. None of them ever involve an AI coding agent.
 */
export function createActionsRouter(opts: ActionsRouterOpts): Router {
  const router = Router();
  const deps: ActionsCoreDeps = { ...DEFAULT_CORE_DEPS, ...opts.coreDeps };
  const baseUrl = opts.coreBaseUrl ?? resolveCoreBaseUrl();
  const runLocalSpawn = opts.runLocalSpawn ?? defaultRunLocalSpawn;
  // Normalize to a provider so deploy/prod-run always authenticate with the
  // held API key and can refresh + retry when that key is rejected — a plain
  // string|null becomes a no-op static provider (no refresh). Mirrors the runs
  // router; keeps both action surfaces on the one credential contract.
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  /** Mint a core client for a specific key against the resolved core host. */
  const clientFor = (apiKey: string): ReturnType<typeof createClient> =>
    deps.createClient({ host: baseUrl, apiKey });

  /**
   * POST /api/workflows/:id/deploy
   *
   * Deploys the linked agent for the given workflow id: mints push credentials,
   * pushes the synthesized tree, triggers a build, and polls to a terminal
   * status — all inside @sapiom/agent-core's {@link deploy}. Streams NDJSON: a
   * `building` line up front, then exactly one terminal `ready`/`error` line.
   *
   * 200  NDJSON stream (even a build failure is a 200 with a terminal `error`
   *      line — the request itself succeeded; the build outcome is in-band).
   * 400  id missing/empty
   * 404  workflow id not registered
   * 409  workflow is not linked to a Sapiom agent (no definitionId)
   * 503  harness is not signed in to Sapiom
   */
  router.post("/api/workflows/:id/deploy", async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "workflow id is required" });
      return;
    }
    if (!provider.getKey()) {
      res.status(503).json({ error: "harness is not signed in to Sapiom" });
      return;
    }

    const workflow = opts.resolveWorkflow(id);
    if (!workflow) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const definitionId = readDefinitionId(deps.readConfig, workflow.path);
    if (!definitionId) {
      res
        .status(409)
        .json({ error: "workflow is not linked to a Sapiom agent" });
      return;
    }

    // From here the outcome is streamed in-band as NDJSON — status is 200 and
    // headers are committed before the (potentially long) build runs.
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const write = (event: DeployStreamEvent): void => {
      res.write(JSON.stringify(event) + "\n");
    };

    write({ phase: "building", definitionId });

    try {
      // Auth against the live key, refreshing + retrying once on a rejected key
      // (same recovery the runs router gets). The building/terminal streaming
      // shape is unchanged — the retry is transparent to the NDJSON stream.
      const result: DeployResult = await withKeyRefreshRetry(
        provider,
        clientFor,
        (client) =>
          deps.deploy({ projectDir: workflow.path, definitionId }, client),
      );
      write({
        phase: "ready",
        definitionId: result.definitionId,
        buildRunId: result.buildRunId,
        status: result.status,
      });
    } catch (err) {
      write(toDeployErrorEvent(err));
    } finally {
      res.end();
    }
  });

  /**
   * POST /api/runs  { definitionId, input }
   *
   * Starts a prod execution of the given definition and returns
   * `{ executionId }` — the live-canvas path then polls the runs router for its
   * per-step state. `input` is optional (defaults to an empty object for
   * no-input agents). The key stays server-side.
   *
   * 200  { executionId } — execution created
   * 400  definitionId missing/empty
   * 502  gateway error (network or non-2xx from the backend)
   * 503  harness is not signed in to Sapiom
   */
  router.post("/api/runs", async (req, res) => {
    if (!provider.getKey()) {
      res.status(503).json({ error: "harness is not signed in to Sapiom" });
      return;
    }

    const body = (req.body ?? {}) as {
      definitionId?: unknown;
      input?: unknown;
    };
    const definitionId = body.definitionId;
    if (typeof definitionId !== "string" || definitionId.trim() === "") {
      res.status(400).json({ error: "definitionId is required" });
      return;
    }

    try {
      // Auth against the live key, refreshing + retrying once on a rejected key
      // (same recovery the runs router gets), then return { executionId }.
      const result: RunResult = await withKeyRefreshRetry(
        provider,
        clientFor,
        (client) => deps.run({ definitionId, input: body.input }, client),
      );
      res.json({ executionId: result.executionId });
    } catch (err) {
      if (err instanceof AgentOperationError) {
        // The gateway/network failed — surface a 502 with the machine code, no
        // credential hint (that hint names the login flow, not for the browser).
        res.status(502).json({ error: err.message, code: err.code });
      } else {
        res
          .status(502)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  /**
   * POST /api/runs/local  { sourceDir, input?, stubs?, maxAttemptsPerStep? }
   *
   * Runs the workflow at `sourceDir` entirely offline against stub
   * capabilities, in a child process (the run-local bootstrap), and streams the
   * result back as NDJSON: one {@link LocalStepTrace} per line, then a terminal
   * summary line `{ kind: "summary", outcome, output, error, unusedStubs,
   * stubWarnings }`. A run that could not be invoked at all (bad project, bad
   * stub file) yields a terminal `{ kind: "error", outcome: "failed", error }`
   * line instead. Needs no API key and makes no network call — zero cost.
   *
   * The child owns the wire shapes; this handler validates the request, pipes
   * it to the child's stdin, forwards each stdout line unchanged, and (only if
   * the child dies without a terminal line) synthesizes one from its stderr so
   * the stream always ends well-formed.
   *
   * 200  NDJSON stream (a failed *run* is still a 200 — the request succeeded;
   *      the outcome is in-band on the terminal line).
   * 400  sourceDir missing/empty
   */
  router.post("/api/runs/local", (req, res) => {
    const request = parseRunLocalBody(req.body);
    if (!request) {
      res.status(400).json({ error: "sourceDir is required" });
      return;
    }

    let child: RunLocalChildProcess;
    try {
      child = runLocalSpawn();
    } catch (err) {
      // Never launched (e.g. the node binary or bootstrap is missing) — the
      // request itself is fine, so answer in-band with a terminal error line.
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.write(
        JSON.stringify({
          kind: "error",
          outcome: "failed",
          error: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
      res.end();
      return;
    }

    // Headers are committed before the (potentially long) run streams.
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    // Hand the request to the child, then close its stdin so the bootstrap's
    // read-to-EOF completes.
    child.stdin?.end(JSON.stringify(request));

    // Forward each well-formed JSON line straight through — the bootstrap emits
    // exactly the wire shapes, so no re-shaping happens here. A line that isn't
    // JSON is stray stdout noise (an esbuild banner, a dependency's console
    // write) and is dropped rather than corrupting the NDJSON stream — the same
    // "degrade, never throw" stance as core/task-stream.ts.
    let sawTerminalLine = false;
    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // non-JSON noise — not part of the contract.
      }
      // A `summary`/`error` line is terminal — track it so a crash after the
      // summary isn't double-reported as a failure.
      const kind = (parsed as { kind?: unknown }).kind;
      if (kind === "summary" || kind === "error") sawTerminalLine = true;
      res.write(trimmed + "\n");
    };

    // Keep a bounded stderr tail for the crash path (never forwarded inline —
    // stderr is diagnostics, not part of the NDJSON contract).
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(
        -RUN_LOCAL_STDERR_TAIL_CHARS,
      );
    });

    // End the response exactly once (mirrors task-manager's finish() guard).
    // `crashReason` is captured from `exit`/`error` but the terminal decision is
    // deferred to `settle()` so a still-buffered summary line is never clobbered.
    let settled = false;
    let crashReason: string | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      // Only synthesize a terminal line when the child produced none — otherwise
      // the stream already ended well-formed with the bootstrap's own summary.
      if (!sawTerminalLine) {
        res.write(
          JSON.stringify({
            kind: "error",
            outcome: "failed",
            error:
              stderrTail.trim() || crashReason || "run-local produced no output",
          }) + "\n",
        );
      }
      res.end();
    };

    // Drive the terminal decision off stdout's close (readline "close" fires
    // only after every line has been emitted), so a summary line buffered when
    // `exit` arrives is still forwarded first. If there's no stdout at all, fall
    // back to `exit`/`error` directly.
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", onLine);
      lines.on("close", settle);
      child.on("error", (err) => {
        crashReason = err.message;
      });
      child.on("exit", (code) => {
        crashReason ??= `run-local process exited with code ${code ?? "null"}`;
      });
    } else {
      child.on("error", (err) => {
        crashReason = err.message;
        settle();
      });
      child.on("exit", (code) => {
        crashReason ??= `run-local process exited with code ${code ?? "null"}`;
        settle();
      });
    }
  });

  return router;
}
