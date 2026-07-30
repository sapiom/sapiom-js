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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "express";
import {
  AgentOperationError,
  createClient,
  deploy as coreDeploy,
  getDefinition as coreGetDefinition,
  link as coreLink,
  run as coreRun,
  readConfig as coreReadConfig,
  writeConfig as coreWriteConfig,
  type DeployResult,
  type LinkResult,
  type RunResult,
  type SapiomConfig,
} from "@sapiom/agent-core";

import { resolveCoreBaseUrl } from "../core/definition-slug-resolver.js";
import { HOST_ESBUILD_PIN, unpackedPath } from "../core/asar-path.js";
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
  /**
   * Registry display name (`package.json`'s `name`, else the folder basename).
   * Optional so a host that only knows the path still works; used as a
   * mid-priority fallback when naming an agent this route has to create.
   */
  name?: string;
}

/**
 * One line of the deploy NDJSON stream. `linking` is emitted only when the
 * project had no `definitionId` and the route is resolving-or-creating its
 * remote agent; `warning` is non-terminal and advisory — it never replaces a
 * terminal line and may appear alongside either outcome (e.g. linking
 * succeeded but caching the id in `sapiom.json` failed); `building` is emitted
 * once the build is triggered; exactly one terminal line (`ready` | `error`)
 * closes the stream. `capability`-agnostic and credential-free by construction.
 */
export type DeployStreamEvent =
  | { phase: "linking"; name: string }
  | { phase: "warning"; message: string }
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
  /** Resolve-or-create the server-side agent for an unlinked project. */
  link: typeof coreLink;
  /** Cache the linked id back into `sapiom.json` (merges; never clobbers). */
  writeConfig: typeof coreWriteConfig;
  /**
   * Verify that a definition id is accessible under the current API key.
   * Returns the definition summary on success; throws `AgentOperationError`
   * (code `HTTP_404` | `HTTP_403` | `HTTP_401` | `NETWORK` | …) on failure.
   * Used by `ensureDefinitionId` to detect foreign ids before falling back.
   */
  getDefinition: typeof coreGetDefinition;
}

const DEFAULT_CORE_DEPS: ActionsCoreDeps = {
  createClient,
  deploy: coreDeploy,
  run: coreRun,
  readConfig: coreReadConfig,
  link: coreLink,
  writeConfig: coreWriteConfig,
  getDefinition: coreGetDefinition,
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
  /** Send a signal to the child process (mirrors node's ChildProcess.kill). */
  kill(signal?: NodeJS.Signals | number): boolean;
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

/** Everything needed to launch the run-local child, resolved but not yet spawned
 *  — so the packaging-sensitive path math is unit-testable. */
export interface RunLocalChildSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve how to launch the run-local bootstrap child: `node <bootstrap>` with
 * `cwd` at this package's root, so the bootstrap's `import "@sapiom/agent-core"`
 * resolves against the harness's real dependency. A `.ts` bootstrap (dev only)
 * goes through the `tsx` register hook; the built `.js` runs on bare node.
 *
 * Three things here exist ONLY for the packaged desktop app, and their absence
 * is why every local run failed there with `spawn ENOTDIR` while the CLI was
 * fine. `canvas-manifest-check.ts` already does all three; this call site did
 * none of them:
 *
 *  1. **cwd must be the unpacked twin.** `import.meta.url` reports a path inside
 *     `app.asar`; nothing translates a child's cwd, so `chdir` fails. ENOTDIR is
 *     not in Node's deferred-error list, so `spawn` throws SYNCHRONOUSLY and the
 *     route answers `{"kind":"error","error":"spawn ENOTDIR"}`.
 *  2. **the script path must be the unpacked twin too.** The child is plain Node
 *     with no asar support whatsoever — it cannot read a file inside the archive,
 *     however well Electron's own `fs` copes.
 *  3. **`ELECTRON_RUN_AS_NODE=1` under Electron.** `process.execPath` is the
 *     Sapiom binary there; without the flag it boots a SECOND COPY OF THE APP
 *     instead of running the script. Only set when actually inside Electron, so
 *     the CLI (real node) is untouched.
 *
 * `ESBUILD_BINARY_PATH` is dropped: the desktop host pins it so its in-process
 * bundler can exec a binary outside app.asar, but no child needs it (a child
 * resolves real on-disk paths itself) and a workflow step body that shells out
 * to the project's own toolchain would hit an esbuild version mismatch.
 */
export function resolveRunLocalChildSpec(
  moduleUrl: string,
  runtime: { execPath: string; env: NodeJS.ProcessEnv; isElectron: boolean },
): RunLocalChildSpec {
  const bootstrap = unpackedPath(resolveRunLocalBootstrapPath(moduleUrl));
  const args = bootstrap.endsWith(".ts")
    ? ["--import", "tsx", bootstrap]
    : [bootstrap];
  // Via the constant, not the literal name. `HOST_ESBUILD_PIN`'s whole purpose is
  // to be the ONE place that key is written, and its doc names this spec as one of
  // the three strippers — but a rest-destructure needs a literal, so renaming the
  // constant would have silently left this child inheriting the pin and hitting
  // `Host version "X" does not match binary version "Y"`.
  const inherited = Object.fromEntries(
    Object.entries(runtime.env).filter(([key]) => key !== HOST_ESBUILD_PIN),
  );
  return {
    command: runtime.execPath,
    args,
    cwd: unpackedPath(join(dirname(fileURLToPath(moduleUrl)), "..", "..")),
    env: {
      ...inherited,
      ...(runtime.isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
}

/** The default spawn. stdin is piped so the route can write the request. */
function defaultRunLocalSpawn(): RunLocalChildProcess {
  const spec = resolveRunLocalChildSpec(import.meta.url, {
    execPath: process.execPath,
    env: process.env,
    isElectron: Boolean(process.versions.electron),
  });
  return spawnChildProcess(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Bounded stderr tail kept per run-local child for failure display. */
const RUN_LOCAL_STDERR_TAIL_CHARS = 2_000;

/**
 * Maximum wall-clock time a run-local child is allowed to run before being
 * forcefully terminated. After this limit the child receives SIGTERM (then
 * SIGKILL after a short grace) and a terminal error line is written to the
 * response stream so the UI displays a clear "timed out" message.
 */
const RUN_LOCAL_MAX_DURATION_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Grace period between the initial SIGTERM and the hard SIGKILL when killing
 * a run-local child (client disconnect or wall-clock timeout). Long enough for
 * the child to flush and exit cleanly, short enough that an unresponsive child
 * does not orphan for long.
 */
const RUN_LOCAL_KILL_GRACE_MS = 3_000; // 3 seconds

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
  /**
   * The agent's DECLARED name (`defineAgent({ name })`) for a project the route
   * has to link on the fly, or null when it cannot be determined. Optional: the
   * route falls back to `sapiom.json`'s cached name, then
   * {@link ActionWorkflow.name}, then the project folder's basename.
   *
   * A seam rather than a direct call so this router keeps knowing nothing about
   * the canvas extraction cache (see core/definition-name.ts, which
   * `server/index.ts` wires in here). Never expected to throw — a rejection is
   * treated as "could not determine".
   */
  resolveDefinitionName?: (workflow: ActionWorkflow) => Promise<string | null>;
  /**
   * Called after the route has linked a previously-unlinked project and cached
   * its new `definitionId`, so the host can refresh whatever it derives from
   * `sapiom.json`. The registry's `list()` never re-reads the file and the
   * workspace watcher ignores a content-only edit, so without this a
   * first-time deploy leaves the SPA showing "Draft" with Prod Run gated.
   *
   * A seam rather than a direct call so this router keeps knowing nothing about
   * the workflow registry (`server/index.ts` wires it). Never expected to
   * throw — a rejection must not cost the user their build.
   */
  onLinked?: (workflow: ActionWorkflow) => Promise<void>;
  /** Injectable core operations. Test seam; defaults to the real exports. */
  coreDeps?: Partial<ActionsCoreDeps>;
  /**
   * Spawn the run-local bootstrap child. Undocumented for prod — a test seam
   * only (defaults to `node`ing the compiled bootstrap), so a test can stream a
   * scripted trace without spawning a real process, mirroring `fetchImpl` in
   * runs.ts and the `spawnProcess` seam in task-manager.ts.
   */
  runLocalSpawn?: RunLocalSpawnFn;
  /**
   * Called after a deploy writes a new `definitionId` to `sapiom.json`, so the
   * server can refresh its workflow cache and broadcast `workflows.changed` to
   * connected clients. The path is the project directory whose `sapiom.json`
   * was updated. Optional — when omitted the cache is refreshed by the
   * client-side `refreshWorkflows()` call that fires after the deploy stream
   * ends, but the server-side broadcast is skipped (so other open clients see
   * the stale id until their next poll).
   */
  onWorkflowConfigChanged?: (workflowPath: string) => void | Promise<void>;
}

/**
 * What a project's `sapiom.json` says about its server-side identity. Three
 * states, not two: an unlinked project is fixable by linking on the spot (the
 * deploy route does exactly that), while an unparseable file is not — and
 * telling them apart matters, because `writeConfig` re-reads the file and
 * throws BAD_CONFIG on invalid JSON. Auto-linking on a broken config would
 * create a remote agent and then fail to record it, orphaning it.
 *
 * `name` on the unlinked state is the cached agent name a previous `link`
 * wrote, if any — the deploy route uses it to name the agent it creates.
 */
type ProjectConfigState =
  | { kind: "linked"; definitionId: string }
  | { kind: "unlinked"; name?: string }
  | { kind: "bad-config" };

function readProjectConfigState(
  readConfig: typeof coreReadConfig,
  projectDir: string,
): ProjectConfigState {
  let config: SapiomConfig | null;
  try {
    config = readConfig(projectDir);
  } catch {
    return { kind: "bad-config" };
  }
  const definitionId = config?.definitionId;
  if (definitionId) return { kind: "linked", definitionId };
  return config?.name ? { kind: "unlinked", name: config.name } : { kind: "unlinked" };
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
 * Whether a thrown value is a definitive "the definition is not accessible
 * under this account" — 404 (not found) or 403/401 (forbidden/unauthorized).
 * These warrant falling back to link-by-name; transient errors (5xx, NETWORK,
 * connection reset) do not — a blip must never silently duplicate an agent.
 *
 * Note: HTTP_401/403 from a definition-verify call mean "this id is not yours"
 * (distinguished from an expired API key because the key was already validated
 * to reach this point). We therefore treat them as definitive ownership failures
 * rather than auth rejections worthy of a refresh retry.
 */
function isDefinitiveOwnershipFailure(err: unknown): boolean {
  return (
    err instanceof AgentOperationError &&
    (err.code === "HTTP_404" ||
      err.code === "HTTP_403" ||
      err.code === "HTTP_401")
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
  const { onWorkflowConfigChanged } = opts;
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
   * A project with no `definitionId` yet is linked on the fly first (a
   * `linking` line precedes `building`) rather than rejected; if the resolved
   * agent's id could not be cached in `sapiom.json`, a non-terminal `warning`
   * line follows before `building` continues.
   *
   * 200  NDJSON stream (even a build failure is a 200 with a terminal `error`
   *      line — the request itself succeeded; the build outcome is in-band).
   * 400  id missing/empty
   * 404  workflow id not registered
   * 409  sapiom.json is unparseable
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

    const configState = readProjectConfigState(deps.readConfig, workflow.path);
    if (configState.kind === "bad-config") {
      res.status(409).json({ error: "sapiom.json is not valid JSON" });
      return;
    }

    // From here the outcome is streamed in-band as NDJSON — status is 200 and
    // headers are committed before the (potentially long) link+build runs.
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const write = (event: DeployStreamEvent): void => {
      res.write(JSON.stringify(event) + "\n");
    };

    /**
     * The definition id to build against: the linked one (verified as
     * accessible under the current key), or a freshly resolved-or-created one
     * when the project has never been linked or when the committed id belongs
     * to a different account (e.g. a GitHub-cloned repo someone else had
     * deployed).
     *
     * For a linked project: first verify ownership via a GET on the definition.
     * If it resolves, return it (redeploy the same definition — precise,
     * rename-safe). If it returns 404/403/401 (definitive not-found/forbidden),
     * fall back to `link({ create: true })` — the exact resolve-or-create-by-
     * name path the unlinked branch uses; the same `linking` stream line is
     * emitted. Transient/5xx/NETWORK errors are NOT caught here — a blip must
     * never silently duplicate an agent.
     *
     * For an unlinked project: `link({ create: true })` matches an existing
     * remote agent by name/slug BEFORE creating one, so this is resync-or-
     * create: re-deploying never duplicates an agent, and a template already
     * deployed from another machine re-attaches to the same definition.
     */
    const ensureDefinitionId = async (): Promise<string> => {
      if (configState.kind === "linked") {
        const { definitionId } = configState;
        // Verify the id is reachable under the current key. A definitive
        // not-found/forbidden (HTTP 404/403/401) means the id belongs to
        // another account; fall through to link-by-name. Any other error
        // (5xx, NETWORK) propagates — a transient blip must not trigger the
        // fork and risk duplicating an agent.
        try {
          await withKeyRefreshRetry(provider, clientFor, (client) =>
            deps.getDefinition(definitionId, client),
          );
          return definitionId;
        } catch (err) {
          if (!isDefinitiveOwnershipFailure(err)) throw err;
          // Fall through to link-by-name (same path as the unlinked branch).
        }
      }

      const fromSeam = opts.resolveDefinitionName
        ? await opts.resolveDefinitionName(workflow).catch(() => null)
        : null;
      // `configState.name` exists only on the "unlinked" variant. A "linked"
      // project reaching here means the id failed ownership verification and we
      // are falling back to link-by-name — treat the cached name as absent for
      // naming purposes (it was the server-side name from the foreign account).
      const cachedName =
        configState.kind === "unlinked" ? configState.name : undefined;
      const name =
        fromSeam?.trim() ||
        cachedName?.trim() ||
        workflow.name?.trim() ||
        basename(workflow.path);

      write({ phase: "linking", name });
      // Same refresh-on-rejected-key recovery the build gets; the retry is
      // transparent to the stream (no second linking line).
      const linked: LinkResult = await withKeyRefreshRetry(
        provider,
        clientFor,
        (client) => deps.link({ name, create: true }, client),
      );
      // Cache under the name the SERVER settled on, matching what
      // `sapiom agents link` writes. writeConfig merges, so the clone's
      // forkId/templateId/repoFullName survive.
      //
      // Best-effort: sapiom.json is a re-resolvable cache (agent-core's
      // config.ts) and `link` re-resolves the same agent by name, so a failed
      // write here (read-only checkout, EACCES, a config that turned invalid
      // between the 409 check above and this write) must not cost the user
      // their deploy — warn and carry on with the id already in hand.
      try {
        deps.writeConfig(workflow.path, {
          definitionId: linked.definitionId,
          name: linked.name,
        });
      } catch (cacheErr) {
        write({
          phase: "warning",
          message:
            `The agent "${linked.name}" was created on Sapiom (${linked.definitionId}) but not recorded locally: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}. The build continues; re-deploying re-resolves it by name.`,
        });
      }
      // Best-effort, same as the cache write above, and run whether or not it
      // succeeded: a rescan is harmless either way, and there is nothing new to
      // re-read when the write failed. Without this, the registry's list()
      // never re-reads sapiom.json and the workspace watcher ignores a
      // content-only edit, so the SPA would keep showing "Draft" after the
      // very first successful deploy of a project.
      if (opts.onLinked) await opts.onLinked(workflow).catch(() => undefined);
      return linked.definitionId;
    };

    // Capture the pre-deploy definitionId (if any) so we can tell whether a
    // successful deploy changed it — the cache-invalidation callback fires only
    // when there is something new for connected clients to pick up.
    const prevDefinitionId = configState.kind === "linked" ? configState.definitionId : undefined;

    try {
      // A link failure throws out of here and is mapped by the same
      // toDeployErrorEvent below — reported as itself, never as a build
      // failure, and `deploy` is never reached.
      const definitionId = await ensureDefinitionId();
      write({ phase: "building", definitionId });
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
      // Only broadcast a config change when the definitionId actually changed —
      // a redeploy of an already-linked workflow with the same id is a no-op
      // for any cache that derives from sapiom.json, so don't wake every
      // connected client unnecessarily.
      if (onWorkflowConfigChanged && result.definitionId !== prevDefinitionId) {
        try {
          await onWorkflowConfigChanged(workflow.path);
        } catch {
          // Non-fatal — the deploy succeeded; the broadcast is best-effort.
        }
      }
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
    // read-to-EOF completes. Guard the write against an EPIPE (child exits
    // before draining stdin) — without an "error" listener the writable stream
    // would emit an unhandled-error event and crash the long-lived server.
    if (child.stdin) {
      child.stdin.on("error", (err: Error) => {
        // EPIPE / ERR_STREAM_DESTROYED — the child is already gone; the exit
        // handler below will settle the response. Swallow so it never becomes
        // an uncaughtException.
        console.error("[run-local] stdin write error (swallowed):", err.message);
      });
      child.stdin.end(JSON.stringify(request));
    }

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
    const settle = (terminalErrorMessage?: string): void => {
      if (settled) return;
      settled = true;
      // Clear lifecycle resources so nothing fires after the response is done.
      clearTimeout(wallClockTimer);
      res.off("close", onClientClose);
      // Only synthesize a terminal line when the child produced none — otherwise
      // the stream already ended well-formed with the bootstrap's own summary.
      if (!sawTerminalLine) {
        res.write(
          JSON.stringify({
            kind: "error",
            outcome: "failed",
            error:
              terminalErrorMessage ||
              stderrTail.trim() ||
              crashReason ||
              "run-local produced no output",
          }) + "\n",
        );
      }
      res.end();
    };

    /**
     * Send SIGTERM to the child, then SIGKILL after the grace period if it has
     * not exited. Safe to call after the child has already exited — kill() on a
     * dead process is a no-op (returns false) and the SIGKILL timer is cleared
     * by the exit handler or settle().
     */
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killChild = (): void => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), RUN_LOCAL_KILL_GRACE_MS);
    };

    // Wall-clock timeout — kill the child and write a terminal error line so
    // the UI shows a clear "timed out" message rather than a hung spinner.
    const wallClockTimer = setTimeout(() => {
      killChild();
      settle("run-local timed out — the workflow exceeded the maximum allowed run duration");
    }, RUN_LOCAL_MAX_DURATION_MS);

    // Client disconnect before the run settled — kill the child so no orphan
    // process is left running after the user navigates away or closes the tab.
    // `res.on("close")` fires when the response is closed; `res.writableEnded`
    // distinguishes a server-initiated close (normal completion, already settled)
    // from a client-initiated close (navigation away, connection drop). Using
    // `res` rather than `req` avoids the false-positive where `req`'s IncomingMessage
    // stream emits "close" once its body has been fully consumed by body-parser.
    const onClientClose = (): void => {
      if (settled || res.writableEnded) return;
      killChild();
      settle();
    };
    res.on("close", onClientClose);

    // Drive the terminal decision off stdout's close (readline "close" fires
    // only after every line has been emitted), so a summary line buffered when
    // `exit` arrives is still forwarded first. If there's no stdout at all, fall
    // back to `exit`/`error` directly.
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", onLine);
      lines.on("close", () => {
        clearTimeout(killTimer);
        settle();
      });
      child.on("error", (err) => {
        crashReason = err.message;
      });
      child.on("exit", (code) => {
        clearTimeout(killTimer);
        crashReason ??= `run-local process exited with code ${code ?? "null"}`;
      });
    } else {
      child.on("error", (err) => {
        clearTimeout(killTimer);
        crashReason = err.message;
        settle();
      });
      child.on("exit", (code) => {
        clearTimeout(killTimer);
        crashReason ??= `run-local process exited with code ${code ?? "null"}`;
        settle();
      });
    }
  });

  return router;
}
